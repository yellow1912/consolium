#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(raw);
    const sessionId = process.env.CLAUDE_SESSION_ID ?? event.session_id ?? "unknown";
    const toolName = event.tool_name ?? "";
    const toolInput = event.tool_input ?? {};

    const dir = path.join(os.homedir(), ".consilium", "agent-requests");
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `${sessionId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ toolName, toolInput, timestamp: new Date().toISOString() }),
      "utf8"
    );
  } catch {
    // silently ignore parse/write errors to avoid disrupting the hook chain
  }
  process.exit(0);
});
