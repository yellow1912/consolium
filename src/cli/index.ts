import * as readline from "node:readline"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import type { Message } from "../core/adapters/types"
import { ModelCache } from "../core/models/cache"

type Mode = "council" | "dispatch" | "pipeline" | "debate"

export async function startCLI(options: {
  mode?: Mode
  router?: string
  resumeId?: string
  personas?: boolean
}) {
  const sessionMgr = new SessionManager()
  const registry = options.personas ? buildPersonaRegistry() : buildDefaultRegistry()

  let mode: Mode = options.mode ?? "dispatch"
  let routerName = options.router ?? "claude"
  const modelOverrides = new Map<string, string>()
  let debateMaxRounds = 5
  let debateAutopilot = false

  let session = options.resumeId
    ? (sessionMgr.get(options.resumeId) ?? sessionMgr.create({ mode, router: routerName }))
    : sessionMgr.create({ mode, router: routerName })

  const context: Message[] = sessionMgr.getMessages(session.id)

  const modelCache = new ModelCache()
  await modelCache.load()

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
    })
  }

  let runner = buildRunner()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  console.log(`\nconsilium — session ${session.id}`)
  console.log(`mode: ${mode}  router: ${routerName}`)
  console.log('Type a message or /help for commands.\n')

  const prompt = () =>
    rl.question("you> ", async (input) => {
      const trimmed = input.trim()
      if (!trimmed) return rl.closed || prompt()

      const slash = parseSlash(trimmed)
      if (slash) {
        await handleSlash(slash, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache,
          refreshModels,
          setMode: (m: Mode) => { mode = m },
          setRouter: (r: string) => { routerName = r },
          rebuildRunner: () => { runner = buildRunner() },
          debateMaxRounds,
          debateAutopilot,
          setDebateMaxRounds: (n: number) => { debateMaxRounds = n },
          setDebateAutopilot: (on: boolean) => { debateAutopilot = on },
        })
        return rl.closed || prompt()
      }

      // Save user message
      sessionMgr.addMessage(session.id, "user", null, trimmed)
      context.push({ role: "user", agent: null, content: trimmed })

      try {
        if (mode === "council") {
          const r = await runner.council(trimmed, context)
          r.responses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
          console.log(`\n[synthesis]: ${r.synthesis}`)
          sessionMgr.addMessage(session.id, "agent", "synthesis", r.synthesis)
          context.push({ role: "agent", agent: "synthesis", content: r.synthesis })
        } else if (mode === "dispatch") {
          const r = await runner.dispatch(trimmed, context)
          console.log(`\n[${r.agent}]: ${r.content}`)
          sessionMgr.addMessage(session.id, "agent", r.agent, r.content)
          context.push({ role: "agent", agent: r.agent, content: r.content })
        } else if (mode === "pipeline") {
          const r = await runner.pipeline(trimmed, context)
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
          debateAutopilot = false
          const r = await runner.debate(trimmed, context, {
            maxRounds: debateMaxRounds,
            onRoundComplete: async (roundNum, roundResponses) => {
              roundResponses.forEach(resp => console.log(`\n[${resp.agent}]: ${resp.content}`))
              if (roundResponses.length === 0) {
                console.log(`\nRound ${roundNum}: all agents passed.`)
              }
              if (debateAutopilot) return undefined
              console.log(`\nRound ${roundNum} complete. Press Enter to continue, or type to steer (/done to end, /debate autopilot on to stop asking):`)
              return new Promise<boolean | undefined>(resolve => {
                if (rl.closed) return resolve(undefined)
                const onClose = () => resolve(undefined)
                rl.once("close", onClose)
                rl.question("you> ", input => {
                  rl.removeListener("close", onClose)
                  const t = input.trim()
                  if (t === "/done") return resolve(false)
                  if (t === "/debate autopilot on") { debateAutopilot = true; return resolve(undefined) }
                  if (t) {
                    context.push({ role: "user", agent: null, content: t })
                    sessionMgr.addMessage(session.id, "user", null, t)
                  }
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
  refreshModels: () => Promise<void>
  setMode: (m: Mode) => void
  setRouter: (r: string) => void
  rebuildRunner: () => void
  debateMaxRounds: number
  debateAutopilot: boolean
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
        console.log(`  ${s.id.slice(0, 8)} [${s.mode}] [${s.status}] router:${s.router}`)
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
      ].join("\n"))
      break
    case "debate": {
      const [sub, val] = slash.args
      if (sub === "rounds") {
        const n = parseInt(val, 10)
        if (!n || n < 1) { console.log("usage: /debate rounds <number>"); break }
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
