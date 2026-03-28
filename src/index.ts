#!/usr/bin/env bun
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    router: { type: "string" },
    resume: { type: "string" },
    list: { type: "boolean", short: "l", default: false },
    mcp: { type: "boolean", default: false },
    personas: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
    workflow: { type: "string", short: "w" },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log("consilium v0.1.0")
  process.exit(0)
}

if (values.list) {
  const { SessionManager } = await import("./core/session/index")
  const mgr = new SessionManager()
  const sessions = mgr.listAll()
  if (sessions.length === 0) {
    console.log("(no sessions)")
  } else {
    sessions.forEach(s => console.log(`  ${s.id}  [${s.mode}] [${s.status}]  router:${s.router}`))
  }
  process.exit(0)
}

if (values.workflow) {
  const { loadWorkflow } = await import("./workflows/loader")
  const { WorkflowRunner } = await import("./workflows/runner")
  const { AdapterRegistry } = await import("./core/adapters/registry")

  const workflow = await loadWorkflow(values.workflow)
  if (!workflow) {
    console.error(`Workflow "${values.workflow}" not found. Run with --list to see sessions, or use /workflow list in the TUI.`)
    process.exit(1)
  }

  const input = positionals.join(" ")
  if (!input) {
    console.error(`Usage: consilium --workflow <name> <input>`)
    process.exit(1)
  }

  const registry = new AdapterRegistry()
  const routerName = values.router ?? "claude"
  const runner = new WorkflowRunner(registry, routerName)

  console.log(`Running workflow: ${workflow.name}`)
  console.log(`Input: ${input}\n`)

  await runner.run(workflow, input, {
    onStepStart: (stepNum, total, agentOrMode, task) => {
      console.log(`\n[${stepNum}/${total}] ${agentOrMode}: ${task.slice(0, 100)}${task.length > 100 ? "..." : ""}`)
    },
    onStepComplete: (stepNum, outputKey, content) => {
      console.log(`\n--- Step ${stepNum} output (${outputKey}) ---`)
      console.log(content)
    },
    onStream: (token) => process.stdout.write(token),
    onCheckpoint: async (stepNum, total) => {
      process.stdout.write(`\nStep ${stepNum}/${total} complete. Continue? [y/n] `)
      const answer = await new Promise<string>(resolve => {
        process.stdin.once("data", chunk => resolve(chunk.toString().trim()))
      })
      return answer.toLowerCase() !== "n"
    },
  })
} else if (values.mcp) {
  const { startMcpServer } = await import("./mcp/server")
  await startMcpServer()
} else {
  const { startInkCLI } = await import("./cli/render")
  await startInkCLI({
    mode: values.mode as "council" | "dispatch" | "pipeline" | "debate" | undefined,
    router: values.router,
    resumeId: values.resume,
    personas: values.personas,
  })
}
