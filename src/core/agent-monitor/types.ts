export type AgentStatus = "running" | "waiting" | "idle" | "unknown"

export interface DetectedAgent {
  pid: number
  ppid: number
  tty: string
  command: string
  bin: string          // matched binary basename
  agentType?: "claude" | "codex" | "gemini" | "opencode" | "copilot" | "other"
  cwd?: string         // from lsof enrichment
  startedAt?: string   // ISO from ps lstart
}

export interface AgentRegistryEntry {
  pid: number
  name: string         // user-assigned or auto (bin + pid)
  type: string         // binary basename
  cwd: string
  startedAt: string
  sessionFilePath?: string   // matched JSONL session file
  status: AgentStatus
  lastSeenAt: string
  sessionTitle?: string      // parsed from JSONL first user message
  lastActiveAt?: string      // ISO, from JSONL last event timestamp
  matchConfidence?: "high" | "low"
}
