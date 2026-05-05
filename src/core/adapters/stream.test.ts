import { test, expect, describe } from "bun:test"
import { PlainParser, JsonLineParser, createParser, EVENT_EXTRACTORS } from "./stream"

describe("PlainParser", () => {
  test("passes chunks through", () => {
    const p = new PlainParser()
    expect(p.feed("hello")).toEqual(["hello"])
    expect(p.feed(" world")).toEqual([" world"])
    expect(p.flush()).toEqual([])
  })
})

describe("JsonLineParser", () => {
  test("parses complete JSON lines", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    const tokens = p.feed('{"text":"hello"}\n{"text":"world"}\n')
    expect(tokens).toEqual(["hello", "world"])
  })

  test("buffers partial lines", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    expect(p.feed('{"text":"hel')).toEqual([])
    expect(p.feed('lo"}\n')).toEqual(["hello"])
  })

  test("skips events with no extractable text", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    const tokens = p.feed('{"type":"init"}\n{"text":"got it"}\n')
    expect(tokens).toEqual(["got it"])
  })

  test("skips malformed JSON", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    const tokens = p.feed('not json\n{"text":"ok"}\n')
    expect(tokens).toEqual(["ok"])
  })

  test("flush returns buffered incomplete line", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    p.feed('{"text":"pending"}')
    expect(p.flush()).toEqual(["pending"])
  })

  test("flush handles malformed buffer", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    p.feed("broken json")
    expect(p.flush()).toEqual([])
  })

  test("flush clears buffer", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    p.feed('{"text":"x"}')
    p.flush()
    expect(p.flush()).toEqual([])
  })

  test("handles empty lines", () => {
    const p = new JsonLineParser(e => e.text ?? null)
    const tokens = p.feed('\n\n{"text":"a"}\n\n')
    expect(tokens).toEqual(["a"])
  })
})

describe("EVENT_EXTRACTORS", () => {
  test("claude extracts content_block_delta", () => {
    const extract = EVENT_EXTRACTORS.claude
    expect(extract({ type: "content_block_delta", delta: { text: "hi" } })).toBe("hi")
    expect(extract({ type: "message_stop" })).toBeNull()
  })

  test("claude extracts assistant message string", () => {
    const extract = EVENT_EXTRACTORS.claude
    expect(extract({ type: "assistant", message: "hello" })).toBe("hello")
  })

  test("codex extracts message content", () => {
    const extract = EVENT_EXTRACTORS.codex
    expect(extract({ type: "message", content: "code here" })).toBe("code here")
    expect(extract({ type: "status", status: "running" })).toBeNull()
  })

  test("codex extracts text field", () => {
    const extract = EVENT_EXTRACTORS.codex
    expect(extract({ text: "fallback" })).toBe("fallback")
  })

  test("gemini extracts text", () => {
    const extract = EVENT_EXTRACTORS.gemini
    expect(extract({ type: "text", text: "gemini says" })).toBe("gemini says")
    expect(extract({ type: "content", content: "alt" })).toBe("alt")
  })

  test("copilot extracts delta text", () => {
    const extract = EVENT_EXTRACTORS.copilot
    expect(extract({ type: "content_block_delta", delta: { text: "token" } })).toBe("token")
  })

  test("opencode extracts text or content", () => {
    const extract = EVENT_EXTRACTORS.opencode
    expect(extract({ text: "a" })).toBe("a")
    expect(extract({ content: "b" })).toBe("b")
    expect(extract({ other: "c" })).toBeNull()
  })

  test("acp extracts from params.message.parts", () => {
    const extract = EVENT_EXTRACTORS.acp
    expect(extract({
      params: { message: { parts: [{ type: "text", text: "hello from acp" }] } },
    })).toBe("hello from acp")
  })

  test("acp extracts from result.message.parts", () => {
    const extract = EVENT_EXTRACTORS.acp
    expect(extract({
      result: { message: { parts: [{ type: "text", text: "done" }] } },
    })).toBe("done")
  })

  test("acp joins multiple text parts", () => {
    const extract = EVENT_EXTRACTORS.acp
    expect(extract({
      params: { message: { parts: [
        { type: "text", text: "a" },
        { type: "image", url: "x" },
        { type: "text", text: "b" },
      ] } },
    })).toBe("ab")
  })

  test("acp falls back to result.content", () => {
    const extract = EVENT_EXTRACTORS.acp
    expect(extract({ result: { content: "fallback" } })).toBe("fallback")
  })

  test("acp returns null for non-text events", () => {
    const extract = EVENT_EXTRACTORS.acp
    expect(extract({ method: "tasks/status", params: { status: "working" } })).toBeNull()
  })

  test("pi extracts result.content", () => {
    const extract = EVENT_EXTRACTORS.pi
    expect(extract({ result: { content: "pi says hi" } })).toBe("pi says hi")
  })

  test("pi extracts result.text", () => {
    const extract = EVENT_EXTRACTORS.pi
    expect(extract({ result: { text: "alt" } })).toBe("alt")
  })

  test("pi returns null without result", () => {
    const extract = EVENT_EXTRACTORS.pi
    expect(extract({ error: { message: "oops" } })).toBeNull()
  })
})

describe("createParser", () => {
  test("plain format returns PlainParser", () => {
    const p = createParser("plain")
    expect(p.feed("raw")).toEqual(["raw"])
  })

  test("json-event-stream with known agent uses agent extractor", () => {
    const p = createParser("json-event-stream", "codex")
    const tokens = p.feed('{"type":"message","content":"hello"}\n')
    expect(tokens).toEqual(["hello"])
  })

  test("json-event-stream with unknown agent uses generic extractor", () => {
    const p = createParser("json-event-stream", "future-agent")
    const tokens = p.feed('{"text":"generic"}\n')
    expect(tokens).toEqual(["generic"])
  })

  test("claude-stream-json uses claude extractor", () => {
    const p = createParser("claude-stream-json", "claude")
    const tokens = p.feed('{"type":"content_block_delta","delta":{"text":"hi"}}\n')
    expect(tokens).toEqual(["hi"])
  })

  test("copilot-stream-json uses copilot extractor", () => {
    const p = createParser("copilot-stream-json", "copilot")
    const tokens = p.feed('{"type":"text","text":"yo"}\n')
    expect(tokens).toEqual(["yo"])
  })

  test("acp-json-rpc uses acp extractor", () => {
    const p = createParser("acp-json-rpc")
    const tokens = p.feed('{"params":{"message":{"parts":[{"type":"text","text":"acp works"}]}}}\n')
    expect(tokens).toEqual(["acp works"])
  })

  test("pi-rpc uses pi extractor", () => {
    const p = createParser("pi-rpc")
    const tokens = p.feed('{"result":{"content":"pi works"}}\n')
    expect(tokens).toEqual(["pi works"])
  })

  test("multi-chunk streaming simulation", () => {
    const p = createParser("json-event-stream", "gemini")
    const all: string[] = []
    all.push(...p.feed('{"type":"te'))
    all.push(...p.feed('xt","text":"chunk1"}\n{"type":'))
    all.push(...p.feed('"text","text":"chunk2"}\n'))
    all.push(...p.flush())
    expect(all).toEqual(["chunk1", "chunk2"])
  })
})
