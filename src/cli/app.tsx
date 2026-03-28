import React, { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { Box, Text, useApp } from "ink"
import { TextInput, Spinner } from "@inkjs/ui"
import type { Mode } from "./types.js"
import type { Message } from "../core/adapters/types.js"
import { parseSlash } from "./slash.js"
import { classifyIntent } from "./intent.js"
import { SessionManager } from "../core/session/index.js"
import { CouncilRunner } from "../core/council/index.js"
import { buildDefaultRegistry, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry.js"
import { ModelCache } from "../core/models/cache.js"
import StatusBar from "./components/StatusBar.js"
import MessageList from "./components/MessageList.js"
import SessionPicker from "./components/SessionPicker.js"

type AppProps = {
  initialMode?: Mode
  initialRouter?: string
  resumeSessionId?: string
  personas?: boolean
}

const SLASH_SUGGESTIONS = [
  "/mode",
  "/router",
  "/agents",
  "/models",
  "/model",
  "/sessions",
  "/resume",
  "/history",
  "/help",
  "/debate",
  "/exit",
  "/quit",
]

export default function App({ initialMode = "council", initialRouter = "claude", resumeSessionId, personas }: AppProps) {
  const { exit } = useApp()

  // --- Core refs (persist across renders) ---
  const sessionMgr = useRef(new SessionManager())
  const modelCache = useRef(new ModelCache())
  const registryRef = useRef<AdapterRegistry>(personas ? buildPersonaRegistry() : buildDefaultRegistry())

  // --- State ---
  const [mode, setMode] = useState<Mode>(initialMode)
  const [routerName, setRouterName] = useState(initialRouter)
  const [sessionId, setSessionId] = useState("")
  const [context, setContext] = useState<Message[]>([])
  const contextRef = useRef<Message[]>(context)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingText, setLoadingText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerSessions, setPickerSessions] = useState<{ id: string; mode: string; status: string; router: string }[]>([])
  const [modelOverrides, setModelOverrides] = useState<Record<string, string[]>>({})
  const [debateMaxRounds, setDebateMaxRounds] = useState(5)
  const [resumed, setResumed] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [awaitingRerun, setAwaitingRerun] = useState(false)
  const rerunPromptRef = useRef<string | null>(null)
  type QueueEntry = string | { text: string; skipClassification: boolean }
  const messageQueue = useRef<QueueEntry[]>([])
  const isProcessing = useRef(false)

  // --- Initialize session ---
  useEffect(() => {
    modelCache.current.load().catch(() => {})

    if (resumeSessionId) {
      switchToSession(resumeSessionId)
    } else {
      const sess = sessionMgr.current.create({ mode, router: routerName })
      setSessionId(sess.id)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Build runner ---
  const runner = useMemo(() => {
    const registry = registryRef.current
    const router = registry.get(routerName)
    if (!router || !sessionId) return null
    const adapters = registry.all().filter(a => a.name !== routerName)
    return new CouncilRunner({
      router,
      adapters,
      modelOverrides,
      masterSessionId: sessionId,
      sessionStore: sessionMgr.current,
    })
  }, [routerName, sessionId, modelOverrides])

  // --- Session switching ---
  const switchToSession = useCallback((id: string) => {
    const sess = sessionMgr.current.get(id)
    if (!sess) {
      setError(`Session ${id} not found.`)
      return
    }
    setSessionId(sess.id)
    setMode(sess.mode as Mode)
    setRouterName(sess.router)
    const msgs = sessionMgr.current.getMessages(sess.id)
    setContext(msgs)
    contextRef.current = msgs
    setResumed(true)
    setError(null)
  }, [])

  // --- Add a message to context + persist ---
  const addMessage = useCallback((role: Message["role"], agent: string | null, content: string) => {
    const msg: Message = { role, agent, content }
    setContext(prev => {
      const next = [...prev, msg]
      contextRef.current = next
      return next
    })
    if (sessionId) {
      sessionMgr.current.addMessage(sessionId, role, agent, content)
    }
  }, [sessionId])

  // --- Mode execution ---
  const executeDispatch = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Routing to agent...")
    setError(null)
    try {
      addMessage("user", null, prompt)
      const result = await runner.dispatch(prompt, contextRef.current, {
        onRouted: (agent, model) => {
          const modelInfo = model ? ` (${model})` : ""
          addMessage("system", null, `Router → ${agent}${modelInfo}`)
          setLoadingText(`${agent} is thinking...`)
        },
      })
      addMessage("agent", result.agent, result.content)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executeCouncil = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Consulting all agents...")
    setError(null)
    try {
      addMessage("user", null, prompt)
      const result = await runner.council(prompt, contextRef.current, {
        onAgentComplete: (resp) => {
          addMessage("agent", resp.agent, resp.content)
        },
      })
      addMessage("agent", "synthesis", result.synthesis)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executePipeline = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Routing task...")
    setError(null)
    try {
      addMessage("user", null, prompt)
      const result = await runner.pipeline(prompt, contextRef.current, {
        onRouted: (executor, model) => {
          const modelInfo = model ? ` (${model})` : ""
          addMessage("system", null, `Router → ${executor}${modelInfo}`)
          setLoadingText(`${executor} is working...`)
        },
        onExecutorComplete: (content) => {
          addMessage("agent", "pipeline", content)
          setLoadingText("Reviewing...")
        },
        onReviewComplete: (review) => {
          const verdict = review.verdict === "approved" ? "[APPROVED]" : "[CHANGES REQUESTED]"
          addMessage("agent", review.reviewer, `${verdict} ${review.content}`)
        },
      })
      if (result.approved) {
        addMessage("system", null, "All reviewers approved.")
      } else {
        rerunPromptRef.current = prompt
        setAwaitingRerun(true)
        addMessage("system", null, "Reviewers requested changes. Re-run with their feedback? (y/n)")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executeDebate = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Starting debate...")
    setError(null)
    try {
      addMessage("user", null, prompt)
      const result = await runner.debate(prompt, contextRef.current, {
        maxRounds: debateMaxRounds,
        onRoundComplete: async (roundNum, responses) => {
          setLoadingText(`Debate round ${roundNum} complete...`)
          for (const resp of responses) {
            addMessage("agent", resp.agent, `[Round ${roundNum}] ${resp.content}`)
          }
          return undefined // auto-continue
        },
      })
      addMessage("agent", "synthesis", result.synthesis)
      const status = result.consensusReached
        ? `Consensus reached in ${result.roundCount} round(s).`
        : `Debate ended after ${result.roundCount} round(s) without full consensus.`
      addMessage("system", null, status)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage, debateMaxRounds])

  const executePrompt = useCallback(async (prompt: string) => {
    switch (mode) {
      case "dispatch": return executeDispatch(prompt)
      case "council": return executeCouncil(prompt)
      case "pipeline": return executePipeline(prompt)
      case "debate": return executeDebate(prompt)
    }
  }, [mode, executeDispatch, executeCouncil, executePipeline, executeDebate])

  // --- Slash command handler ---
  const handleSlashCommand = useCallback(async (command: string, args: string[]) => {
    setError(null)

    switch (command) {
      case "mode": {
        const newMode = args[0] as Mode | undefined
        if (!newMode || !["council", "dispatch", "pipeline", "debate"].includes(newMode)) {
          setError("Usage: /mode <council|dispatch|pipeline|debate>")
          return
        }
        setMode(newMode)
        addMessage("system", null, `Mode changed to ${newMode}.`)
        break
      }

      case "router": {
        const name = args[0]
        if (!name) {
          setError("Usage: /router <agent-name>")
          return
        }
        const registry = registryRef.current
        const agent = registry.get(name)
        if (!agent) {
          const available = registry.all().map(a => a.name).join(", ")
          setError(`Agent "${name}" not found. Available: ${available}`)
          return
        }
        setRouterName(name)
        addMessage("system", null, `Router changed to ${name}.`)
        break
      }

      case "agents": {
        const registry = registryRef.current
        const agents = registry.all()
        const lines = agents.map(a => `  - ${a.name}${a.name === routerName ? " (router)" : ""}`)
        addMessage("system", null, `Available agents:\n${lines.join("\n")}`)
        break
      }

      case "models": {
        if (args[0] === "refresh") {
          setIsLoading(true)
          setLoadingText("Refreshing model cache...")
          try {
            const registry = registryRef.current
            for (const agent of registry.all()) {
              const models = await agent.getModels()
              modelCache.current.set(agent.name, models.map(m => m.id))
            }
            await modelCache.current.save()
            addMessage("system", null, "Model cache refreshed.")
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          } finally {
            setIsLoading(false)
            setLoadingText("")
          }
          return
        }
        const registry = registryRef.current
        const lines: string[] = []
        for (const agent of registry.all()) {
          const cached = modelCache.current.get(agent.name)
          const override = modelOverrides[agent.name]
          if (cached.length > 0) {
            const modelList = cached.map(m => {
              const isOverride = override?.includes(m)
              return isOverride ? `${m} (active)` : m
            }).join(", ")
            lines.push(`  ${agent.name}: ${modelList}`)
          } else {
            lines.push(`  ${agent.name}: (no cached models — run /models refresh)`)
          }
        }
        addMessage("system", null, `Cached models:\n${lines.join("\n")}`)
        break
      }

      case "model": {
        const [agentName, modelId] = args
        if (!agentName || !modelId) {
          setError("Usage: /model <agent> <model-id|clear>")
          return
        }
        if (modelId === "clear") {
          setModelOverrides(prev => {
            const next = { ...prev }
            delete next[agentName]
            return next
          })
          addMessage("system", null, `Model override cleared for ${agentName}.`)
        } else {
          setModelOverrides(prev => ({
            ...prev,
            [agentName]: [modelId],
          }))
          addMessage("system", null, `Model for ${agentName} set to ${modelId}.`)
        }
        break
      }

      case "sessions": {
        const sessions = sessionMgr.current.listAll()
        const mapped = sessions.map(s => ({
          id: s.id,
          mode: s.mode,
          status: s.status,
          router: s.router,
        }))
        setPickerSessions(mapped)
        setShowPicker(true)
        break
      }

      case "resume": {
        if (args[0]) {
          // Direct resume by ID (or partial ID)
          const allSessions = sessionMgr.current.listAll()
          const match = allSessions.find(s => s.id === args[0] || s.id.startsWith(args[0]))
          if (match) {
            switchToSession(match.id)
          } else {
            setError(`No session found matching "${args[0]}".`)
          }
        } else {
          // Show picker
          const sessions = sessionMgr.current.listAll()
          const mapped = sessions.map(s => ({
            id: s.id,
            mode: s.mode,
            status: s.status,
            router: s.router,
          }))
          setPickerSessions(mapped)
          setShowPicker(true)
        }
        break
      }

      case "history": {
        const msgs = contextRef.current
        if (msgs.length === 0) {
          addMessage("system", null, "No messages in this session.")
        } else {
          const lines = msgs.map((m, i) => {
            const sender = m.agent ?? m.role
            return `  ${i + 1}. [${sender}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`
          })
          addMessage("system", null, `Session history (${msgs.length} messages):\n${lines.join("\n")}`)
        }
        break
      }

      case "debate": {
        const sub = args[0]
        if (sub === "rounds") {
          const n = parseInt(args[1], 10)
          if (isNaN(n) || n < 1 || n > 20) {
            setError("Usage: /debate rounds <1-20>")
            return
          }
          setDebateMaxRounds(n)
          addMessage("system", null, `Debate max rounds set to ${n}.`)
        } else {
          setError("Usage: /debate rounds <n>")
        }
        break
      }

      case "help": {
        const helpText = [
          "Commands:",
          "  /mode <council|dispatch|pipeline|debate>  — switch mode",
          "  /router <agent-name>                      — set router agent",
          "  /agents                                   — list available agents",
          "  /models                                   — show cached models",
          "  /models refresh                           — refresh model cache",
          "  /model <agent> <model-id|clear>           — override agent model",
          "  /sessions                                 — browse sessions",
          "  /resume [id]                              — resume a session",
          "  /history                                  — show session history",
          "  /debate rounds <n>                        — set max debate rounds",
          "  /help                                     — show this help",
          "  /exit                                     — quit",
        ].join("\n")
        addMessage("system", null, helpText)
        break
      }

      case "exit":
      case "quit": {
        sessionMgr.current.close()
        exit()
        break
      }

      default:
        setError(`Unknown command: /${command}`)
    }
  }, [addMessage, exit, modelOverrides, routerName, switchToSession])

  // --- Process queue one message at a time ---
  const processQueue = useCallback(async () => {
    if (isProcessing.current) return
    isProcessing.current = true

    while (messageQueue.current.length > 0) {
      const entry = messageQueue.current.shift()!
      const trimmed = typeof entry === "string" ? entry : entry.text
      const skipClassification = typeof entry !== "string" && entry.skipClassification

      // 0. Handle pending pipeline re-run decision
      if (rerunPromptRef.current !== null) {
        const answer = trimmed.toLowerCase()
        const pendingPrompt = rerunPromptRef.current
        rerunPromptRef.current = null
        setAwaitingRerun(false)
        if (answer === "y" || answer === "yes") {
          addMessage("system", null, "Re-running with reviewer feedback...")
          await executePrompt(pendingPrompt)
        } else {
          addMessage("system", null, "Re-run cancelled.")
        }
        continue
      }

      // 1. Try slash command
      const slash = parseSlash(trimmed)
      if (slash) {
        await handleSlashCommand(slash.command, slash.args)
        continue
      }

      // 2. Try NLP intent classification (skip for followup messages to prevent loops)
      if (!skipClassification) {
        const registry = registryRef.current
        const classifier = registry.get(routerName)
        if (classifier) {
          setIsLoading(true)
          setLoadingText("Thinking...")
          try {
            const intent = await classifyIntent(trimmed, classifier, registry)
            setIsLoading(false)
            setLoadingText("")
            if (intent.type === "command") {
              await handleSlashCommand(intent.command, intent.args ?? [])
              // Followup goes directly to execution — never back through classification
              if (intent.followup) {
                messageQueue.current.unshift({ text: intent.followup, skipClassification: true })
              }
              continue
            }
          } catch {
            setIsLoading(false)
            setLoadingText("")
          }
        }
      }

      // 3. Execute as message in current mode
      await executePrompt(trimmed)
    }

    isProcessing.current = false
  }, [handleSlashCommand, routerName, executePrompt, addMessage, setAwaitingRerun])

  // --- Input submission --- queues message and kicks off processing
  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInputValue("")
    // Skip if this exact message is already queued (prevents spam from impatient re-submissions)
    const queue = messageQueue.current
    const lastEntry = queue.length > 0 ? queue[queue.length - 1] : null
    const lastText = lastEntry ? (typeof lastEntry === "string" ? lastEntry : lastEntry.text) : null
    if (lastText === trimmed) return
    queue.push(trimmed)
    processQueue()
  }, [processQueue])

  // --- Session picker handlers ---
  const handlePickerSelect = useCallback((id: string) => {
    setShowPicker(false)
    switchToSession(id)
  }, [switchToSession])

  const handlePickerCancel = useCallback(() => {
    setShowPicker(false)
  }, [])

  // --- Render ---
  if (showPicker) {
    return (
      <Box flexDirection="column">
        <SessionPicker
          sessions={pickerSessions}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <MessageList messages={context} resumed={resumed} />

      {isLoading && (
        <Box marginY={1}>
          <Spinner label={loadingText || "Working..."} />
        </Box>
      )}

      {error && (
        <Box marginY={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      <Box>
        <Text bold color="green">&gt; </Text>
        <TextInput
          placeholder={awaitingRerun ? "Re-run with reviewer feedback? (y/n)" : "Type a message or /help..."}
          suggestions={awaitingRerun ? [] : SLASH_SUGGESTIONS}
          onSubmit={handleSubmit}
          onChange={setInputValue}
        />
      </Box>

      <StatusBar
        mode={mode}
        router={routerName}
        sessionId={sessionId}
        messageCount={context.length}
        debateMaxRounds={mode === "debate" ? debateMaxRounds : undefined}
      />
    </Box>
  )
}
