import * as readline from "node:readline"
import { buildCompleter } from "./completer"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import { classifyIntent } from "./intent"
import type { Message } from "../core/adapters/types"
import { ModelCache } from "../core/models/cache"

type Mode = "council" | "dispatch" | "pipeline" | "debate"

function spin(text: string): { stop: () => void; update: (t: string) => void } {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let i = 0
  let current = text
  const interval = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${current}`)
  }, 80)
  return {
    stop: () => {
      clearInterval(interval)
      process.stdout.write(`\r${" ".repeat(current.length + 3)}\r`)
    },
    update: (t: string) => {
      process.stdout.write(`\r${" ".repeat(current.length + 3)}\r`)
      current = t
    },
  }
}

export async function startCLI(options: {
  mode?: Mode
  router?: string
  resumeId?: string
  personas?: boolean
}) {
  const sessionMgr = new SessionManager()
  const registry = options.personas ? buildPersonaRegistry() : buildDefaultRegistry()

  // When resuming, restore saved mode/router unless explicitly overridden
  const resumed = options.resumeId ? sessionMgr.get(options.resumeId) : null
  let mode: Mode = options.mode ?? (resumed?.mode as Mode | undefined) ?? "dispatch"
  let routerName = options.router ?? resumed?.router ?? "claude"
  const modelOverrides = new Map<string, string>()
  let debateMaxRounds = 5
  let debateAutopilot = false
  const setDebateAutopilot = (on: boolean) => { debateAutopilot = on }
  const setDebateMaxRounds = (n: number) => { debateMaxRounds = n }

  let session = resumed ?? sessionMgr.create({ mode, router: routerName })

  const context: Message[] = sessionMgr.getMessages(session.id)

  const modelCache = new ModelCache()
  await modelCache.load()

  const completer = buildCompleter(registry, modelCache)

  const TTL_MS = 24 * 60 * 60 * 1000 // 24h

  async function refreshModels(): Promise<void> {
    await Promise.all(registry.all().map(async adapter => {
      try {
        if (!await adapter.isAvailable()) return
        const models = await adapter.getModels()
        modelCache.set(adapter.name, models.map(m => m.id))
      } catch {
        // keep stale cache if fetch fails
      }
    }))
    await modelCache.save()
  }

  // background refresh if stale
  const anyStale = registry.all().some(a => modelCache.isStale(a.name, TTL_MS))
  if (anyStale) void refreshModels()

  // auto-refresh every 24h
  const refreshInterval = setInterval(() => { void refreshModels() }, TTL_MS)
  refreshInterval.unref() // don't keep process alive just for this

  function buildModelOverrides(): Record<string, string[]> {
    return Object.fromEntries(
      registry.all()
        .filter(a => a.name !== routerName)
        .map(a => {
          const sessionOverride = modelOverrides.get(a.name)
          if (sessionOverride) return [a.name, [sessionOverride]]
          return [a.name, modelCache.get(a.name)]
        })
    )
  }

  function buildRunner(): CouncilRunner {
    const router = registry.get(routerName)!
    return new CouncilRunner({
      router,
      adapters: registry.except(routerName),
      modelOverrides: buildModelOverrides(),
      masterSessionId: session.id,
      sessionStore: sessionMgr,
    })
  }

  let runner = buildRunner()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer,
  })

  const resumedTag = resumed ? " (resumed)" : ""
  console.log(`\nconsilium — session ${session.id}${resumedTag}`)
  console.log(`mode: ${mode}  router: ${routerName}`)
  console.log('Type a message or /help for commands. Use /sessions to list all sessions.\n')

  const prompt = () =>
    rl.question("you> ", async (input) => {
      const trimmed = input.trim()
      if (!trimmed) return rl.closed || prompt()

      const slash = parseSlash(trimmed)
      if (slash) {
        await handleSlash(slash, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache, rl,
          refreshModels,
          setMode: (m: Mode) => { mode = m },
          setRouter: (r: string) => { routerName = r },
          rebuildRunner: () => { runner = buildRunner() },
          setDebateMaxRounds,
          setDebateAutopilot,
        })
        return rl.closed || prompt()
      }

      // Natural language command interpretation
      const classifier = registry.get(routerName)
      if (classifier) {
        const { stop: stopSpin } = spin("thinking...")
        const intent = await classifyIntent(trimmed, classifier, registry)
        stopSpin()
        if (intent.type === "command") {
          await handleSlash({ command: intent.command, args: intent.args }, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache, rl,
            refreshModels,
            setMode: (m: Mode) => { mode = m },
            setRouter: (r: string) => { routerName = r },
            rebuildRunner: () => { runner = buildRunner() },
            setDebateMaxRounds,
            setDebateAutopilot,
          })
          return rl.closed || prompt()
        }
      }

      // Save user message
      sessionMgr.addMessage(session.id, "user", null, trimmed)
      context.push({ role: "user", agent: null, content: trimmed })

      try {
        if (mode === "council") {
          const agents = registry.all().filter(a => a.name !== routerName).map(a => a.name).join(", ")
          const { stop: stopSpin } = spin(`[${agents}] thinking...`)
          const r = await runner.council(trimmed, context)
          stopSpin()
          r.responses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
          console.log(`\n[synthesis]: ${r.synthesis}`)
          sessionMgr.addMessage(session.id, "agent", "synthesis", r.synthesis)
          context.push({ role: "agent", agent: "synthesis", content: r.synthesis })
        } else if (mode === "dispatch") {
          const { stop: stopSpin, update: updateSpin } = spin("routing...")
          const r = await runner.dispatch(trimmed, context, {
            onRouted: (agent) => updateSpin(`[${agent}] thinking...`),
          })
          stopSpin()
          console.log(`\n[${r.agent}]: ${r.content}`)
          sessionMgr.addMessage(session.id, "agent", r.agent, r.content)
          context.push({ role: "agent", agent: r.agent, content: r.content })
        } else if (mode === "pipeline") {
          const { stop: stopSpin, update: updateSpin } = spin("routing...")
          const r = await runner.pipeline(trimmed, context, {
            onRouted: (executor) => updateSpin(`[${executor}] executing...`),
            onReviewing: (reviewers) => updateSpin(`[${reviewers.join(", ")}] reviewing...`),
          })
          stopSpin()
          console.log(`\n[executor result]: ${r.taskContent}`)
          r.reviews.forEach(rev =>
            console.log(`\n[${rev.reviewer} review]: ${rev.content} (${rev.verdict})`)
          )
          const approved = r.approved ? "✓ approved" : "✗ changes requested"
          console.log(`\n[pipeline]: ${approved}`)
          sessionMgr.addMessage(session.id, "agent", "pipeline", r.taskContent)
          context.push({ role: "agent", agent: "pipeline", content: r.taskContent })
        } else {
          // debate mode — reset autopilot for this debate
          setDebateAutopilot(false)
          const debateAgents = registry.all().filter(a => a.name !== routerName).map(a => a.name).join(", ")
          const { stop: stopSpin, update: updateSpin } = spin(`[${debateAgents}] round 1...`)
          const r = await runner.debate(trimmed, context, {
            maxRounds: debateMaxRounds,
            onRoundComplete: async (roundNum, roundResponses) => {
              stopSpin()
              roundResponses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
              if (roundResponses.length === 0) {
                console.log(`\nRound ${roundNum}: all agents passed.`)
              }
              if (debateAutopilot) {
                updateSpin(`[${debateAgents}] round ${roundNum + 1}...`)
                return undefined
              }
              console.log(`\nRound ${roundNum} complete. Press Enter to continue, or type to steer (/done to end, /debate autopilot on to stop asking):`)
              return new Promise<boolean | undefined>(resolve => {
                if (rl.closed) return resolve(undefined)
                const onClose = () => resolve(undefined)
                rl.once("close", onClose)
                rl.question("you> ", input => {
                  rl.removeListener("close", onClose)
                  const t = input.trim()
                  if (t === "/done") return resolve(false)
                  if (t === "/debate autopilot on") { setDebateAutopilot(true); updateSpin(`[${debateAgents}] round ${roundNum + 1}...`); return resolve(undefined) }
                  if (t) {
                    context.push({ role: "user", agent: null, content: t })
                    sessionMgr.addMessage(session.id, "user", null, t)
                  }
                  updateSpin(`[${debateAgents}] round ${roundNum + 1}...`)
                  resolve(undefined)
                })
              })
            },
          })
          const outcome = r.consensusReached
            ? `Consensus reached after ${r.roundCount} rounds`
            : `Debate concluded (max rounds reached after ${r.roundCount} rounds)`
          console.log(`\n[synthesis]: ${r.synthesis}`)
          console.log(`\n[debate]: ${outcome}`)
          sessionMgr.addMessage(session.id, "agent", "synthesis", r.synthesis)
          context.push({ role: "agent", agent: "synthesis", content: r.synthesis })
        }
      } catch (err) {
        console.error(`[error] ${err}`)
      }

      if (!rl.closed) prompt()
    })

  rl.on("close", () => clearInterval(refreshInterval))

  prompt()
}

type SlashCtx = {
  mode: Mode
  routerName: string
  registry: AdapterRegistry
  sessionMgr: SessionManager
  context: Message[]
  modelOverrides: Map<string, string>
  modelCache: ModelCache
  rl: readline.Interface
  refreshModels: () => Promise<void>
  setMode: (m: Mode) => void
  setRouter: (r: string) => void
  rebuildRunner: () => void
  setDebateMaxRounds: (n: number) => void
  setDebateAutopilot: (on: boolean) => void
}

async function handleSlash(slash: { command: string; args: string[] }, ctx: SlashCtx) {
  switch (slash.command) {
    case "mode": {
      const m = slash.args[0]
      if (m === "council" || m === "dispatch" || m === "pipeline" || m === "debate") {
        ctx.setMode(m)
        console.log(`mode → ${m}`)
      } else {
        console.log("usage: /mode council|dispatch|pipeline|debate")
      }
      break
    }
    case "router": {
      const r = slash.args[0]
      if (r) { ctx.setRouter(r); ctx.rebuildRunner(); console.log(`router → ${r}`) }
      else console.log("usage: /router <agent-name>")
      break
    }
    case "agents":
      console.log("agents:", ctx.registry.all().map(a => a.name).join(", "))
      break
    case "models": {
      if (slash.args[0] === "refresh") {
        console.log("Refreshing models...")
        await ctx.refreshModels()
        ctx.registry.all().forEach(a => {
          const models = ctx.modelCache.get(a.name)
          console.log(`  ${a.name}: ${models.length > 0 ? models.join(", ") : "(fetch failed, keeping cache)"}`)
        })
        ctx.rebuildRunner()
      } else {
        ctx.registry.all().forEach(a => {
          const models = ctx.modelCache.get(a.name)
          const fetchedAt = ctx.modelCache.fetchedAt(a.name)
          const age = fetchedAt
            ? `${Math.round((Date.now() - fetchedAt.getTime()) / 3600000)}h ago`
            : "no cache"
          const override = ctx.modelOverrides.get(a.name)
          const overrideStr = override ? ` [override: ${override}]` : ""
          console.log(`  ${a.name} (${age})${overrideStr}: ${models.length > 0 ? models.join(", ") : "(none cached)"}`)
        })
      }
      break
    }
    case "model": {
      const [agentName, modelId] = slash.args
      if (!agentName) {
        console.log("usage: /model <agent> <model-id> | /model <agent> clear")
        break
      }
      const knownAgents = ctx.registry.all().map(a => a.name)
      if (!knownAgents.includes(agentName)) {
        console.log(`unknown agent: ${agentName}. Known agents: ${knownAgents.join(", ")}`)
        break
      }
      if (modelId === "clear") {
        ctx.modelOverrides.delete(agentName)
        ctx.rebuildRunner()
        console.log(`cleared model override for ${agentName}`)
      } else if (modelId) {
        ctx.modelOverrides.set(agentName, modelId)
        ctx.rebuildRunner()
        console.log(`${agentName} → ${modelId} (this session)`)
      } else {
        console.log("usage: /model <agent> <model-id> | /model <agent> clear")
      }
      break
    }
    case "sessions":
      ctx.sessionMgr.listAll().forEach(s =>
        console.log(`  ${s.id}  [${s.mode}] [${s.status}]  router:${s.router}`)
      )
      break
    case "history":
      if (ctx.context.length === 0) { console.log("(no history)"); break }
      ctx.context.forEach(m => console.log(`  [${m.agent ?? m.role}]: ${m.content}`))
      break
    case "help":
      console.log([
        "/mode council|dispatch|pipeline|debate  — switch execution mode",
        "/debate rounds <n>               — set max debate rounds (default: 5)",
        "/debate autopilot on|off         — skip/enable human pause between rounds",
        "/router <name>                   — switch router agent",
        "/agents                          — list available agents",
        "/models                          — list cached models per agent",
        "/models refresh                  — re-fetch models from all agents",
        "/model <agent> <model-id>        — override model for this session",
        "/model <agent> clear             — remove model override",
        "/sessions                        — list all sessions",
        "/history                         — show session history",
        "/help                            — show this help",
        "/exit /quit                      — exit consilium",
      ].join("\n"))
      break
    case "exit":
    case "quit":
      ctx.rl.close()
      process.exit(0)
    case "debate": {
      const [sub, val] = slash.args
      if (sub === "rounds") {
        const n = val ? parseInt(val, 10) : NaN
        if (!Number.isInteger(n) || n < 1) { console.log("usage: /debate rounds <number>"); break }
        ctx.setDebateMaxRounds(n)
        console.log(`debate max rounds → ${n}`)
      } else if (sub === "autopilot") {
        if (val === "on") { ctx.setDebateAutopilot(true); console.log("debate autopilot → on") }
        else if (val === "off") { ctx.setDebateAutopilot(false); console.log("debate autopilot → off") }
        else console.log("usage: /debate autopilot on|off")
      } else {
        console.log("usage: /debate rounds <n> | /debate autopilot on|off")
      }
      break
    }
    default:
      console.log(`unknown command: /${slash.command}`)
  }
}
