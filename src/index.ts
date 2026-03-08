#!/usr/bin/env bun
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string" },
    router: { type: "string" },
    resume: { type: "string" },
    mcp: { type: "boolean", default: false },
    version: { type: "boolean", short: "v", default: false },
  },
  allowPositionals: true,
})

if (values.version) {
  console.log("consilium v0.1.0")
  process.exit(0)
}

if (values.mcp) {
  const { startMcpServer } = await import("./mcp/server")
  await startMcpServer()
} else {
  const { startCLI } = await import("./cli/index")
  await startCLI({
    mode: values.mode as "council" | "dispatch" | "pipeline" | undefined,
    router: values.router,
    resumeId: values.resume,
  })
}
