import { ProcessDetector } from "./process-detector.js"
import { AgentRegistry } from "./registry.js"

export interface LaunchAgentOptions {
  /** Custom tmux window/session name. Defaults to `${agentType}-${Date.now()}`. */
  name?: string
  /** Working directory for the new pane. Defaults to process.cwd(). */
  cwd?: string
}

export interface LaunchResult {
  ok: boolean
  windowName: string
  location: string  // "window 'X'" | "session 'X'"
  found: boolean    // agent binary appeared in process list after launch
  error?: string
}

/**
 * Launch an agent binary in a new tmux window (if inside tmux) or detached
 * session (if not). Polls up to 5s for the process to appear, then syncs
 * the registry. Both errors are non-fatal: launch success is determined by
 * the tmux exit code alone.
 */
export async function launchAgentInTmux(
  agentType: string,
  opts: LaunchAgentOptions = {},
): Promise<LaunchResult> {
  const windowName = opts.name ?? `${agentType}-${Date.now()}`
  const cwd = opts.cwd ?? process.cwd()
  const insideTmux = Boolean(process.env.TMUX)

  const tmuxCmd = insideTmux
    ? ["tmux", "new-window", "-n", windowName, "-c", cwd, agentType]
    : ["tmux", "new-session", "-d", "-s", windowName, "-c", cwd, agentType]

  const location = insideTmux ? `window '${windowName}'` : `session '${windowName}'`

  let spawn: ReturnType<typeof Bun.spawnSync>
  try {
    spawn = Bun.spawnSync(tmuxCmd, { stdout: "pipe", stderr: "pipe" })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, windowName, location, found: false, error: msg }
  }

  if (spawn.exitCode !== 0) {
    const err = new TextDecoder().decode(spawn.stderr).trim()
    return { ok: false, windowName, location, found: false, error: err }
  }

  // Poll up to 5s — only count processes born after we launched (±3s tolerance)
  const launchedAt = Date.now()
  const detector = new ProcessDetector()
  let found = false
  const deadline = launchedAt + 5_000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    const detected = detector.detect()
    found = detected.some(d => {
      if (d.bin !== agentType) return false
      if (!d.startedAt) return false
      return new Date(d.startedAt).getTime() >= launchedAt - 3_000
    })
    if (found) break
  }

  // Best-effort registry sync — must not abort a successful launch
  try {
    await new AgentRegistry().sync()
  } catch {
    // Ignore: agent launched, registry update is optional
  }

  return { ok: true, windowName, location, found }
}
