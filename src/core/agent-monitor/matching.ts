import { listSessionFiles } from "./claude-session-parser.js"

export interface MatchResult {
  pid: number
  sessionFilePath: string
  sessionId: string
  confidence: "high" | "low"
}

const DEFAULT_MAX_AGE_MS = 3 * 60 * 1000 // 3 minutes

/**
 * Match running agent processes to Claude Code JSONL session files.
 *
 * Algorithm:
 * 1. For each agent with a cwd, list ~/.claude/projects/<encoded-cwd>/*.jsonl
 * 2. Build candidate pairs where |agent.startedAt - file.mtime| ≤ maxAgeMs
 * 3. Sort candidates by deltaMs ascending (best match first)
 * 4. Greedy 1:1 assignment: once a session file or PID is claimed, skip it
 * 5. Low-confidence fallback: for unmatched agents, claim the most recent
 *    unclaimed file in the same project dir (if any)
 */
export async function matchAgentsToSessions(
  agents: Array<{ pid: number; cwd?: string; startedAt?: string }>,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<MatchResult[]> {
  type Candidate = {
    pid: number
    filePath: string
    sessionId: string
    deltaMs: number
  }

  const candidates: Candidate[] = []
  const claimedFiles = new Set<string>()
  const matchedPids = new Set<number>()

  // Phase 1: build candidates for agents that have both cwd and startedAt
  for (const agent of agents) {
    if (!agent.cwd || !agent.startedAt) continue

    const agentTime = new Date(agent.startedAt).getTime()
    if (isNaN(agentTime)) continue

    const files = listSessionFiles(agent.cwd)
    for (const filePath of files) {
      // Use Bun.file().lastModified (sync property) for mtime
      const mtime = Bun.file(filePath).lastModified
      if (!isFinite(mtime) || mtime <= 0) continue

      const deltaMs = Math.abs(agentTime - mtime)
      if (deltaMs > maxAgeMs) continue

      const sessionId = filePath.split("/").pop()?.replace(/\.jsonl$/, "") ?? ""
      candidates.push({ pid: agent.pid, filePath, sessionId, deltaMs })
    }
  }

  // Sort by smallest delta first (best matches first)
  candidates.sort((a, b) => a.deltaMs - b.deltaMs)

  // Greedy 1:1 assignment → high confidence
  const results: MatchResult[] = []
  for (const c of candidates) {
    if (matchedPids.has(c.pid)) continue
    if (claimedFiles.has(c.filePath)) continue

    matchedPids.add(c.pid)
    claimedFiles.add(c.filePath)
    results.push({
      pid: c.pid,
      sessionFilePath: c.filePath,
      sessionId: c.sessionId,
      confidence: "high",
    })
  }

  // Phase 2: low-confidence fallback for unmatched agents with a cwd
  for (const agent of agents) {
    if (!agent.cwd) continue
    if (matchedPids.has(agent.pid)) continue

    const files = listSessionFiles(agent.cwd)
    for (const filePath of files) {
      if (claimedFiles.has(filePath)) continue
      const sessionId = filePath.split("/").pop()?.replace(/\.jsonl$/, "") ?? ""
      claimedFiles.add(filePath)
      matchedPids.add(agent.pid)
      results.push({
        pid: agent.pid,
        sessionFilePath: filePath,
        sessionId,
        confidence: "low",
      })
      break
    }
  }

  return results
}
