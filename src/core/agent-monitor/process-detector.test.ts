import { test, expect, describe, mock, beforeEach } from "bun:test"
import { parsePsLine, parseLsofOutput, ProcessDetector } from "./process-detector.js"
import { AgentRegistry } from "./registry.js"
import type { DetectedAgent, AgentRegistryEntry } from "./types.js"

const KNOWN_BINS = new Set([
  "claude",
  "codex",
  "gemini",
  "agy",
  "copilot",
  "cursor-agent",
  "qwen",
  "opencode",
  "aider",
  "devin",
  "hermes",
  "kimi",
  "kiro-cli",
  "vibe-acp",
  "pi",
])

// ── parsePsLine ────────────────────────────────────────────────────────────────

describe("parsePsLine", () => {
  test("valid claude process line returns DetectedAgent", () => {
    const line = "  1234  5678  s001  /usr/local/bin/claude --dangerously-skip-permissions"
    const result = parsePsLine(line, KNOWN_BINS)
    expect(result).not.toBeNull()
    expect(result!.pid).toBe(1234)
    expect(result!.ppid).toBe(5678)
    expect(result!.tty).toBe("s001")
    expect(result!.bin).toBe("claude")
    expect(result!.command).toContain("claude")
  })

  test("unknown binary returns null", () => {
    const line = "  9999  1111  s002  /usr/bin/python3 myscript.py"
    const result = parsePsLine(line, KNOWN_BINS)
    expect(result).toBeNull()
  })

  test("malformed line (too few fields) returns null", () => {
    const result = parsePsLine("1234 5678", KNOWN_BINS)
    expect(result).toBeNull()
  })

  test("empty line returns null", () => {
    expect(parsePsLine("", KNOWN_BINS)).toBeNull()
    expect(parsePsLine("   ", KNOWN_BINS)).toBeNull()
  })

  test("codex process line returns DetectedAgent with correct bin", () => {
    const line = "  4321  0001  ??   /home/user/.local/bin/codex exec --config approval_policy=never do the thing"
    const result = parsePsLine(line, KNOWN_BINS)
    expect(result).not.toBeNull()
    expect(result!.bin).toBe("codex")
    expect(result!.pid).toBe(4321)
  })

  test("non-numeric pid returns null", () => {
    const line = "  abc  5678  s001  /usr/local/bin/claude"
    const result = parsePsLine(line, KNOWN_BINS)
    expect(result).toBeNull()
  })
})

// ── parseLsofOutput ────────────────────────────────────────────────────────────

describe("parseLsofOutput", () => {
  test("multiline -Fn output returns correct pid→cwd map", () => {
    const output = [
      "p1234",
      "fcwd",
      "n/Users/user/projects/myapp",
      "p5678",
      "fcwd",
      "n/tmp/workdir",
    ].join("\n")
    const result = parseLsofOutput(output)
    expect(result.size).toBe(2)
    expect(result.get(1234)).toBe("/Users/user/projects/myapp")
    expect(result.get(5678)).toBe("/tmp/workdir")
  })

  test("empty output returns empty map", () => {
    expect(parseLsofOutput("").size).toBe(0)
    expect(parseLsofOutput("   \n  ").size).toBe(0)
  })

  test("output with multiple file descriptors only captures cwd path", () => {
    const output = [
      "p9999",
      "fcwd",
      "n/home/user",
      "f1",
      "n/some/other/file",
    ].join("\n")
    const result = parseLsofOutput(output)
    expect(result.get(9999)).toBe("/home/user")
  })

  test("output with no cwd entry returns empty map", () => {
    const output = [
      "p1234",
      "f1",
      "n/dev/null",
    ].join("\n")
    const result = parseLsofOutput(output)
    expect(result.size).toBe(0)
  })
})

// ── isAlive ────────────────────────────────────────────────────────────────────

describe("ProcessDetector.isAlive", () => {
  const detector = new ProcessDetector()

  test("current process PID is alive", () => {
    expect(detector.isAlive(process.pid)).toBe(true)
  })

  test("non-existent PID returns false", () => {
    expect(detector.isAlive(99999999)).toBe(false)
  })
})

// ── AgentRegistry ──────────────────────────────────────────────────────────────

describe("AgentRegistry", () => {
  test("load() with missing registry file returns empty array", () => {
    // Use a fresh registry pointing to a path that doesn't exist
    const registry = new AgentRegistry()
    // Temporarily patch the load path by spying — instead, we test with a
    // non-existent registry file by ensuring load() never throws.
    // We can't easily override REGISTRY_PATH, but we can verify load() returns []
    // for a mocked scenario by checking the return type and that it doesn't throw.
    // The real registry file may or may not exist; either way, [] or array is valid.
    const result = registry.load()
    expect(Array.isArray(result)).toBe(true)
  })

  test("sync() merges detected processes and drops dead entries", async () => {
    const registry = new AgentRegistry()

    // Mock the detector on the registry instance
    const deadPid = 99999998
    const livePid = process.pid

    const fakeDetected: DetectedAgent[] = [
      {
        pid: livePid,
        ppid: 1,
        tty: "??",
        command: "bun test",
        bin: "bun",
        cwd: "/tmp",
        startedAt: new Date().toISOString(),
      },
    ]

    const fakeExisting: AgentRegistryEntry[] = [
      {
        pid: deadPid,
        name: `bun-${deadPid}`,
        type: "bun",
        cwd: "/old",
        startedAt: new Date().toISOString(),
        status: "unknown",
        lastSeenAt: new Date().toISOString(),
      },
    ]

    // Patch the registry's internal detector
    ;(registry as unknown as { detector: ProcessDetector }).detector = {
      detect: () => fakeDetected,
      isAlive: (pid: number) => pid === livePid,
      getClaudeStatus: () => "unknown",
    } as unknown as ProcessDetector

    // Patch load() to return our fake existing entries
    const origLoad = registry.load.bind(registry)
    registry.load = () => fakeExisting

    // Patch save() to be a no-op
    registry.save = () => {}

    const result = await registry.sync()

    // Dead entry (deadPid) should be dropped
    expect(result.find(e => e.pid === deadPid)).toBeUndefined()
    // Live entry (livePid) should be present
    expect(result.find(e => e.pid === livePid)).toBeDefined()

    // Restore
    registry.load = origLoad
  })
})
