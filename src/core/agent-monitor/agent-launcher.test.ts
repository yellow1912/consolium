import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { launchAgentInTmux } from "./agent-launcher"

describe("launchAgentInTmux", () => {
  let savedTmux: string | undefined

  beforeEach(() => {
    savedTmux = process.env.TMUX
  })

  afterEach(() => {
    if (savedTmux === undefined) {
      delete process.env.TMUX
    } else {
      process.env.TMUX = savedTmux
    }
  })

  it("returns a well-typed result regardless of whether tmux is installed", async () => {
    delete process.env.TMUX
    const result = await launchAgentInTmux("nonexistent-agent-xyz")
    expect(typeof result.ok).toBe("boolean")
    expect(typeof result.windowName).toBe("string")
    expect(typeof result.location).toBe("string")
    expect(typeof result.found).toBe("boolean")
    if (!result.ok) {
      expect(typeof result.error).toBe("string")
    }
  }, 15_000)

  it("uses opts.name as the windowName even when tmux fails", async () => {
    delete process.env.TMUX
    const result = await launchAgentInTmux("nonexistent-agent-xyz", { name: "my-window" })
    expect(result.windowName).toBe("my-window")
  }, 15_000)

  it("generates unique windowNames on successive calls without a name option", async () => {
    delete process.env.TMUX
    const result1 = await launchAgentInTmux("nonexistent-agent-xyz")
    // Ensure at least 1ms passes so Date.now() differs
    await new Promise(r => setTimeout(r, 2))
    const result2 = await launchAgentInTmux("nonexistent-agent-xyz")

    expect(result1.windowName).toMatch(/^nonexistent-agent-xyz-\d+$/)
    expect(result2.windowName).toMatch(/^nonexistent-agent-xyz-\d+$/)
    expect(result1.windowName).not.toBe(result2.windowName)
  }, 15_000)

  it("sets location containing 'window' when TMUX env var is set and tmux available", async () => {
    const hasTmux = Boolean(Bun.which("tmux"))
    if (!hasTmux) {
      process.env.TMUX = "fake-tmux-session,0,0"
      const result = await launchAgentInTmux("nonexistent-agent-xyz", { name: "test-win" })
      // fell back to Terminal.app or background — location is non-empty
      expect(result.location.length).toBeGreaterThan(0)
      return
    }

    // A literal placeholder like "fake-tmux-session,0,0" can never resolve to
    // a real server, so `tmux new-window` always fails to connect no matter
    // the environment — that was masking this branch behind the "else"
    // fallback above on every machine that had a GUI terminal (Terminal.app
    // on macOS) to fall back to, and failing outright in headless CI, which
    // has neither a GUI nor a resolvable fake session. Stand up a real
    // detached session instead and read back its actual socket path + server
    // pid, which is the same shape tmux itself would set for a real client.
    const outerName = `outer-${Date.now()}`
    const created = Bun.spawnSync(["tmux", "new-session", "-d", "-s", outerName, "-c", "/tmp"])
    expect(created.exitCode).toBe(0)
    try {
      const socketPath = new TextDecoder()
        .decode(Bun.spawnSync(["tmux", "display-message", "-p", "-t", outerName, "#{socket_path}"]).stdout)
        .trim()
      const serverPid = new TextDecoder()
        .decode(Bun.spawnSync(["tmux", "display-message", "-p", "-t", outerName, "#{pid}"]).stdout)
        .trim()
      process.env.TMUX = `${socketPath},${serverPid},0`

      const result = await launchAgentInTmux("nonexistent-agent-xyz", { name: "test-win" })
      expect(result.location).toContain("window")
      expect(result.location).toContain("test-win")
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", outerName])
    }
  }, 15_000)

  it("sets location containing 'session' when TMUX env var is not set and tmux available", async () => {
    const hasTmux = Boolean(Bun.which("tmux"))
    delete process.env.TMUX
    const result = await launchAgentInTmux("nonexistent-agent-xyz", { name: "test-sess" })
    if (hasTmux && result.location.startsWith("tmux")) {
      expect(result.location).toContain("session")
      expect(result.location).toContain("test-sess")
    } else {
      // fell back to Terminal.app or background — location is non-empty
      expect(result.location.length).toBeGreaterThan(0)
    }
  }, 15_000)
})
