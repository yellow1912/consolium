# Ink CLI Rewrite Design

## Goal

Replace the readline-based CLI with an Ink (React for CLI) app that provides a Claude Code-like interactive experience: streaming responses, markdown rendering, persistent status bar, rich input, and keyboard shortcuts.

## Scope

- Rewrite `src/cli/` as an Ink React app
- Add streaming support to subprocess adapters
- Keep `src/core/` and `src/mcp/` untouched
- Keep `src/index.ts` argument parsing as-is (calls into new Ink app)

## Architecture

```
src/cli/
├── app.tsx              — Root <App>, state management, mode dispatch
├── components/
│   ├── StatusBar.tsx     — Bottom bar: mode, router, session, message count
│   ├── MessageList.tsx   — Scrollable conversation history
│   ├── Message.tsx       — Single message with markdown + syntax highlighting
│   ├── Input.tsx         — Multi-line text input, history, tab completion
│   ├── Spinner.tsx       — Loading indicator with agent context
│   └── SessionPicker.tsx — Arrow-key session selector (replaces @clack/prompts)
├── hooks/
│   ├── useSession.ts     — Session state: mode, router, context, switchSession
│   ├── useRunner.ts      — CouncilRunner lifecycle, mode execution
│   └── useStreaming.ts   — Subscribe to queryStream() async generator
├── intent.ts             — Keep as-is (NLP command classification)
├── slash.ts              — Keep as-is (slash command parser)
└── completer.ts          — Adapt completion data for Ink input
```

## Streaming Adapter

Add `queryStream()` to `SubprocessAdapter` (base.ts):

```ts
async *queryStream(prompt: string, context: Message[], options?: QueryOptions): AsyncGenerator<string> {
  const fullPrompt = this.buildContextPrompt(prompt, context)
  const args = this.buildArgs(fullPrompt, options)
  const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`${this.name} exited with code ${exitCode}: ${stderr}`)
  }
}
```

Existing `query()` stays for non-streaming use cases (MCP server, council synthesis, pipeline reviews).

Add `queryStream()` to `AgentAdapter` interface in types.ts as an optional method. Adapters that don't support it fall back to `query()`.

Claude adapter override: must delete `CLAUDECODE` env var (already done in its `spawnAndRead` override) — same treatment for `queryStream`.

## Components

### StatusBar

Persistent bottom bar, always visible. Updates reactively.

```
 council │ router: claude │ session: 6cfb2c4a │ 3 messages
```

In debate mode, extends with round info:

```
 debate │ router: claude │ round 2/5 │ session: 6cfb2c4a
```

### MessageList

Renders conversation as a vertical list of `<Message>` components. Shows most recent messages, scrollable. Each message has:

- Role indicator: colored dot or icon (user = green, agent = blue, synthesis = purple, error = red)
- Agent name and optional duration
- Content rendered as markdown

### Message

Single message component. Renders content with:

- Markdown formatting (bold, italic, lists, headings)
- Syntax-highlighted code blocks (using `cli-highlight` or `ink-syntax-highlight`)
- Truncation for very long messages with "show more" expansion

### Input

Multi-line text input at the bottom (above status bar):

- Up/down arrow for input history navigation
- Tab completion for slash commands and agent names
- Enter to submit, Shift+Enter or paste for multi-line
- Esc to clear current input
- Ctrl+C to cancel running operation

### Spinner

Shown inline in the message list while agents are working:

```
⠹ [claude, codex, gemini] thinking...
```

Updates text as mode progresses (e.g., "routing..." → "[codex] thinking..." → "[claude, gemini] reviewing...").

### SessionPicker

Full-screen overlay triggered by `/sessions` or `/resume`:

- Arrow key navigation
- Shows session ID (truncated), mode, router, status, message count
- Enter to select, Esc to cancel
- Replaces `@clack/prompts` dependency

## State Management

Use React hooks in the root `<App>` component:

```tsx
function App({ initialOptions }) {
  const session = useSession(initialOptions)    // mode, router, context, switchSession
  const runner = useRunner(session)              // buildRunner, execute modes
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [streamingMessage, setStreamingMessage] = useState<string | null>(null)

  // ... render MessageList, Input, StatusBar, Spinner
}
```

### useSession hook

Manages: mode, routerName, session object, context array, modelOverrides, debate settings.
Exposes: switchToSession(), setMode(), setRouter(), addMessage().

### useRunner hook

Creates CouncilRunner from session state. Exposes mode execution methods that update streaming state.

### useStreaming hook

Subscribes to an `AsyncGenerator<string>` and accumulates chunks into state, triggering re-renders as content streams in.

## Mode Execution Flow

### Dispatch (simplest, streaming)

1. User submits input → `setIsLoading(true)`
2. Router classifies → spinner updates to `[codex] thinking...`
3. `queryStream()` yields chunks → `streamingMessage` updates progressively
4. Stream ends → final message added to context, `setIsLoading(false)`

### Council (parallel, then synthesis)

1. All agents queried in parallel (non-streaming, show spinner)
2. Each response rendered as it arrives
3. Router synthesizes — this can stream
4. Synthesis rendered progressively

### Pipeline (execute + review)

1. Executor selected, runs (can stream)
2. Reviewers run in parallel (non-streaming, show spinner)
3. All reviews rendered, verdict shown

### Debate (multi-round, interactive)

1. Each round: agents respond (parallel, non-streaming)
2. Round results rendered immediately
3. Input switches to debate controls
4. User types steering text, Enter to continue, `/done` to end
5. Status bar shows round progress
6. Final synthesis streams

## Slash Commands

Same commands as current CLI. Parsed by existing `parseSlash()`. Handled in App component's submit handler. Some commands trigger UI changes:

- `/mode`, `/router` → update session state, status bar re-renders
- `/sessions`, `/resume` → show SessionPicker overlay
- `/history` → scroll to top of message list
- `/help` → render help as a system message in the message list
- `/agents`, `/models` → render as system messages

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Submit input |
| Up/Down | Input history navigation |
| Tab | Autocomplete slash commands |
| Esc | Clear input / cancel picker |
| Ctrl+C | Cancel running operation / exit if idle |

## Dependencies

### Add
- `ink` — React renderer for CLI
- `react` — peer dependency for Ink
- `ink-text-input` — text input component
- `ink-spinner` — loading spinners
- `ink-markdown` or `marked-terminal` + `chalk` — markdown rendering
- `cli-highlight` — syntax highlighting for code blocks

### Remove
- `@clack/prompts` — replaced by Ink components

## Migration Strategy

1. Build new Ink CLI alongside existing readline CLI
2. Wire `src/index.ts` to call new Ink app
3. Verify all features work
4. Delete old readline CLI code
5. Remove `@clack/prompts` dependency

## Entry Point Change

`src/index.ts` currently calls `startCLI(options)`. After migration, it calls `renderInkApp(options)` which does:

```tsx
import { render } from "ink"
import { App } from "./cli/app"

export function renderInkApp(options) {
  render(<App {...options} />)
}
```

## Out of Scope

- MCP server changes (stays as-is)
- Core adapter logic changes (beyond adding queryStream)
- Database schema changes
- New execution modes
