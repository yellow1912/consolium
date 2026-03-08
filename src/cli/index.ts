import * as readline from "node:readline"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import type { Message } from "../core/adapters/types"
import { ModelCache } from "../core/models/cache"

type Mode = "council" | "dispatch" | "pipeline"

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
      if (!trimmed) return prompt()

      const slash = parseSlash(trimmed)
      if (slash) {
        await handleSlash(slash, { mode, routerName, registry, sessionMgr, context, modelOverrides, modelCache,
          setMode: (m: Mode) => { mode = m },
          setRouter: (r: string) => { routerName = r },
        })
        return prompt()
      }

      // Save user message
      sessionMgr.addMessage(session.id, "user", null, trimmed)
      context.push({ role: "user", agent: null, content: trimmed })

      const router = registry.get(routerName)
      if (!router) {
        console.error(`[error] Router '${routerName}' not found`)
        return prompt()
      }

      // Wrap adapters to apply overrides
      const adaptersWithOverrides = registry.all().map(a => {
        const overrideModel = modelOverrides.get(a.name)
        if (!overrideModel) return a
        return new Proxy(a, {
          get(target, prop, receiver) {
            if (prop === "query") {
              return (p: string, c: Message[], opts?: any) => 
                target.query(p, c, { ...opts, model: opts?.model ?? overrideModel })
            }
            return Reflect.get(target, prop, receiver)
          }
        })
      })

      const runner = new CouncilRunner({ 
        router, 
        adapters: adaptersWithOverrides.filter(a => a.name !== routerName) 
      })

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
        } else {
          const r = await runner.pipeline(trimmed, context)
          console.log(`\n[executor result]: ${r.taskContent}`)
          r.reviews.forEach(rev =>
            console.log(`\n[${rev.reviewer} review]: ${rev.content} (${rev.verdict})`)
          )
          const approved = r.approved ? "✓ approved" : "✗ changes requested"
          console.log(`\n[pipeline]: ${approved}`)
          sessionMgr.addMessage(session.id, "agent", "pipeline", r.taskContent)
          context.push({ role: "agent", agent: "pipeline", content: r.taskContent })
        }
      } catch (err) {
        console.error(`[error] ${err}`)
      }

      prompt()
    })

  prompt()

  rl.on("close", () => clearInterval(refreshInterval))
}

type SlashCtx = {
  mode: Mode
  routerName: string
  registry: AdapterRegistry
  sessionMgr: SessionManager
  context: Message[]
  modelOverrides: Map<string, string>
  modelCache: ModelCache
  setMode: (m: Mode) => void
  setRouter: (r: string) => void
}

async function handleSlash(slash: { command: string; args: string[] }, ctx: SlashCtx) {
  switch (slash.command) {
    case "mode": {
      const m = slash.args[0]
      if (m === "council" || m === "dispatch" || m === "pipeline") {
        ctx.setMode(m)
        console.log(`mode → ${m}`)
      } else {
        console.log("usage: /mode council|dispatch|pipeline")
      }
      break
    }
    case "router": {
      const r = slash.args[0]
      if (r) { ctx.setRouter(r); console.log(`router → ${r}`) }
      else console.log("usage: /router <agent-name>")
      break
    }
    case "agents":
      console.log("agents:", ctx.registry.all().map(a => a.name).join(", "))
      break
    case "models": {
      for (const a of ctx.registry.all()) {
        const models = await a.getModels()
        console.log(`\n[${a.name}] models:`)
        models.forEach(m => console.log(`  - ${m.id} (${m.name}) [${m.capabilities.join(", ")}]${m.isDefault ? " [default]" : ""}`))
        const override = ctx.modelOverrides.get(a.name)
        if (override) console.log(`  (active override: ${override})`)
      }
      break
    }
    case "model": {
      const [agentName, modelId] = slash.args
      if (agentName && modelId) {
        ctx.modelOverrides.set(agentName, modelId)
        console.log(`override: ${agentName} → ${modelId}`)
      } else {
        console.log("usage: /model <agent-name> <model-id>")
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
        "/mode council|dispatch|pipeline  — switch execution mode",
        "/router <name>                   — switch router agent",
        "/agents                          — list available agents",
        "/models                          — list available models per agent",
        "/model <agent> <id>              — override model for an agent",
        "/sessions                        — list all sessions",
        "/history                         — show session history",
        "/help                            — show this help",
      ].join("\n"))
      break
    default:
      console.log(`unknown command: /${slash.command}`)
  }
}
