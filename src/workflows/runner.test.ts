import { describe, test, expect } from "bun:test"
import { WorkflowRunner } from "./runner"
import type { WorkflowDef } from "./types"
import type { AdapterRegistry } from "../core/adapters/registry"

function makeRegistry(agents: Record<string, { response: string; stream?: boolean }>): AdapterRegistry {
  const adapters = Object.entries(agents).map(([name, cfg]) => ({
    name,
    query: async (_task: string) => ({ role: "assistant" as const, content: cfg.response, agent: name, durationMs: 0 }),
    queryStream: cfg.stream
      ? async function* (_task: string) {
          for (const char of cfg.response) yield char
        }
      : undefined,
    isAvailable: async () => true,
    getModels: async () => [],
  }))

  return {
    get: (name: string) => adapters.find(a => a.name === name) ?? null,
    all: () => adapters,
  } as unknown as AdapterRegistry
}

const simpleWorkflow: WorkflowDef = {
  name: "simple",
  trust: "autonomous",
  steps: [
    { agent: "claude", task: "Step one: {input}", output: "analysis" },
    { agent: "codex", task: "Step two: {analysis}", output: "result" },
  ],
}

describe("WorkflowRunner", () => {
  test("executes steps sequentially and returns context", async () => {
    const registry = makeRegistry({
      claude: { response: "analysis result" },
      codex: { response: "final result" },
    })
    const runner = new WorkflowRunner(registry, "claude")
    const ctx = await runner.run(simpleWorkflow, "test input")

    expect(ctx.input).toBe("test input")
    expect(ctx.analysis).toBe("analysis result")
    expect(ctx.result).toBe("final result")
  })

  test("interpolates context variables into task", async () => {
    const receivedTasks: string[] = []
    const registry = makeRegistry({
      claude: { response: "step1 output" },
      codex: { response: "step2 output" },
    })
    const origGet = registry.get.bind(registry)
    registry.get = (name: string) => {
      const adapter = origGet(name)
      if (!adapter) return null
      return {
        ...adapter,
        query: async (task: string) => {
          receivedTasks.push(task)
          return { role: "assistant" as const, content: name === "claude" ? "step1 output" : "step2 output", agent: name, durationMs: 0 }
        },
      }
    }

    const runner = new WorkflowRunner(registry, "claude")
    await runner.run(simpleWorkflow, "my input")

    expect(receivedTasks[0]).toBe("Step one: my input")
    expect(receivedTasks[1]).toBe("Step two: step1 output")
  })

  test("calls onStepStart and onStepComplete for each step", async () => {
    const registry = makeRegistry({
      claude: { response: "r1" },
      codex: { response: "r2" },
    })
    const starts: Array<[number, number, string, string]> = []
    const completes: Array<[number, string, string]> = []

    const runner = new WorkflowRunner(registry, "claude")
    await runner.run(simpleWorkflow, "input", {
      onStepStart: (stepNum, total, agent, task) => starts.push([stepNum, total, agent, task]),
      onStepComplete: (stepNum, outputKey, content) => completes.push([stepNum, outputKey, content]),
    })

    expect(starts).toHaveLength(2)
    expect(starts[0]).toEqual([1, 2, "claude", "Step one: input"])
    expect(starts[1]).toEqual([2, 2, "codex", "Step two: r1"])
    expect(completes[0]).toEqual([1, "analysis", "r1"])
    expect(completes[1]).toEqual([2, "result", "r2"])
  })

  test("uses default output key when step.output is not set", async () => {
    const registry = makeRegistry({ claude: { response: "out" } })
    const workflow: WorkflowDef = {
      name: "no-output-key",
      trust: "autonomous",
      steps: [{ agent: "claude", task: "do {input}" }],
    }
    const runner = new WorkflowRunner(registry, "claude")
    const ctx = await runner.run(workflow, "x")
    expect(ctx.step_1_output).toBe("out")
  })

  test("accumulates tokens via onStream for streaming agents", async () => {
    const registry = makeRegistry({
      claude: { response: "hello world", stream: true },
    })
    const workflow: WorkflowDef = {
      name: "stream-test",
      trust: "autonomous",
      steps: [{ agent: "claude", task: "{input}", output: "out" }],
    }
    const tokens: string[] = []
    const runner = new WorkflowRunner(registry, "claude")
    const ctx = await runner.run(workflow, "hi", { onStream: t => tokens.push(t) })

    expect(tokens.join("")).toBe("hello world")
    expect(ctx.out).toBe("hello world")
  })

  test("throws if agent not found", async () => {
    const registry = makeRegistry({ claude: { response: "ok" } })
    const workflow: WorkflowDef = {
      name: "bad-agent",
      trust: "autonomous",
      steps: [{ agent: "nonexistent", task: "task" }],
    }
    const runner = new WorkflowRunner(registry, "claude")
    expect(runner.run(workflow, "input")).rejects.toThrow('Agent "nonexistent" not found')
  })

  test("checkpoint trust: onCheckpoint called between steps, stops on false", async () => {
    const registry = makeRegistry({
      claude: { response: "r1" },
      codex: { response: "r2" },
    })
    const checkpoints: Array<[number, number]> = []
    const workflow: WorkflowDef = { ...simpleWorkflow, trust: "checkpoint" }

    const runner = new WorkflowRunner(registry, "claude")
    const ctx = await runner.run(workflow, "input", {
      onCheckpoint: async (stepNum, total) => {
        checkpoints.push([stepNum, total])
        return false // stop after first step
      },
    })

    expect(checkpoints).toEqual([[1, 2]])
    expect(ctx.analysis).toBe("r1")
    expect(ctx.result).toBeUndefined()
  })

  test("checkpoint trust: continues when onCheckpoint returns true", async () => {
    const registry = makeRegistry({
      claude: { response: "r1" },
      codex: { response: "r2" },
    })
    const workflow: WorkflowDef = { ...simpleWorkflow, trust: "checkpoint" }

    const runner = new WorkflowRunner(registry, "claude")
    const ctx = await runner.run(workflow, "input", {
      onCheckpoint: async () => true,
    })

    expect(ctx.analysis).toBe("r1")
    expect(ctx.result).toBe("r2")
  })

  test("autonomous trust: onCheckpoint never called", async () => {
    const registry = makeRegistry({
      claude: { response: "r1" },
      codex: { response: "r2" },
    })
    let checkpointCalled = false
    const runner = new WorkflowRunner(registry, "claude")
    await runner.run(simpleWorkflow, "input", {
      onCheckpoint: async () => { checkpointCalled = true; return true },
    })

    expect(checkpointCalled).toBe(false)
  })
})
