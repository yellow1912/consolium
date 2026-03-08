#!/usr/bin/env bun
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    router: { type: "string" },
    resume: { type: "string" },
    list: { type: "boolean", short: "l", default: false },
    mcp: { type: "boolean", default: false },
    personas: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
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

if (values.mcp) {
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
