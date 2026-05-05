import type { StreamFormat } from "./defs"

export interface StreamParser {
  feed(chunk: string): string[]
  flush(): string[]
}

export class PlainParser implements StreamParser {
  feed(chunk: string): string[] { return [chunk] }
  flush(): string[] { return [] }
}

export class JsonLineParser implements StreamParser {
  private buffer = ""
  private extract: (event: any) => string | null

  constructor(extract: (event: any) => string | null) {
    this.extract = extract
  }

  feed(chunk: string): string[] {
    this.buffer += chunk
    const tokens: string[] = []
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const text = this.extract(JSON.parse(trimmed))
        if (text) tokens.push(text)
      } catch { /* skip malformed */ }
    }
    return tokens
  }

  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ""
    if (!rest) return []
    try {
      const text = this.extract(JSON.parse(rest))
      return text ? [text] : []
    } catch { return [] }
  }
}

export const EVENT_EXTRACTORS: Record<string, (event: any) => string | null> = {
  claude: (e) => {
    if (e.type === "content_block_delta" && e.delta?.text) return e.delta.text
    if (e.type === "assistant" && typeof e.message === "string") return e.message
    return null
  },
  codex: (e) => {
    if (e.type === "message" && typeof e.content === "string") return e.content
    if (typeof e.text === "string") return e.text
    return null
  },
  gemini: (e) => {
    if (e.type === "text" && typeof e.text === "string") return e.text
    if (typeof e.content === "string") return e.content
    return null
  },
  copilot: (e) => {
    if (e.type === "content_block_delta" && e.delta?.text) return e.delta.text
    if (e.type === "text" && typeof e.text === "string") return e.text
    return null
  },
  opencode: (e) => {
    if (typeof e.text === "string") return e.text
    if (typeof e.content === "string") return e.content
    return null
  },
  acp: (e) => {
    // ACP JSON-RPC: notifications have params.message.parts[]
    const parts = e.params?.message?.parts ?? e.result?.message?.parts
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
      return texts.length > 0 ? texts.join("") : null
    }
    // Fallback: direct text in result
    if (typeof e.result?.content === "string") return e.result.content
    return null
  },
  pi: (e) => {
    if (typeof e.result?.content === "string") return e.result.content
    if (typeof e.result?.text === "string") return e.result.text
    return null
  },
}

function genericExtract(event: any): string | null {
  if (typeof event.text === "string") return event.text
  if (typeof event.content === "string") return event.content
  if (event.delta?.text) return event.delta.text
  return null
}

const FORMAT_EXTRACTOR_MAP: Partial<Record<StreamFormat, string>> = {
  "claude-stream-json": "claude",
  "copilot-stream-json": "copilot",
  "acp-json-rpc": "acp",
  "pi-rpc": "pi",
}

export function createParser(format: StreamFormat, agentName?: string): StreamParser {
  if (format === "plain") return new PlainParser()
  const extractorKey = agentName && EVENT_EXTRACTORS[agentName]
    ? agentName
    : FORMAT_EXTRACTOR_MAP[format]
  const extract = EVENT_EXTRACTORS[extractorKey ?? ""] ?? genericExtract
  return new JsonLineParser(extract)
}
