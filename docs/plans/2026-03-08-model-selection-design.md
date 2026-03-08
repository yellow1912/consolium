# Dynamic Model Selection Design

**Date:** 2026-03-08
**Status:** Approved

## Goal

Allow consilium to automatically pick the best model per agent for each task, keep the model list current, and let users override when needed.

## Key Insight

Rather than maintaining a static capability matrix, we ask the router AI (Claude) to pick the best agent **and** model from the live list. Claude already knows which of its own models is strong at what — haiku for speed, opus for reasoning — from its training knowledge. This stays accurate without any extra infrastructure.

## Architecture

### 1. Model Cache (`~/.consilium/models-cache.json`)

```json
{
  "claude": { "models": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"], "fetchedAt": "2026-03-08T10:00:00Z" },
  "codex":  { "models": ["gpt-5.3-codex"], "fetchedAt": "2026-03-08T10:00:00Z" },
  "gemini": { "models": ["gemini-2.5-pro", "gemini-2.0-flash"], "fetchedAt": "2026-03-08T10:00:00Z" }
}
```

**Refresh rules:**
- On startup: load from cache, refresh in background if older than 24h
- During session: auto-refresh every 24h (configurable via `~/.consilium/config.json`)
- On model-not-found error: re-fetch that agent's models and retry with default
- Manual: `/models refresh`

**Fallback priority:** live fetch → stale cache → hardcoded defaults in `getModels()`

### 2. Adapter Interface

Each adapter implements `getModels(): Promise<ModelInfo[]>` with two modes:
- **Live fetch**: queries the CLI (e.g. `claude --list-models`) for real available models
- **Hardcoded fallback**: returns a static list if CLI doesn't support model listing

`QueryOptions` allows passing a specific model ID down to the subprocess call.

### 3. Dispatch / Pipeline Flow

Router receives a single prompt that includes the live model list:

```
Task: "write a regex to parse email addresses"
Available agents and their models:
- claude: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- codex: gpt-5.3-codex
- gemini: gemini-2.5-pro, gemini-2.0-flash

Pick the best agent and model for this task.
Respond with JSON only: { "assignTo": "<agent>", "model": "<model-id>" }
```

The selected model is passed to the adapter as `options.model`. User session overrides take precedence over router selections.

### 4. Slash Commands

```
/models                    — list cached models per agent with fetch time
/models refresh            — re-fetch from all CLIs immediately
/model <agent> <model-id>  — set session override for an agent
/model <agent> clear       — remove override, let router decide
```

### 5. Error Handling

- **Fetch fails at startup**: use stale cache, warn user; if no cache, use hardcoded defaults
- **Model rejected by adapter**: detect via stderr + non-zero exit, re-fetch, retry with agent default
- **Router picks unknown model**: validate against cached list before calling adapter; fall back to agent default if invalid

## What Was Pre-implemented

Gemini implemented core scaffolding during the council brainstorming session:
- `ModelInfo` and `QueryOptions` types in `types.ts`
- `getModels()` on all three adapters (hardcoded lists)
- `QueryOptions` threading through `SubprocessAdapter`, `ClaudeAdapter`
- Router prompt in `dispatch`/`pipeline` includes agent+model list

## What Remains

| Component | File(s) |
|---|---|
| `ModelCache` service (read/write JSON cache) | `src/core/models/cache.ts` |
| Live model fetch from CLIs | `src/core/adapters/{claude,codex,gemini}.ts` |
| Auto-refresh on startup + 24h interval | `src/cli/index.ts` |
| `/models` and `/model` slash commands | `src/cli/index.ts`, `src/cli/slash.ts` |
| Model-not-found fallback + retry in `SubprocessAdapter` | `src/core/adapters/base.ts` |
| Fix 4 failing tests (mock adapters missing `getModels()`) | `src/core/council/council.test.ts` |
