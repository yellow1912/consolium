import type { Access, ModelInfo } from "./types"

export type StreamFormat =
  | "plain"
  | "claude-stream-json"
  | "json-event-stream"
  | "acp-json-rpc"
  | "copilot-stream-json"
  | "pi-rpc"

export type AgentDef = {
  name: string
  bin: string
  streamFormat: StreamFormat
  promptVia: "argv" | "stdin" | "jsonrpc"
  buildArgs(prompt: string, opts?: { model?: string; access?: Access }): string[]
  /** true only when buildArgs produces a verified read-only invocation for access "read-only". Missing means unsupported. */
  readOnlySupported?: boolean
  env?: Record<string, string>
  deleteEnv?: string[]
  modelProbe?: string[]
  fallbackModels: ModelInfo[]
  jsonrpcMethod?: string
}

export const AGENT_DEFS: AgentDef[] = [
  {
    name: "codex",
    readOnlySupported: true,
    bin: "codex",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = opts?.access === "read-only"
        ? ["exec", "--sandbox", "read-only"]
        : ["exec", "--config", "approval_policy=never"]
      if (opts?.model) args.push("--config", `model=${opts.model}`)
      args.push(prompt)
      return args
    },
    modelProbe: ["models"],
    fallbackModels: [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", capabilities: ["coding", "reasoning"], isDefault: true },
    ],
  },
  {
    name: "gemini",
    readOnlySupported: true,
    bin: "gemini",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = opts?.access === "read-only"
        ? ["-p", prompt, "--approval-mode", "plan"]
        : ["-p", prompt, "--yolo"]
      if (opts?.model) args.push("-m", opts.model)
      return args
    },
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
    modelProbe: ["models"],
    fallbackModels: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", capabilities: ["coding", "reasoning"], isDefault: true },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", capabilities: ["fast", "general"] },
    ],
  },
  {
    name: "agy",
    readOnlySupported: false,
    bin: "agy",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, _opts) {
      return ["--dangerously-skip-permissions", "-p", prompt]
    },
    fallbackModels: [
      { id: "agy-default", name: "Antigravity Default", capabilities: ["coding", "reasoning"], isDefault: true },
    ],
  },
  {
    name: "copilot",
    readOnlySupported: false,
    bin: "copilot",
    streamFormat: "copilot-stream-json",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = ["-p", prompt, "--allow-all-tools", "--output-format", "json"]
      if (opts?.model) args.push("--model", opts.model)
      return args
    },
    fallbackModels: [
      { id: "gpt-4o", name: "GPT-4o", capabilities: ["coding", "reasoning"], isDefault: true },
    ],
  },
  {
    name: "cursor-agent",
    readOnlySupported: true,
    bin: "cursor-agent",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = opts?.access === "read-only"
        ? ["--print", "--trust", "--mode", "plan"]
        : ["--print", "--force", "--trust"]
      if (opts?.model) args.push("--model", opts.model)
      args.push(prompt)
      return args
    },
    fallbackModels: [
      { id: "cursor-default", name: "Cursor Default", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "qwen",
    readOnlySupported: false,
    bin: "qwen",
    streamFormat: "plain",
    promptVia: "stdin",
    buildArgs(_prompt, opts) {
      const args = ["--yolo"]
      if (opts?.model) args.push("--model", opts.model)
      args.push("-")
      return args
    },
    fallbackModels: [
      { id: "qwen-default", name: "Qwen Default", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "opencode",
    readOnlySupported: false,
    bin: "opencode",
    streamFormat: "json-event-stream",
    promptVia: "stdin",
    buildArgs(_prompt, opts) {
      const args = ["run", "--format", "json", "--dangerously-skip-permissions"]
      if (opts?.model) args.push("--model", opts.model)
      args.push("-")
      return args
    },
    fallbackModels: [
      { id: "opencode-default", name: "OpenCode Default", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "aider",
    readOnlySupported: false,
    bin: "aider",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = ["--message", prompt, "--yes-always", "--no-git"]
      if (opts?.model) args.push("--model", opts.model)
      return args
    },
    fallbackModels: [
      { id: "aider-default", name: "Aider Default", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "devin",
    readOnlySupported: false,
    bin: "devin",
    streamFormat: "acp-json-rpc",
    promptVia: "jsonrpc",
    buildArgs() {
      return ["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp"]
    },
    jsonrpcMethod: "tasks/send",
    fallbackModels: [
      { id: "devin-default", name: "Devin", capabilities: ["coding", "reasoning"], isDefault: true },
    ],
  },
  {
    name: "hermes",
    readOnlySupported: false,
    bin: "hermes",
    streamFormat: "acp-json-rpc",
    promptVia: "jsonrpc",
    buildArgs() {
      return ["acp", "--accept-hooks"]
    },
    jsonrpcMethod: "tasks/send",
    fallbackModels: [
      { id: "hermes-default", name: "Hermes", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "kimi",
    readOnlySupported: false,
    bin: "kimi",
    streamFormat: "acp-json-rpc",
    promptVia: "jsonrpc",
    buildArgs() {
      return ["acp"]
    },
    jsonrpcMethod: "tasks/send",
    fallbackModels: [
      { id: "kimi-default", name: "Kimi", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "kiro",
    readOnlySupported: false,
    bin: "kiro-cli",
    streamFormat: "acp-json-rpc",
    promptVia: "jsonrpc",
    buildArgs() {
      return ["acp"]
    },
    jsonrpcMethod: "tasks/send",
    fallbackModels: [
      { id: "kiro-default", name: "Kiro", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "vibe",
    readOnlySupported: false,
    bin: "vibe-acp",
    streamFormat: "acp-json-rpc",
    promptVia: "jsonrpc",
    buildArgs() {
      return []
    },
    jsonrpcMethod: "tasks/send",
    fallbackModels: [
      { id: "mistral-vibe", name: "Mistral Vibe", capabilities: ["coding"], isDefault: true },
    ],
  },
  {
    name: "pi",
    readOnlySupported: false,
    bin: "pi",
    streamFormat: "pi-rpc",
    promptVia: "jsonrpc",
    buildArgs(_prompt, opts) {
      const args = ["--mode", "rpc", "--no-session"]
      if (opts?.model) args.push("--model", opts.model)
      return args
    },
    jsonrpcMethod: "prompt",
    fallbackModels: [
      { id: "pi-default", name: "Pi", capabilities: ["general"], isDefault: true },
    ],
  },
]
