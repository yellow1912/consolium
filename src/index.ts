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
