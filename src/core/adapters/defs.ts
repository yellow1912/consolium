import type { ModelInfo } from "./types"

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
  buildArgs(prompt: string, opts?: { model?: string }): string[]
  env?: Record<string, string>
  deleteEnv?: string[]
  modelProbe?: string[]
  fallbackModels: ModelInfo[]
  jsonrpcMethod?: string
}

export const AGENT_DEFS: AgentDef[] = [
  {
    name: "codex",
    bin: "codex",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = ["exec", "--config", "approval_policy=never"]
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
    bin: "gemini",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = ["-p", prompt, "--yolo"]
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
    name: "copilot",
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
    bin: "cursor-agent",
    streamFormat: "plain",
    promptVia: "argv",
    buildArgs(prompt, opts) {
      const args = ["--print", "--force", "--trust"]
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
