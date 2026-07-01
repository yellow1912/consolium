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
    sort: { type: "string" },
    limit: { type: "string" },
    offset: { type: "string" },
    json: { type: "boolean", default: false },
    // agent subcommand options
    id: { type: "string" },
    wait: { type: "boolean", default: false },
    timeout: { type: "string" },
    name: { type: "string" },
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
    const entries = await new AgentRegistry().sync()
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
        if (e.sessionTitle) {
          console.log(`${"".padEnd(9)}"${truncate(e.sessionTitle, 80)}"`)
        }
      }
    }
  } else if (sub === "group") {
    const { AgentGroups } = await import("./core/agent-monitor/groups")
    const groups = new AgentGroups()
    const groupSub = positionals[2]

    if (!groupSub || groupSub === "list") {
      const all = groups.list()
      if (all.length === 0) {
        console.log("No agent groups defined.")
      } else {
        const header = `${"NAME".padEnd(24)} MEMBERS`
        console.log(header)
        console.log("-".repeat(header.length))
        for (const g of all) {
          console.log(`${g.name.padEnd(24)} ${g.agentIds.join(", ") || "(empty)"}`)
        }
      }
    } else if (groupSub === "create") {
      const name = positionals[3]
      if (!name) {
        console.error("Usage: consilium agents group create <name> [agentId...]")
        process.exit(1)
      }
      const agentIds = positionals.slice(4)
      try {
        const group = groups.create(name, agentIds)
        console.log(`Created group '${group.name}' with ${group.agentIds.length} member(s).`)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    } else if (groupSub === "delete") {
      const name = positionals[3]
      if (!name) {
        console.error("Usage: consilium agents group delete <name>")
        process.exit(1)
      }
      try {
        groups.delete(name)
        console.log(`Deleted group '${name}'.`)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    } else if (groupSub === "add") {
      const name = positionals[3]
      const agentId = positionals[4]
      if (!name || !agentId) {
        console.error("Usage: consilium agents group add <name> <agentId>")
        process.exit(1)
      }
      try {
        const group = groups.addAgent(name, agentId)
        console.log(`Added '${agentId}' to group '${name}'. Members: ${group.agentIds.length}`)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    } else if (groupSub === "remove") {
      const name = positionals[3]
      const agentId = positionals[4]
      if (!name || !agentId) {
        console.error("Usage: consilium agents group remove <name> <agentId>")
        process.exit(1)
      }
      try {
        const group = groups.removeAgent(name, agentId)
        console.log(`Removed '${agentId}' from group '${name}'. Members: ${group.agentIds.length}`)
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    } else if (groupSub === "show") {
      const name = positionals[3]
      if (!name) {
        console.error("Usage: consilium agents group show <name>")
        process.exit(1)
      }
      const group = groups.get(name)
      if (!group) {
        console.error(`Group '${name}' not found.`)
        process.exit(1)
      }
      const entries = new AgentRegistry().sync()
      const statusEmoji: Record<string, string> = { running: "🟢", waiting: "🟡", idle: "⚪", unknown: "❓" }
      console.log(`Group: ${group.name}`)
      console.log(`Created: ${new Date(group.createdAt).toLocaleString()}`)
      console.log(`Updated: ${new Date(group.updatedAt).toLocaleString()}`)
      console.log(`Members (${group.agentIds.length}):`)
      if (group.agentIds.length === 0) {
        console.log("  (empty)")
      } else {
        for (const id of group.agentIds) {
          const entry = entries.find(e => e.name === id)
          const status = entry ? `${statusEmoji[entry.status] ?? "❓"} ${entry.status}` : "  offline"
          console.log(`  ${id.padEnd(24)} ${status}`)
        }
      }
    } else {
      console.error("Usage: consilium agents group <list|create|delete|add|remove|show> [args]")
      process.exit(1)
    }
  } else if (sub === "broadcast") {
    const groupName = positionals[2]
    const message = positionals.slice(3).join(" ")
    if (!groupName || !message) {
      console.error("Usage: consilium agents broadcast <groupName> <message>")
      process.exit(1)
    }
    const { AgentGroups } = await import("./core/agent-monitor/groups")
    const { TtyWriter } = await import("./core/agent-monitor/tty-writer")
    const groups = new AgentGroups()
    const group = groups.get(groupName)
    if (!group) {
      console.error(`Group '${groupName}' not found. Run \`consilium agents group list\` to see groups.`)
      process.exit(1)
    }
    const entries = new AgentRegistry().sync()
    const writer = new TtyWriter()
    let sent = 0
    let failed = 0
    for (const agentId of group.agentIds) {
      const entry = entries.find(e => e.name === agentId)
      if (!entry) {
        console.error(`  [skip] ${agentId}: not found in registry`)
        failed++
        continue
      }
      const location = writer.detectTerminal(entry.pid)
      if (!location) {
        console.error(`  [skip] ${agentId}: no supported terminal detected`)
        failed++
        continue
      }
      try {
        writer.send(location, message)
        console.log(`  [ok] ${agentId} via ${location.type}`)
        sent++
      } catch (e) {
        console.error(`  [fail] ${agentId}: ${e instanceof Error ? e.message : String(e)}`)
        failed++
      }
    }
    console.log(`\nBroadcast complete: ${sent}/${group.agentIds.length} sent${failed > 0 ? `, ${failed} failed` : ""}.`)
  } else {
    console.error(`Usage: consilium agents [list|group|broadcast] [--json]`)
    process.exit(1)
  }
  process.exit(0)
} else if (positionals[0] === "console") {
  const { startConsole } = await import("./cli/render")
  await startConsole()
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
  } else if (sub === "list") {
    const { listKnowledge } = await import("./core/memory/list.js")
    const tags = values.tags ? values.tags.split(",").map(t => t.trim()).filter(Boolean) : undefined
    const scope = values.scope as import("./core/memory/index.js").KnowledgeScope | undefined
    const sort = values.sort as "title" | "created" | "updated" | "scope" | undefined
    const limit = values.limit ? parseInt(values.limit, 10) : undefined
    const offset = values.offset ? parseInt(values.offset, 10) : undefined
    const result = listKnowledge(dbStore.rawSqlite(), { scope, tags, sort, limit, offset })
    if (values.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (result.records.length === 0) {
      console.log("No memory entries found.")
    } else {
      result.records.forEach((r, i) => {
        console.log(`${i + 1}. [${r.scope}] ${r.title}`)
        console.log(`   ${r.content.slice(0, 120)}${r.content.length > 120 ? "..." : ""}`)
        if (r.tags.length > 0) console.log(`   tags: ${r.tags.join(", ")}`)
        console.log()
      })
      if (result.hasMore) console.log(`  ... showing ${result.records.length} of ${result.total}`)
    }
    dbStore.close()
  } else if (sub === "summary") {
    const { getKnowledgeSummary } = await import("./core/memory/summary.js")
    const summary = getKnowledgeSummary(dbStore.rawSqlite())
    if (values.json) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      console.log(`Total: ${summary.total}`)
      if (Object.keys(summary.byScope).length > 0) {
        console.log("By scope:")
        for (const [scope, count] of Object.entries(summary.byScope)) {
          console.log(`  ${scope}: ${count}`)
        }
      }
      if (summary.topTags.length > 0) {
        console.log("Top tags:")
        for (const { tag, count } of summary.topTags) {
          console.log(`  ${tag}: ${count}`)
        }
      }
      const r = summary.recency
      console.log(`Recency: today=${r.today}  week=${r.week}  month=${r.month}  older=${r.older}`)
    }
    dbStore.close()
  } else {
    console.error("Usage: consilium memory <search|store|list|summary> [args]")
    console.error("  search <query> [--tags t1,t2] [--scope s] [--limit n] [--json]")
    console.error("  store <title> --content <content> [--tags t1,t2] [--scope s]")
    console.error("  list [--scope s] [--tags t1,t2] [--sort title|created|updated|scope] [--limit n] [--offset n] [--json]")
    console.error("  summary [--json]")
    process.exit(1)
  }
} else if (positionals[0] === "agent") {
  const sub = positionals[1]
  const { AgentRegistry } = await import("./core/agent-monitor/registry")
  const { TtyWriter } = await import("./core/agent-monitor/tty-writer")

  if (sub === "send") {
    const message = positionals.slice(2).join(" ")
    const agentId = values.id
    if (!agentId) {
      console.error("Usage: consilium agent send <message> --id <name-or-pid> [--wait] [--timeout <ms>] [--json]")
      process.exit(1)
    }
    if (!message) {
      console.error("Usage: consilium agent send <message> --id <name-or-pid> [--wait] [--timeout <ms>] [--json]")
      process.exit(1)
    }

    const entries = await new AgentRegistry().sync()
    const entry = entries.find(e => e.name === agentId || String(e.pid) === agentId)
    if (!entry) {
      console.error(`Agent '${agentId}' not found. Run \`consilium agents list\` to see running agents.`)
      process.exit(1)
    }

    const writer = new TtyWriter()
    const location = writer.detectTerminal(entry.pid)
    if (!location) {
      console.error(`No supported terminal detected for agent '${agentId}' (pid ${entry.pid}).`)
      console.error("Supported terminals: tmux, WezTerm, iTerm2, Terminal.app")
      process.exit(1)
    }

    writer.send(location, message)

    if (values.wait) {
      if (!entry.sessionFilePath) {
        console.error("Warning: no session file path recorded for this agent; cannot wait for reply.")
        process.exit(1)
      }
      const { WaitWatcher } = await import("./core/agent-monitor/wait-watcher")
      const timeoutMs = values.timeout ? parseInt(values.timeout, 10) : 120_000
      const result = await new WaitWatcher().wait(entry.sessionFilePath, { timeoutMs })
      if (values.json) {
        console.log(JSON.stringify({ success: result.success, message: result.message, pid: entry.pid, name: entry.name }))
      } else if (result.timedOut) {
        console.error(`Timed out waiting for reply from '${entry.name}'.`)
        process.exit(1)
      } else if (result.success) {
        console.log(`Reply from ${entry.name}:\n${result.message}`)
      } else {
        console.error("Session file not found or no reply received.")
        process.exit(1)
      }
    } else {
      if (values.json) {
        console.log(JSON.stringify({ success: true, pid: entry.pid, name: entry.name, terminal: location.type }))
      } else {
        console.log(`Sent to ${entry.name} (pid ${entry.pid}) via ${location.type}.`)
      }
    }
    process.exit(0)
  } else if (sub === "start") {
    const agentType = positionals[2]
    if (!agentType) {
      console.error("Usage: consilium agent start <type> [--name <name>]")
      process.exit(1)
    }

    const { AGENT_DEFS } = await import("./core/adapters/defs")
    const knownTypes = new Set(["claude", ...AGENT_DEFS.map(d => d.bin)])
    if (!knownTypes.has(agentType)) {
      console.error(`Unknown agent type '${agentType}'. Known types: ${[...knownTypes].join(", ")}`)
      process.exit(1)
    }

    const tmuxBin = Bun.which("tmux")
    if (!tmuxBin) {
      console.error("agent start requires tmux. Install tmux or start the agent manually.")
      process.exit(1)
    }

    const sessionName = values.name ?? `${agentType}-${Date.now()}`
    const startResult = Bun.spawnSync(["tmux", "new-session", "-d", "-s", sessionName, agentType], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (startResult.exitCode !== 0) {
      const err = new TextDecoder().decode(startResult.stderr).trim()
      console.error(`Failed to start tmux session: ${err}`)
      process.exit(1)
    }

    // Poll up to 5s for the process to appear in ProcessDetector
    const { ProcessDetector } = await import("./core/agent-monitor/process-detector")
    const detector = new ProcessDetector()
    let found = false
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
      const detected = detector.detect()
      if (detected.some(d => d.bin === agentType)) {
        found = true
        break
      }
    }

    const registry = new AgentRegistry()
    await registry.sync()

    if (found) {
      console.log(`Started ${agentType} in tmux session '${sessionName}'.`)
    } else {
      console.log(`Agent started in tmux session '${sessionName}' but not yet detected in process list.`)
    }
    process.exit(0)
  } else if (sub === "open") {
    const agentId = positionals[2]
    if (!agentId) {
      console.error("Usage: consilium agent open <id>")
      process.exit(1)
    }

    const entries = await new AgentRegistry().sync()
    const entry = entries.find(e => e.name === agentId || String(e.pid) === agentId || e.name.startsWith(agentId))
    if (!entry) {
      console.error(`Agent '${agentId}' not found. Run \`consilium agents list\` to see running agents.`)
      process.exit(1)
    }

    const { TerminalFocusManager } = await import("./core/agent-monitor/terminal-focus")
    const focuser = new TerminalFocusManager()
    const success = await focuser.focusAgent(entry)
    if (success) {
      console.log(`Focused ${entry.name} (pid ${entry.pid})`)
    } else {
      console.error(`Could not focus terminal for agent '${entry.name}' (pid ${entry.pid}).`)
      console.error("Supported terminals: tmux, WezTerm, iTerm2, Terminal.app")
      process.exit(1)
    }
    process.exit(0)
  } else {
    console.error("Usage: consilium agent <send|start|open> [args]")
    console.error("  send <message> --id <name-or-pid> [--wait] [--timeout <ms>] [--json]")
    console.error("  start <type> [--name <name>]")
    console.error("  open <id>")
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
