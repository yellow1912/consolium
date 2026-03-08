# Tab Completion for Consilium CLI

**Date:** 2026-03-08

## Problem

The CLI has no command discovery or tab completion. Users must remember all slash commands and their arguments.

## Goal

Add readline tab completion for slash commands and their arguments, with zero new dependencies.

## Architecture

A `buildCompleter(registry, modelCache)` factory in `src/cli/completer.ts` returns a readline-compatible `completer(line)` function. Passed to `readline.createInterface` in `src/cli/index.ts`.

## Completion Table

| Input | Completions |
|---|---|
| `/` or empty | all command names |
| `/mo` | `/mode` |
| `/mode ` | `council dispatch pipeline debate` |
| `/router ` | agent names from registry |
| `/models ` | `refresh` |
| `/model ` | agent names from registry |
| `/model <agent> ` | model IDs from cache + `clear` |
| `/debate ` | `rounds autopilot` |
| `/debate autopilot ` | `on off` |
| `/debate rounds ` | *(no completions — numeric)* |
| `/agents` `/sessions` `/history` `/help` | *(no args)* |

## Files

- **New:** `src/cli/completer.ts` — factory + completer logic
- **Modified:** `src/cli/index.ts` — pass completer to `createInterface`
- **New:** `src/cli/completer.test.ts` — unit tests
