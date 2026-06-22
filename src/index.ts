#!/usr/bin/env bun
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    router: { type: "string" },
    resume: { type: "boolean", default: false },
    list: { type: "boolean", short: "l", default: false },
    mcp: { type: "boolean", default: false },
    personas: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
    workflow: { type: "string", short: "w" },
    "mcp-config": { type: "boolean", default: false },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log("consilium v0.1.0")
  process.exit(0)
}

if (values["mcp-config"]) {
  const binPath = Bun.which("consilium") ?? process.argv[1]
  const config = {
    mcpServers: {
      consilium: {
        command: binPath,
        args: ["--mcp"],
        env: {},
      },
    },
  }
  console.log("\nAdd this to your Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):\n")
  console.log(JSON.stringify(config, null, 2))
  console.log("\nOr for Cursor / other MCP clients, use:\n")
  console.log(`  command: ${binPath}`)
  console.log(`  args: ["--mcp"]`)
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
  const { buildAutoRegistrySync } = await import("./core/adapters/registry")

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

  const registry = buildAutoRegistrySync()
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
} else if (values.mode && positionals.length > 0) {
  const VALID_MODES = ["council", "dispatch", "pipeline", "debate"] as const
  type Mode = typeof VALID_MODES[number]
  const mode = values.mode as string
  if (!VALID_MODES.includes(mode as Mode)) {
    console.error(`Unknown mode: "${mode}"\nValid modes: ${VALID_MODES.join(", ")}`)
    process.exit(1)
  }

  const task = positionals.join(" ")
  const { buildAutoRegistrySync } = await import("./core/adapters/registry")
  const { CouncilRunner } = await import("./core/council")

  const registry = buildAutoRegistrySync()
  const routerName = values.router ?? "claude"
  const router = registry.get(routerName)
  if (!router) {
    console.error(`Router "${routerName}" not available. Use --router to specify another agent.`)
    process.exit(1)
  }
  const adapters = registry.all().filter(a => a.name !== routerName)
  const runner = new CouncilRunner({ router, adapters })

  let didStream = false
  const onStream = (token: string) => { didStream = true; process.stdout.write(token) }

  switch (mode as Mode) {
    case "council": {
      const result = await runner.council(task, [], {
        onAgentComplete: r => process.stderr.write(`[${r.agent}] responded\n`),
      })
      console.log(result.synthesis)
      break
    }
    case "dispatch": {
      const result = await runner.dispatch(task, [], {
        onRouted: (agent, model) => process.stderr.write(`→ ${agent}${model ? ` (${model})` : ""}\n`),
        onStream,
      })
      if (didStream) process.stdout.write("\n")
      else console.log(result.content)
      break
    }
    case "pipeline": {
      const result = await runner.pipeline(task, [], {
        onWorkflowPlan: plan => process.stderr.write(`Plan: ${plan.steps.map((s, i) => `[${i + 1}] ${s.agent}`).join(" → ")}\n`),
        onStepStart: (i, total, agent) => process.stderr.write(`Step ${i + 1}/${total}: ${agent}\n`),
        onExecutorStream: onStream,
        maxIterations: 1,
      })
      if (didStream) process.stdout.write("\n")
      else console.log(result.taskContent)
      break
    }
    case "debate": {
      const result = await runner.debate(task, [], {
        onRoundComplete: async (round, responses) => { process.stderr.write(`Round ${round}: ${responses.length} agents\n`) },
      })
      console.log(result.synthesis)
      break
    }
  }
} else {
  const { startInkCLI } = await import("./cli/render")
  let resumeId: string | undefined
  if (values.resume) {
    const { SessionManager } = await import("./core/session/index")
    const mgr = new SessionManager()
    const all = mgr.listAll()
    resumeId = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id
    if (!resumeId) {
      console.error("No sessions found to resume.")
      process.exit(1)
    }
  }
  await startInkCLI({
    mode: values.mode as "council" | "dispatch" | "pipeline" | "debate" | undefined,
    router: values.router,
    resumeId,
    personas: values.personas,
  })
}
