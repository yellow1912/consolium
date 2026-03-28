import type { AdapterRegistry } from "../core/adapters/registry"
import { CouncilRunner } from "../core/council/index"
import type { WorkflowDef } from "./types"

function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => context[key] ?? `{${key}}`)
}

export type WorkflowRunOptions = {
  onStepStart?: (stepNum: number, total: number, agentOrMode: string, task: string) => void
  onStepComplete?: (stepNum: number, outputKey: string, content: string) => void
  onStream?: (token: string) => void
  onCheckpoint?: (stepNum: number, total: number) => Promise<boolean>
}

export class WorkflowRunner {
  constructor(
    private registry: AdapterRegistry,
    private routerName: string,
  ) {}

  async run(
    workflow: WorkflowDef,
    input: string,
    options: WorkflowRunOptions = {},
  ): Promise<Record<string, string>> {
    const context: Record<string, string> = { input }
    const steps = workflow.steps

    for (const [i, step] of steps.entries()) {
      const stepNum = i + 1
      const task = interpolate(step.task, context)
      const outputKey = step.output ?? `step_${stepNum}_output`
      const agentOrMode = step.agent ?? step.mode ?? "dispatch"

      options.onStepStart?.(stepNum, steps.length, agentOrMode, task)

      let content: string

      if (step.agent) {
        // Direct single-agent query with optional streaming
        const adapter = this.registry.get(step.agent)
        if (!adapter) throw new Error(`Agent "${step.agent}" not found in registry`)
        if (options.onStream && adapter.queryStream) {
          let accumulated = ""
          for await (const token of adapter.queryStream(task, [], {})) {
            accumulated += token
            options.onStream(token)
          }
          content = accumulated.trim()
        } else {
          const resp = await adapter.query(task, [], {})
          content = resp.content
        }
      } else {
        // Multi-agent mode via CouncilRunner
        const mode = step.mode ?? "dispatch"
        const router = this.registry.get(this.routerName)
        if (!router) throw new Error(`Router "${this.routerName}" not found`)
        const adapters = this.registry.all().filter(a => a.name !== this.routerName)
        const runner = new CouncilRunner({ router, adapters })

        if (mode === "council") {
          const r = await runner.council(task, [], {
            onAgentStream: options.onStream ? (_, token) => options.onStream!(token) : undefined,
          })
          content = r.synthesis
        } else if (mode === "pipeline") {
          const r = await runner.pipeline(task, [], {
            onExecutorStream: options.onStream,
          })
          content = r.taskContent
        } else if (mode === "debate") {
          const r = await runner.debate(task, [])
          content = r.synthesis
        } else {
          const r = await runner.dispatch(task, [], {
            onStream: options.onStream,
          })
          content = r.content
        }
      }

      context[outputKey] = content
      options.onStepComplete?.(stepNum, outputKey, content)

      // Checkpoint between steps (not after the last step)
      if (workflow.trust === "checkpoint" && stepNum < steps.length && options.onCheckpoint) {
        const cont = await options.onCheckpoint(stepNum, steps.length)
        if (!cont) break
      }
    }

    return context
  }
}
