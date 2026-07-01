import { test, expect, describe } from "bun:test"
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TtyWriter } from "./tty-writer.js"
import { WaitWatcher } from "./wait-watcher.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const okResult = (stdout = "") => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(stdout),
  stderr: new TextEncoder().encode(""),
})

const failResult = () => ({
  exitCode: 1,
  stdout: new TextEncoder().encode(""),
  stderr: new TextEncoder().encode("error"),
})

// ── detectTerminal fallback when tmux env absent ─────────────────────────────

describe("TtyWriter.detectTerminal", () => {
  test("falls back past tmux when env absent and binary missing", () => {
    const writer = new TtyWriter({
      env: {},                        // no TMUX, no WEZTERM_PANE, no ITERM_SESSION_ID
      which: () => null,              // no binaries found
      osPlatform: () => "linux",     // non-darwin: skip iTerm2 + Terminal
      spawnSync: () => failResult(),  // all spawns fail
    })
    const result = writer.detectTerminal(12345)
    expect(result).toBeNull()
  })

  test("returns tmux location when TMUX env set and pane matches", () => {
    const calls: string[][] = []
    const writer = new TtyWriter({
      env: { TMUX: "/tmp/tmux-1234/default,12345,0" },
      which: () => null,
      osPlatform: () => "linux",
      spawnSync: (args, _input) => {
        calls.push(args)
        if (args[0] === "ps") {
          // return TTY "s001" for ps -o tty= -p <pid>
          return okResult("s001\n")
        }
        if (args[0] === "tmux") {
          // return a pane line matching tty s001
          return okResult("/dev/s001|mysession:0.0\n")
        }
        return failResult()
      },
    })
    const result = writer.detectTerminal(99)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("tmux")
    expect(result!.identifier).toBe("mysession:0.0")
  })

  test("returns iterm2 location when ITERM_SESSION_ID present on darwin", () => {
    const writer = new TtyWriter({
      env: { ITERM_SESSION_ID: "w0t0p0:ABC-123" },
      which: () => null,
      osPlatform: () => "darwin",
      spawnSync: () => failResult(),  // tmux/wezterm detection fails
    })
    const result = writer.detectTerminal(99)
    expect(result).not.toBeNull()
    expect(result!.type).toBe("iterm2")
    expect(result!.identifier).toBe("w0t0p0:ABC-123")
  })

  test("skips iTerm2 detection on non-darwin platforms", () => {
    const writer = new TtyWriter({
      env: { ITERM_SESSION_ID: "w0t0p0:ABC-123" },
      which: () => null,
      osPlatform: () => "linux",
      spawnSync: () => failResult(),
    })
    const result = writer.detectTerminal(99)
    expect(result).toBeNull()
  })
})

// ── tmux send command sequence ───────────────────────────────────────────────

describe("TtyWriter tmux send sequence", () => {
  test("issues load-buffer, paste-buffer, send-keys in correct order with correct args", () => {
    const calls: { args: string[]; input?: string }[] = []

    const writer = new TtyWriter({
      spawnSync: (args, input) => {
        calls.push({ args: [...args], input: input ? new TextDecoder().decode(input) : undefined })
        return okResult()
      },
    })

    writer.send({ type: "tmux", identifier: "mysession:1.0" }, "hello world")

    expect(calls.length).toBe(3)

    // Step 1: load-buffer with message as stdin
    expect(calls[0].args).toEqual(["tmux", "load-buffer", "-b", "consilium-send", "-"])
    expect(calls[0].input).toBe("hello world")

    // Step 2: paste-buffer to target
    expect(calls[1].args).toEqual([
      "tmux", "paste-buffer", "-t", "mysession:1.0", "-p", "-d", "-b", "consilium-send",
    ])

    // Step 3: send-keys Enter
    expect(calls[2].args).toEqual(["tmux", "send-keys", "-t", "mysession:1.0", "Enter"])
  })

  test("throws when load-buffer fails", () => {
    const writer = new TtyWriter({
      spawnSync: () => failResult(),
    })
    expect(() => writer.send({ type: "tmux", identifier: "s:0.0" }, "msg")).toThrow("tmux load-buffer failed")
  })
})

// ── WezTerm send command sequence ────────────────────────────────────────────

describe("TtyWriter wezterm send sequence", () => {
  test("issues send-text with message then send-text with CR for Enter", () => {
    const calls: { args: string[]; input?: string }[] = []

    const writer = new TtyWriter({
      spawnSync: (args, input) => {
        calls.push({ args: [...args], input: input ? new TextDecoder().decode(input) : undefined })
        return okResult()
      },
    })

    writer.send({ type: "wezterm", identifier: "42" }, "test message")

    expect(calls.length).toBe(2)

    // Step 1: send the message text
    expect(calls[0].args).toEqual(["wezterm", "cli", "send-text", "--pane-id", "42"])
    expect(calls[0].input).toBe("test message")

    // Step 2: send CR for Enter
    expect(calls[1].args).toEqual(["wezterm", "cli", "send-text", "--pane-id", "42", "--no-paste"])
    expect(calls[1].input).toBe("\r")
  })

  test("throws when wezterm send-text fails", () => {
    const writer = new TtyWriter({
      spawnSync: () => failResult(),
    })
    expect(() => writer.send({ type: "wezterm", identifier: "5" }, "msg")).toThrow("wezterm send-text failed")
  })
})

// ── Non-darwin platform guards ───────────────────────────────────────────────

describe("TtyWriter platform guards", () => {
  test("iTerm2 send throws on non-darwin", () => {
    const writer = new TtyWriter({
      osPlatform: () => "linux",
      spawnSync: () => okResult(),
    })
    expect(() => writer.send({ type: "iterm2", identifier: "sess123" }, "hi")).toThrow(
      "iTerm2/Terminal.app delivery requires macOS",
    )
  })

  test("Terminal.app send throws on non-darwin", () => {
    const writer = new TtyWriter({
      osPlatform: () => "win32",
      spawnSync: () => okResult(),
    })
    expect(() => writer.send({ type: "terminal", identifier: "s001" }, "hi")).toThrow(
      "iTerm2/Terminal.app delivery requires macOS",
    )
  })
})

// ── WaitWatcher.countAssistantMessages ───────────────────────────────────────

describe("WaitWatcher.countAssistantMessages", () => {
  const tmpFile = join(tmpdir(), `consilium-test-${Date.now()}.jsonl`)

  test("counts format-1 (type: assistant) messages", () => {
    const lines = [
      JSON.stringify({ type: "human", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "follow-up" }] } }),
    ].join("\n")
    writeFileSync(tmpFile, lines)

    const watcher = new WaitWatcher()
    expect(watcher.countAssistantMessages(tmpFile)).toBe(2)
    unlinkSync(tmpFile)
  })

  test("counts format-2 (role: assistant) messages", () => {
    const lines = [
      JSON.stringify({ role: "user", content: "question" }),
      JSON.stringify({ role: "assistant", content: "answer 1" }),
      JSON.stringify({ role: "assistant", content: "answer 2" }),
      JSON.stringify({ role: "user", content: "follow-up" }),
    ].join("\n")
    writeFileSync(tmpFile, lines)

    const watcher = new WaitWatcher()
    expect(watcher.countAssistantMessages(tmpFile)).toBe(2)
    unlinkSync(tmpFile)
  })

  test("handles mixed formats and malformed lines gracefully", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "a" } }),
      "NOT_JSON_AT_ALL",
      JSON.stringify({ role: "assistant", content: "b" }),
      "",
      "  ",
    ].join("\n")
    writeFileSync(tmpFile, lines)

    const watcher = new WaitWatcher()
    expect(watcher.countAssistantMessages(tmpFile)).toBe(2)
    unlinkSync(tmpFile)
  })

  test("returns 0 for non-existent file", () => {
    const watcher = new WaitWatcher()
    expect(watcher.countAssistantMessages("/tmp/consilium-nonexistent-99999.jsonl")).toBe(0)
  })

  test("getLastAssistantMessage extracts text from format-1 content array", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second answer" }] } }),
    ].join("\n")
    writeFileSync(tmpFile, lines)

    const watcher = new WaitWatcher()
    expect(watcher.getLastAssistantMessage(tmpFile)).toBe("second answer")
    unlinkSync(tmpFile)
  })

  test("getLastAssistantMessage extracts text from format-2 string content", () => {
    const lines = [
      JSON.stringify({ role: "assistant", content: "my response" }),
    ].join("\n")
    writeFileSync(tmpFile, lines)

    const watcher = new WaitWatcher()
    expect(watcher.getLastAssistantMessage(tmpFile)).toBe("my response")
    unlinkSync(tmpFile)
  })
})

// ── WaitWatcher.wait timeout behaviour ───────────────────────────────────────

describe("WaitWatcher.wait", () => {
  test("returns timedOut when no new messages appear within deadline", async () => {
    const tmpFile2 = join(tmpdir(), `consilium-wait-test-${Date.now()}.jsonl`)
    writeFileSync(tmpFile2, JSON.stringify({ role: "assistant", content: "existing" }) + "\n")

    const watcher = new WaitWatcher()
    const result = await watcher.wait(tmpFile2, { timeoutMs: 50, pollMs: 20 })
    expect(result.timedOut).toBe(true)
    expect(result.success).toBe(false)
    unlinkSync(tmpFile2)
  }, 2000)

  test("returns success: false when file does not exist", async () => {
    const watcher = new WaitWatcher()
    const result = await watcher.wait("/tmp/consilium-no-such-file-99999.jsonl", { timeoutMs: 50, pollMs: 20 })
    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(false)
  }, 2000)

  test("detects new assistant message appended after snapshot", async () => {
    const tmpFile3 = join(tmpdir(), `consilium-wait-detect-${Date.now()}.jsonl`)
    writeFileSync(tmpFile3, JSON.stringify({ role: "user", content: "question" }) + "\n")

    const watcher = new WaitWatcher()

    // Append a new assistant message after 30ms
    setTimeout(() => {
      writeFileSync(tmpFile3,
        JSON.stringify({ role: "user", content: "question" }) + "\n" +
        JSON.stringify({ role: "assistant", content: "new answer" }) + "\n",
      )
    }, 30)

    const result = await watcher.wait(tmpFile3, { timeoutMs: 500, pollMs: 20 })
    expect(result.success).toBe(true)
    expect(result.message).toBe("new answer")
    expect(result.timedOut).toBe(false)
    unlinkSync(tmpFile3)
  }, 3000)
})
