import React, { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { TextInput, Spinner } from "@inkjs/ui"
import type { Mode } from "./types.js"
import type { Message as MessageData } from "../core/adapters/types.js"
import { parseSlash } from "./slash.js"
import { classifyIntent } from "./intent.js"
import { SessionManager } from "../core/session/index.js"
import { CouncilRunner } from "../core/council/index.js"
import { buildAutoRegistrySync, buildPersonaRegistry, type AdapterRegistry } from "../core/adapters/registry.js"
import { ModelCache } from "../core/models/cache.js"
import StatusBar from "./components/StatusBar.js"
import MessageList from "./components/MessageList.js"
import SessionPicker from "./components/SessionPicker.js"
import Message from "./components/Message.js"

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
  "/review",
  "/workflow",
  "/stop",
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
  const registryRef = useRef<AdapterRegistry>(personas ? buildPersonaRegistry() : buildAutoRegistrySync())

  // --- State ---
  const [mode, setMode] = useState<Mode>(initialMode)
  const [routerName, setRouterName] = useState(initialRouter)
  const [sessionId, setSessionId] = useState("")
  const [context, setContext] = useState<MessageData[]>([])
  const contextRef = useRef<MessageData[]>(context)
  const [isLoading, setIsLoading] = useState(false)
  const [loadingText, setLoadingText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerSessions, setPickerSessions] = useState<{ id: string; mode: string; status: string; router: string }[]>([])
  const [modelOverrides, setModelOverrides] = useState<Record<string, string[]>>({})
  const [debateMaxRounds, setDebateMaxRounds] = useState(5)
  const [resumed, setResumed] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [liveStreams, setLiveStreams] = useState<Record<string, string>>({})
  const [awaitingRerun, setAwaitingRerun] = useState(false)
  const rerunPromptRef = useRef<string | null>(null)
  const rerunCountRef = useRef(0)
  const MAX_PIPELINE_RERUNS = 3
  const stopDebateRef = useRef(false)
  const isDebatingRef = useRef(false)
  const [awaitingWorkflow, setAwaitingWorkflow] = useState(false)
  const [followupOptions, setFollowupOptions] = useState<{ label: string; mode: Mode; prompt: string }[] | null>(null)
  const workflowCheckpointRef = useRef<((cont: boolean) => void) | null>(null)
  type QueueEntry = string | { text: string; skipClassification: boolean }
  const messageQueue = useRef<QueueEntry[]>([])
  const isProcessing = useRef(false)
  const currentlyProcessingText = useRef<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // --- Escape key to cancel current operation ---
  useInput((_input, key) => {
    if (key.escape && isProcessing.current) {
      abortControllerRef.current?.abort()
      addMessage("system", null, "Cancelled.")
    }
  })

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

  // --- Streaming helpers ---
  const onStreamToken = useCallback((agentName: string, token: string) => {
    setLiveStreams(prev => ({ ...prev, [agentName]: (prev[agentName] ?? "") + token }))
  }, [])

  const clearLiveStream = useCallback((agentName: string) => {
    setLiveStreams(prev => { const n = { ...prev }; delete n[agentName]; return n })
  }, [])

  // --- Add a message to context + persist ---
  const addMessage = useCallback((role: MessageData["role"], agent: string | null, content: string) => {
    const msg: MessageData = { role, agent, content }
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
    const ac = new AbortController()
    abortControllerRef.current = ac
    try {
      let dispatchAgent = ""
      const result = await runner.dispatch(prompt, contextRef.current, {
        signal: ac.signal,
        onRouted: (agent, model) => {
          dispatchAgent = agent
          const modelInfo = model ? ` (${model})` : ""
          addMessage("system", null, `Router → ${agent}${modelInfo}`)
          setLoadingText(`${agent} is thinking...`)
        },
        onStream: (token) => onStreamToken(dispatchAgent, token),
      })
      clearLiveStream(dispatchAgent)
      if (result.agent) sessionMgr.current.upsertParticipant(sessionId, result.agent)
      addMessage("agent", result.agent, result.content)
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortControllerRef.current = null
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executeCouncil = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Consulting all agents...")
    setError(null)
    const ac = new AbortController()
    abortControllerRef.current = ac
    try {
      const result = await runner.council(prompt, contextRef.current, {
        signal: ac.signal,
        onAgentStream: (agentName, token) => onStreamToken(agentName, token),
        onAgentComplete: (resp) => {
          clearLiveStream(resp.agent)
          if (resp.agent) sessionMgr.current.upsertParticipant(sessionId, resp.agent)
          addMessage("agent", resp.agent, resp.content)
        },
        onAgentError: (agentName, error) => {
          clearLiveStream(agentName)
          addMessage("system", null, `${agentName} failed: ${error.message}`)
        },
      })
      addMessage("agent", "synthesis", result.synthesis)
      const suggestions = await runner.suggestFollowups(result.synthesis, prompt, "council")
      if (suggestions.length > 0) {
        const opts = suggestions as { label: string; mode: Mode; prompt: string }[]
        setFollowupOptions(opts)
        const lines = opts.map((s, i) => `  ${i + 1}. [${s.mode}] ${s.label}`)
        addMessage("system", null, `What would you like to do next?\n${lines.join("\n")}\n\nEnter a number or type freely.`)
      }
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortControllerRef.current = null
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executePipeline = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Routing task...")
    setError(null)
    const ac = new AbortController()
    abortControllerRef.current = ac
    try {
      rerunCountRef.current = 0
      let currentTaskId: string | null = null
      const result = await runner.pipeline(prompt, contextRef.current, {
        signal: ac.signal,
        onRouted: (executor, model) => {
          const task = sessionMgr.current.createTask(sessionId, prompt, executor)
          currentTaskId = task.id
          sessionMgr.current.updateTaskStatus(task.id, "running")
          sessionMgr.current.upsertParticipant(sessionId, executor)
          const modelInfo = model ? ` (${model})` : ""
          addMessage("system", null, `Router → ${executor}${modelInfo}`)
          setLoadingText(`${executor} is working...`)
        },
        onExecutorStream: (token) => onStreamToken("pipeline", token),
        onExecutorComplete: (content) => {
          clearLiveStream("pipeline")
          if (currentTaskId) sessionMgr.current.updateTaskStatus(currentTaskId, "done")
          addMessage("agent", "pipeline", content)
          setLoadingText("Reviewing...")
        },
        onReviewComplete: (review) => {
          if (currentTaskId) {
            sessionMgr.current.createReview(
              currentTaskId, review.reviewer, review.content,
              review.verdict as "approved" | "changes_requested",
            )
          }
          sessionMgr.current.upsertParticipant(sessionId, review.reviewer)
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
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortControllerRef.current = null
      setIsLoading(false)
      setLoadingText("")
    }
  }, [runner, addMessage])

  const executeDebate = useCallback(async (prompt: string) => {
    if (!runner) return
    setIsLoading(true)
    setLoadingText("Starting debate...")
    setError(null)
    isDebatingRef.current = true
    const ac = new AbortController()
    abortControllerRef.current = ac
    try {
      addMessage("system", null, `Debate started. Agents are forming their initial positions...`)
      const result = await runner.debate(prompt, contextRef.current, {
        maxRounds: debateMaxRounds,
        signal: ac.signal,
        onRoundStart: (roundNum) => {
          setLoadingText(`Debate round ${roundNum} in progress...`)
        },
        onAgentStream: (agentName, token) => onStreamToken(agentName, token),
        onAgentComplete: (agentName) => clearLiveStream(agentName),
        onRoundComplete: async (roundNum, responses) => {
          setLoadingText(`Debate round ${roundNum} complete...`)
          for (const resp of responses) {
            addMessage("agent", resp.agent, `[Round ${roundNum}] ${resp.content}`)
          }
          if (stopDebateRef.current) {
            stopDebateRef.current = false
            return false
          }
          return undefined // auto-continue
        },
      })
      addMessage("agent", "synthesis", result.synthesis)
      const status = result.consensusReached
        ? `Consensus reached in ${result.roundCount} round(s).`
        : `Debate ended after ${result.roundCount} round(s) without full consensus.`
      addMessage("system", null, status)
      const suggestions = await runner.suggestFollowups(result.synthesis, prompt, "debate")
      if (suggestions.length > 0) {
        const opts = suggestions as { label: string; mode: Mode; prompt: string }[]
        setFollowupOptions(opts)
        const lines = opts.map((s, i) => `  ${i + 1}. [${s.mode}] ${s.label}`)
        addMessage("system", null, `What would you like to do next?\n${lines.join("\n")}\n\nEnter a number or type freely.`)
      }
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortControllerRef.current = null
      isDebatingRef.current = false
      stopDebateRef.current = false
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
        setIsLoading(true)
        setLoadingText("Checking agent availability...")
        try {
          const statuses = await Promise.all(
            agents.map(async a => ({
              name: a.name,
              available: await a.isAvailable().catch(() => false),
              isRouter: a.name === routerName,
            }))
          )
          const lines = statuses.map(s =>
            `  ${s.available ? "✓" : "✗"} ${s.name}${s.isRouter ? " (router)" : ""}`
          )
          addMessage("system", null, `Agents:\n${lines.join("\n")}`)
        } finally {
          setIsLoading(false)
          setLoadingText("")
        }
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

      case "review": {
        if (!runner) { setError("No runner available."); return }
        const msgs = contextRef.current
        const lastAgent = [...msgs].reverse().find(m => m.role === "agent")
        if (!lastAgent) { setError("No agent response to review."); return }
        const lastAgentIdx = msgs.lastIndexOf(lastAgent)
        const originalPrompt = [...msgs].slice(0, lastAgentIdx).reverse().find(m => m.role === "user")?.content ?? ""
        setIsLoading(true)
        setLoadingText("Reviewing last response...")
        try {
          addMessage("system", null, "Triggering peer review on last agent response...")
          const result = await runner.reviewContent(lastAgent.content, originalPrompt, {
            onReviewComplete: (review) => {
              sessionMgr.current.upsertParticipant(sessionId, review.reviewer)
              const verdict = review.verdict === "approved" ? "[APPROVED]" : "[CHANGES REQUESTED]"
              addMessage("agent", review.reviewer, `${verdict} ${review.content}`)
            },
          })
          addMessage("system", null, result.approved ? "All reviewers approved." : "Some reviewers requested changes.")
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setIsLoading(false)
          setLoadingText("")
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

      case "workflow": {
        const sub = args[0]

        if (!sub || sub === "list") {
          setIsLoading(true)
          setLoadingText("Loading workflows...")
          try {
            const { loadAllWorkflows } = await import("../workflows/loader.js")
            const workflows = await loadAllWorkflows()
            if (workflows.size === 0) {
              addMessage("system", null, "No workflows found.")
            } else {
              const lines = [...workflows.values()].map(w =>
                `  ${w.name}${w.description ? ` — ${w.description}` : ""} [${w.trust}]`
              )
              addMessage("system", null, `Available workflows:\n${lines.join("\n")}`)
            }
          } finally {
            setIsLoading(false)
            setLoadingText("")
          }
          break
        }

        if (sub === "show") {
          const name = args[1]
          if (!name) { setError("Usage: /workflow show <name>"); return }
          const { loadWorkflow } = await import("../workflows/loader.js")
          const wf = await loadWorkflow(name)
          if (!wf) { setError(`Workflow "${name}" not found.`); return }
          const lines = [
            `name: ${wf.name}`,
            wf.description ? `description: ${wf.description}` : null,
            `trust: ${wf.trust}`,
            `steps:`,
            ...wf.steps.map((s, i) =>
              `  ${i + 1}. [${s.agent ?? s.mode ?? "dispatch"}] ${s.task.slice(0, 80)}${s.task.length > 80 ? "..." : ""}${s.output ? ` → ${s.output}` : ""}`
            ),
          ].filter(Boolean)
          addMessage("system", null, lines.join("\n"))
          break
        }

        if (sub === "run") {
          const name = args[1]
          if (!name) { setError("Usage: /workflow run <name> [input]"); return }
          const input = args.slice(2).join(" ")
          const { loadWorkflow } = await import("../workflows/loader.js")
          const wf = await loadWorkflow(name)
          if (!wf) { setError(`Workflow "${name}" not found.`); return }
          if (!input) { setError("Usage: /workflow run <name> <input>"); return }

          const { WorkflowRunner } = await import("../workflows/runner.js")
          const wfRunner = new WorkflowRunner(registryRef.current, routerName)
          setIsLoading(true)
          addMessage("system", null, `Starting workflow: ${wf.name}`)
          try {
            const streamAgent = "workflow"
            let currentTaskId: string | null = null
            await wfRunner.run(wf, input, {
              onStepStart: (stepNum, total, agent, task) => {
                const dbTask = sessionMgr.current.createTask(sessionId, task, agent)
                currentTaskId = dbTask.id
                sessionMgr.current.updateTaskStatus(dbTask.id, "running")
                sessionMgr.current.upsertParticipant(sessionId, agent)
                setLoadingText(`Step ${stepNum}/${total}: ${agent}...`)
                addMessage("system", null, `Step ${stepNum}/${total} [${agent}]: ${task.slice(0, 120)}${task.length > 120 ? "..." : ""}`)
              },
              onStepComplete: (stepNum, _outputKey, content) => {
                if (currentTaskId) sessionMgr.current.updateTaskStatus(currentTaskId, "done")
                currentTaskId = null
                clearLiveStream(streamAgent)
                addMessage("agent", `step-${stepNum}`, content)
              },
              onStream: (token) => onStreamToken(streamAgent, token),
              onCheckpoint: (stepNum, total) => new Promise(resolve => {
                clearLiveStream(streamAgent)
                workflowCheckpointRef.current = resolve
                setAwaitingWorkflow(true)
                addMessage("system", null, `Step ${stepNum}/${total} complete. Continue to next step? (y/n)`)
              }),
            })
            addMessage("system", null, `Workflow "${wf.name}" complete.`)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          } finally {
            clearLiveStream("workflow")
            workflowCheckpointRef.current = null
            setAwaitingWorkflow(false)
            setIsLoading(false)
            setLoadingText("")
          }
          break
        }

        setError("Usage: /workflow <list|show|run> [args]")
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
          "  /review                                   — trigger peer review on last response",
          "  /workflow list                            — list available workflows",
          "  /workflow show <name>                     — show workflow steps",
          "  /workflow run <name> <input>              — run a workflow",
          "  /stop                                     — stop debate after current round",
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
          rerunCountRef.current++
          if (rerunCountRef.current > MAX_PIPELINE_RERUNS) {
            rerunCountRef.current = 0
            addMessage("system", null, `Maximum re-run limit (${MAX_PIPELINE_RERUNS}) reached.`)
          } else {
            addMessage("system", null, `Re-running with reviewer feedback... (attempt ${rerunCountRef.current}/${MAX_PIPELINE_RERUNS})`)
            await executePrompt(pendingPrompt)
          }
        } else {
          rerunCountRef.current = 0
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
      currentlyProcessingText.current = trimmed
      await executePrompt(trimmed)
      currentlyProcessingText.current = null
    }

    isProcessing.current = false
  }, [handleSlashCommand, routerName, executePrompt, addMessage, setAwaitingRerun])

  // --- Input submission --- queues message and kicks off processing
  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInputValue("")
    // Follow-up option selection
    if (followupOptions) {
      const n = parseInt(trimmed, 10)
      if (!isNaN(n) && n >= 1 && n <= followupOptions.length) {
        const chosen = followupOptions[n - 1]
        setFollowupOptions(null)
        setInputValue("")
        setMode(chosen.mode)
        addMessage("system", null, `Switching to ${chosen.mode} mode: ${chosen.label}`)
        messageQueue.current.push({ text: chosen.prompt, skipClassification: true })
        processQueue()
        return
      }
      setFollowupOptions(null)
    }
    // /stop during a debate bypasses the queue — signals the runner directly
    if (trimmed === "/stop" && isDebatingRef.current) {
      stopDebateRef.current = true
      addMessage("system", null, "Stopping debate after current round...")
      return
    }
    // Workflow checkpoint — resolve the waiting Promise directly
    if (workflowCheckpointRef.current) {
      const resolve = workflowCheckpointRef.current
      workflowCheckpointRef.current = null
      setAwaitingWorkflow(false)
      const yes = trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes"
      if (!yes) addMessage("system", null, "Workflow stopped.")
      resolve(yes)
      return
    }
    // Skip if this exact message is currently being processed or already queued
    if (trimmed === currentlyProcessingText.current) return
    const queue = messageQueue.current
    const lastEntry = queue.length > 0 ? queue[queue.length - 1] : null
    const lastText = lastEntry ? (typeof lastEntry === "string" ? lastEntry : lastEntry.text) : null
    if (lastText === trimmed) return
    // Show user message immediately for regular messages (not slash commands, not y/n answers)
    if (!parseSlash(trimmed) && rerunPromptRef.current === null) {
      addMessage("user", null, trimmed)
    }
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

      {Object.entries(liveStreams).map(([agent, content]) => (
        <Message key={`stream-${agent}`} message={{ role: "agent", agent, content: content + "▋" }} />
      ))}

      {isLoading && Object.keys(liveStreams).length === 0 && (
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
          placeholder={awaitingRerun ? "Re-run with reviewer feedback? (y/n)" : awaitingWorkflow ? "Continue to next step? (y/n)" : followupOptions ? `Choose 1–${followupOptions.length} or type freely...` : "Type a message or /help..."}
          suggestions={awaitingRerun || awaitingWorkflow || followupOptions ? [] : SLASH_SUGGESTIONS}
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
