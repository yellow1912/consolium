import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import type { DetectedAgent, AgentStatus } from "./types.js"
import { AGENT_DEFS } from "../adapters/defs.js"

// All known binary basenames to watch for
const KNOWN_BINS = new Set([
  "claude",
  ...AGENT_DEFS.map(d => d.bin),
])

/**
 * Derive the agent type from the binary name and full command string.
 * Gemini CLI runs as a Node.js wrapper — if bin is "node" and the command
 * line references "gemini", we classify it as a Gemini agent.
 */
function deriveAgentType(bin: string, command: string): DetectedAgent["agentType"] {
  if (bin === "claude") return "claude"
  if (bin === "codex" || bin.includes("codex")) return "codex"
  if (bin === "gemini" || bin.includes("gemini")) return "gemini"
  if (bin === "node" && /gemini/i.test(command)) return "gemini"
  if (bin === "opencode" || bin.includes("open-code")) return "opencode"
  if (bin === "copilot" || bin.includes("copilot")) return "copilot"
  return "other"
}

/**
 * Parse a single line from `ps -axo pid=,ppid=,tty=,command=` output.
 * Returns a DetectedAgent if the first token's basename is in knownBins,
 * or if it is a Node.js process wrapping the Gemini CLI.
 */
export function parsePsLine(line: string, knownBins: Set<string>): DetectedAgent | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Split on whitespace: pid ppid tty ...rest(command)
  const parts = trimmed.split(/\s+/)
  if (parts.length < 4) return null

  const pid = parseInt(parts[0], 10)
  const ppid = parseInt(parts[1], 10)
  const tty = parts[2]
  const command = parts.slice(3).join(" ")

  if (isNaN(pid) || isNaN(ppid)) return null

  // The first token of the command is the executable path
  const commandParts = command.split(/\s+/)
  const execPath = commandParts[0]
  const bin = basename(execPath)

  // Accept known bins, plus node processes that are wrapping Gemini CLI
  const isGeminiNodeWrapper = bin === "node" && /gemini/i.test(command)
  if (!knownBins.has(bin) && !isGeminiNodeWrapper) return null

  return { pid, ppid, tty, command, bin, agentType: deriveAgentType(bin, command) }
}

/**
 * Parse the output of `lsof -a -d cwd -Fn -p PID1,PID2,...`.
 * Returns a Map from pid to cwd path.
 * The -Fn format produces lines like:
 *   pPID
 *   fcwd
 *   nPATH
 */
export function parseLsofOutput(output: string): Map<number, string> {
  const result = new Map<number, string>()
  if (!output.trim()) return result

  const lines = output.split("\n")
  let currentPid: number | null = null
  let sawCwd = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("p")) {
      const pid = parseInt(trimmed.slice(1), 10)
      currentPid = isNaN(pid) ? null : pid
      sawCwd = false
    } else if (trimmed === "fcwd") {
      sawCwd = true
    } else if (trimmed.startsWith("n") && sawCwd && currentPid !== null) {
      result.set(currentPid, trimmed.slice(1))
      sawCwd = false
    }
  }

  return result
}

export class ProcessDetector {
  detect(): DetectedAgent[] {
    try {
      // 1. Run ps to find agent processes
      const psResult = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,tty=,command="], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (psResult.exitCode !== 0) return []

      const psOutput = new TextDecoder().decode(psResult.stdout)
      const detected: DetectedAgent[] = []

      for (const line of psOutput.split("\n")) {
        const agent = parsePsLine(line, KNOWN_BINS)
        if (agent) detected.push(agent)
      }

      if (detected.length === 0) return []

      // 2. Enrich with CWD via lsof
      const pids = detected.map(d => d.pid).join(",")
      try {
        const lsofResult = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-Fn", "-p", pids], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (lsofResult.exitCode === 0 || lsofResult.exitCode === 1) {
          // lsof returns exit 1 if some pids have no cwd entries, but may still have valid output
          const lsofOutput = new TextDecoder().decode(lsofResult.stdout)
          const cwdMap = parseLsofOutput(lsofOutput)
          for (const agent of detected) {
            const cwd = cwdMap.get(agent.pid)
            if (cwd) agent.cwd = cwd
          }
        }
      } catch {
        // lsof unavailable — continue without cwd enrichment
      }

      // 3. Enrich with startedAt via a single batched ps lstart call
      try {
        const pidList = detected.map(d => d.pid).join(",")
        const lstartResult = Bun.spawnSync(["ps", "-o", "pid=,lstart=", "-p", pidList], {
          stdout: "pipe",
          stderr: "pipe",
        })
        if (lstartResult.exitCode === 0 || lstartResult.exitCode === 1) {
          // ps exits 1 when some PIDs are missing but still emits valid rows
          const lstartOutput = new TextDecoder().decode(lstartResult.stdout)
          const pidLstartMap = new Map<number, string>()
          for (const line of lstartOutput.split("\n")) {
            const match = line.match(/^\s*(\d+)\s+(.+)$/)
            if (!match) continue
            const pid = parseInt(match[1], 10)
            const lstart = match[2].trim()
            if (!isNaN(pid) && lstart) pidLstartMap.set(pid, lstart)
          }
          for (const agent of detected) {
            const lstart = pidLstartMap.get(agent.pid)
            if (lstart) {
              try {
                const parsed = new Date(lstart)
                if (!isNaN(parsed.getTime())) agent.startedAt = parsed.toISOString()
              } catch {
                // invalid date — leave startedAt undefined
              }
            }
          }
        }
      } catch {
        // ps lstart unavailable — leave startedAt undefined
      }

      return detected
    } catch {
      // ps unavailable — degrade gracefully
      return []
    }
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)  // signal 0 = liveness probe only
      return true
    } catch {
      return false
    }
  }

  getClaudeStatus(pid: number): AgentStatus {
    // Try ~/.claude/sessions/<pid>.json → read "status" field
    const sessionFile = join(homedir(), ".claude", "sessions", `${pid}.json`)
    if (!existsSync(sessionFile)) return "unknown"
    try {
      const data = JSON.parse(readFileSync(sessionFile, "utf8"))
      const status = data?.status
      if (status === "running") return "running"
      if (status === "waiting") return "waiting"
      // Check last activity time
      const lastActivity = data?.lastActivity ?? data?.updated_at ?? data?.updatedAt
      if (lastActivity) {
        const diffMs = Date.now() - new Date(lastActivity).getTime()
        if (diffMs > 5 * 60 * 1000) return "idle"
      }
      return "waiting"
    } catch {
      return "unknown"
    }
  }
}
