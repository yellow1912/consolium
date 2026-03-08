import * as readline from "node:readline"
import { SessionManager } from "../core/session/index"
import { CouncilRunner } from "../core/council/index"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry"
import { parseSlash } from "./slash"
import type { Message } from "../core/adapters/types"

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

  let session = options.resumeId
    ? (sessionMgr.get(options.resumeId) ?? sessionMgr.create({ mode, router: routerName }))
    : sessionMgr.create({ mode, router: routerName })

  const context: Message[] = sessionMgr.getMessages(session.id)

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
        handleSlash(slash, { mode, routerName, registry, sessionMgr, context,
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

      const runner = new CouncilRunner({ router, adapters: registry.except(routerName) })

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
}

type SlashCtx = {
  mode: Mode
  routerName: string
  registry: AdapterRegistry
  sessionMgr: SessionManager
  context: Message[]
  setMode: (m: Mode) => void
  setRouter: (r: string) => void
}

function handleSlash(slash: { command: string; args: string[] }, ctx: SlashCtx) {
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
        "/sessions                        — list all sessions",
        "/history                         — show session history",
        "/help                            — show this help",
      ].join("\n"))
      break
    default:
      console.log(`unknown command: /${slash.command}`)
  }
}
