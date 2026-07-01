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
    // memory subcommand options
    content: { type: "string" },
    tags: { type: "string" },
    scope: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean", default: false },
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
} else if (positionals[0] === "agents") {
  const sub = positionals[1]
  const { AgentRegistry } = await import("./core/agent-monitor/registry")

  if (!sub || sub === "list") {
    const entries = new AgentRegistry().sync()
    if (values.json) {
      console.log(JSON.stringify(entries, null, 2))
    } else if (entries.length === 0) {
      console.log("No agent processes detected.")
    } else {
      const statusEmoji: Record<string, string> = {
        running: "🟢",
        waiting: "🟡",
        idle: "⚪",
        unknown: "❓",
      }
      const truncate = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s
      const header = `${"PID".padEnd(8)} ${"NAME".padEnd(24)} ${"TYPE".padEnd(14)} ${"STATUS".padEnd(12)} ${"CWD".padEnd(41)} LAST SEEN`
      console.log(header)
      console.log("-".repeat(header.length))
      for (const e of entries) {
        const emoji = statusEmoji[e.status] ?? "❓"
        const status = `${emoji} ${e.status}`.padEnd(12)
        const lastSeen = new Date(e.lastSeenAt).toLocaleTimeString()
        console.log(
          `${String(e.pid).padEnd(8)} ${e.name.padEnd(24)} ${e.type.padEnd(14)} ${status} ${truncate(e.cwd, 41).padEnd(41)} ${lastSeen}`
        )
      }
    }
  } else {
    console.error(`Usage: consilium agents [list] [--json]`)
    process.exit(1)
  }
  process.exit(0)
} else if (positionals[0] === "memory") {
  const sub = positionals[1]
  const { DbStore } = await import("./core/db/index")
  const { MemoryStore } = await import("./core/memory/index")
  const dbPath = `${process.env.HOME}/.consilium/consilium.db`
  const dbStore = new DbStore(dbPath)
  const memStore = new MemoryStore(dbStore)

  if (sub === "search") {
    const query = positionals.slice(2).join(" ")
    if (!query) {
      console.error("Usage: consilium memory search <query> [--tags t1,t2] [--scope s] [--limit n] [--json]")
      process.exit(1)
    }
    const tags = values.tags ? values.tags.split(",").map(t => t.trim()).filter(Boolean) : undefined
    const scope = values.scope as Parameters<typeof memStore.searchKnowledge>[0]["scope"]
    const limit = values.limit ? parseInt(values.limit, 10) : 10
    const results = memStore.searchKnowledge({ query, tags, scope, limit })
    if (values.json) {
      console.log(JSON.stringify(results, null, 2))
    } else if (results.length === 0) {
      console.log("No results found.")
    } else {
      results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.scope}] ${r.title}`)
        console.log(`   ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`)
        if (r.tags.length > 0) console.log(`   tags: ${r.tags.join(", ")}`)
        console.log()
      })
    }
    dbStore.close()
  } else if (sub === "store") {
    const title = positionals.slice(2).join(" ")
    if (!title) {
      console.error("Usage: consilium memory store <title> --content <content> [--tags t1,t2] [--scope s]")
      process.exit(1)
    }
    if (!values.content) {
      console.error("Error: --content is required for memory store")
      process.exit(1)
    }
    const tags = values.tags ? values.tags.split(",").map(t => t.trim()).filter(Boolean) : []
    const scope = values.scope as Parameters<typeof memStore.storeKnowledge>[0]["scope"]
    const record = memStore.storeKnowledge({ title, content: values.content, tags, scope })
    if (values.json) {
      console.log(JSON.stringify(record, null, 2))
    } else {
      console.log(`Stored: "${record.title}" (id: ${record.id})`)
    }
    dbStore.close()
  } else {
    console.error("Usage: consilium memory <search|store> [args]")
    console.error("  search <query> [--tags t1,t2] [--scope s] [--limit n] [--json]")
    console.error("  store <title> --content <content> [--tags t1,t2] [--scope s]")
    process.exit(1)
  }
} else if (positionals.length > 0 || values.mode === "review") {
  const VALID_MODES = ["council", "dispatch", "pipeline", "debate", "review"] as const
  type Mode = typeof VALID_MODES[number]

  const task = positionals.join(" ")
  const { buildAutoRegistrySync } = await import("./core/adapters/registry")
  const { CouncilRunner } = await import("./core/council")
  const { extractJson } = await import("./core/council/router-utils")

  const registry = buildAutoRegistrySync()
  const routerName = values.router ?? "claude"
  const router = registry.get(routerName)
  if (!router) {
    console.error(`Router "${routerName}" not available. Use --router to specify another agent.`)
    process.exit(1)
  }
  const adapters = registry.all().filter(a => a.name !== routerName)
  const runner = new CouncilRunner({ router, adapters })

  let mode: Mode
  if (values.mode) {
    if (!VALID_MODES.includes(values.mode as Mode)) {
      console.error(`Unknown mode: "${values.mode}"\nValid modes: ${VALID_MODES.join(", ")}`)
      process.exit(1)
    }
    mode = values.mode as Mode
  } else {
    const modeResp = await router.query(
      `Task: "${task}"\n\nChoose the best execution mode:\n- council: parallel broadcast to all agents + synthesis. Use for open questions, brainstorming, diverse perspectives.\n- dispatch: route to single best agent. Use for focused, single-domain tasks.\n- pipeline: multi-step workflow with agent handoffs. Use for complex tasks needing research → writing → review.\n- debate: agents argue multiple rounds to consensus. Use for decisions, tradeoffs, controversial topics.\n- review: parallel angle-based code review (bugs, security, perf, maintainability). Use when given a file path or code to review.\n\nRespond with JSON only: { "mode": "council" | "dispatch" | "pipeline" | "debate" | "review", "reason": "<one sentence>" }`,
      [],
    )
    try {
      const parsed = extractJson(modeResp.content)
      if (!VALID_MODES.includes(parsed.mode)) throw new Error(`invalid mode: ${parsed.mode}`)
      mode = parsed.mode as Mode
      process.stderr.write(`Mode: ${mode} — ${parsed.reason}\n`)
    } catch {
      mode = "dispatch"
      process.stderr.write(`Mode: dispatch (auto-select failed, defaulting)\n`)
    }
  }

  let didStream = false
  const onStream = (token: string) => { didStream = true; process.stdout.write(token) }

  switch (mode) {
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
    case "review": {
      let content: string
      let source: string
      if (task) {
        const file = Bun.file(task)
        if (!(await file.exists())) {
          console.error(`File not found: ${task}`)
          process.exit(1)
        }
        content = await file.text()
        source = task
      } else {
        const diff = await Bun.$`git diff HEAD`.quiet().text().catch(() => "")
        const staged = diff.trim() ? diff : await Bun.$`git diff --cached`.quiet().text().catch(() => "")
        content = staged.trim()
        if (!content) {
          console.error("Nothing to review. Pass a file path or stage/modify files.")
          process.exit(1)
        }
        source = "git diff"
      }
      process.stderr.write(`Reviewing: ${source}\n`)
      const result = await runner.review(content, [], {
        onAngleComplete: f => process.stderr.write(`[${f.angle}] reviewed by ${f.reviewer}\n`),
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
