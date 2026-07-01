import type { AgentAdapter, AgentResponse, Message, QueryOptions } from "../adapters/types"
import { buildBoundedContextPrompt } from "../adapters/context"
import { extractJson, dispatchSelectionSchema, workflowPlanSchema, pipelineReviewSchema } from "./router-utils"
import type { WorkflowPlan } from "./router-utils"

export type CouncilResult = {
  responses: AgentResponse[]
  synthesis: string
}

export type PipelineReview = {
  reviewer: string
  verdict: string
  content: string
  verificationEvidence?: string
  metadata?: {
    fallbackReason?: string
  }
}

const TRIVIAL_PATTERNS = [
  /should work now/i,
  /previous run show/i,
  /it should pass/i,
  /looks good/i,
  /trust me/i,
]

const TERMINAL_MARKERS = ["$", ">", "exit", "Error", "✓", "✗", "PASS", "FAIL", "0 failures", "`"]

export function isEvidenceTrivial(evidence: string): boolean {
  const hasTerminalOutput =
    TERMINAL_MARKERS.some(m => evidence.includes(m)) || /\d+ms/.test(evidence)
  if (hasTerminalOutput) return false
  return TRIVIAL_PATTERNS.some(p => p.test(evidence))
}

export function applyEvidenceGate(
  requiresVerification: boolean | undefined,
  verdict: "approved" | "changes_requested",
  verificationEvidence: string | undefined,
): { verdict: "approved" | "changes_requested"; downgraded: boolean } {
  if (!requiresVerification || verdict !== "approved") {
    return { verdict, downgraded: false }
  }
  if (!verificationEvidence || verificationEvidence.trim() === "" || isEvidenceTrivial(verificationEvidence)) {
    return { verdict: "changes_requested", downgraded: true }
  }
  return { verdict, downgraded: false }
}

export function getVerificationFallbackVerdict(requiresVerification?: boolean): "approved" | "changes_requested" {
  return requiresVerification ? "changes_requested" : "approved"
}

export type WorkflowStepResult = {
  stepIndex: number
  agent: string
  content: string
}

export type PipelineResult = {
  taskContent: string
  reviews: PipelineReview[]
  approved: boolean
  iterationCount: number
  workflowSteps?: WorkflowStepResult[]
}

export type DebateRound = { agent: string; content: string }[]

export type ReviewFinding = {
  angle: string
  reviewer: string
  content: string
}

export type ReviewResult = {
  findings: ReviewFinding[]
  synthesis: string
}

export type DebateResult = {
  rounds: DebateRound[]
  synthesis: string
  consensusReached: boolean
  roundCount: number
}

export type AgentSessionStore = {
  getAgentSession(masterSessionId: string, agentName: string): string | null
  setAgentSession(masterSessionId: string, agentName: string, agentSessionId: string): void
}

export class CouncilRunner {
  private router: AgentAdapter
  private adapters: AgentAdapter[]
  private modelOverrides: Record<string, string[]>
  private modelCache = new Map<string, string[]>()
  private masterSessionId?: string
  private sessionStore?: AgentSessionStore

  constructor(input: {
    router: AgentAdapter
    adapters: AgentAdapter[]
    modelOverrides?: Record<string, string[]>
    masterSessionId?: string
    sessionStore?: AgentSessionStore
  }) {
    this.router = input.router
    this.adapters = input.adapters
    this.modelOverrides = input.modelOverrides ?? {}
    this.masterSessionId = input.masterSessionId
    this.sessionStore = input.sessionStore
  }

  private getStoredSessionId(agentName: string): string | undefined {
    if (!this.masterSessionId || !this.sessionStore) return undefined
    return this.sessionStore.getAgentSession(this.masterSessionId, agentName) ?? undefined
  }

  private saveSessionId(agentName: string, sessionId: string): void {
    if (!this.masterSessionId || !this.sessionStore) return
    this.sessionStore.setAgentSession(this.masterSessionId, agentName, sessionId)
  }

  private buildSystemPrompt(agentName: string, mode: string): string {
    const peers = this.adapters
      .map(a => a.name)
      .filter(n => n !== agentName)
    return `You are ${agentName} in a multi-agent discussion with ${peers.join(", ")}. Mode: ${mode}. Build on peer responses when provided.`
  }

  private buildDeltaMessage(userMessage: string, context: Message[], excludeAgent?: string): string {
    let lastUserIdx = -1
    for (let i = context.length - 1; i >= 0; i--) {
      if (context[i].role === "user") { lastUserIdx = i; break }
    }
    if (lastUserIdx < 0) return userMessage

    const peerResponses = context
      .slice(lastUserIdx + 1)
      .filter(m => m.role === "agent" && m.agent && m.agent !== excludeAgent)

    if (peerResponses.length === 0) return userMessage

    const peers = peerResponses.map(r => `[${r.agent}]: ${r.content}`).join("\n")
    return `[User]: ${userMessage}\n\n[Peer responses]:\n${peers}\n\nYour response:`
  }

  private async queryAgent(
    agent: AgentAdapter,
    prompt: string,
    context: Message[],
    mode: string,
    model?: string,
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const agentSessionId = this.getStoredSessionId(agent.name)
    const isResume = agentSessionId !== undefined
    const deltaPrompt = isResume ? this.buildDeltaMessage(prompt, context, agent.name) : prompt
    const options: QueryOptions = {
      model,
      agentSessionId,
      systemPrompt: isResume ? undefined : this.buildSystemPrompt(agent.name, mode),
      signal,
    }

    const compiledPrompt = isResume ? deltaPrompt : buildBoundedContextPrompt(prompt, context)
    const promptChars = compiledPrompt.length
    const estimatedPromptTokens = Math.ceil(promptChars / 4)

    const populateMetadata = (r: AgentResponse) => {
      const responseChars = r.content.length
      const estimatedResponseTokens = Math.ceil(responseChars / 4)
      r.metadata = {
        promptChars,
        responseChars,
        estimatedPromptTokens,
        estimatedResponseTokens,
        selectedModel: model ?? undefined,
        routedAgent: agent.name,
        ...r.metadata,
      }
    }

    if (onToken && agent.queryStream) {
      const start = Date.now()
      const effectiveContext = isResume ? [] : context
      let content = ""
      for await (const token of agent.queryStream(deltaPrompt, effectiveContext, options)) {
        content += token
        onToken(token)
      }
      const sessionId = agent.lastSessionId
      const resp: AgentResponse = { agent: agent.name, content: content.trim(), durationMs: Date.now() - start, sessionId }
      if (resp.sessionId) this.saveSessionId(agent.name, resp.sessionId)
      populateMetadata(resp)
      return resp
    }

    const resp = isResume
      ? await agent.query(deltaPrompt, [], options)
      : await agent.query(prompt, context, options)
    if (resp.sessionId) this.saveSessionId(agent.name, resp.sessionId)
    populateMetadata(resp)
    return resp
  }

  private async getAgentModelPrompt(): Promise<string> {
    const lines = await Promise.all(this.adapters.map(async a => {
      const overrides = this.modelOverrides[a.name]
      if (overrides && overrides.length > 0) return `- ${a.name}: [${overrides.join(", ")}]`
      let ids = this.modelCache.get(a.name)
      if (!ids) {
        ids = (await a.getModels()).map(m => m.id)
        this.modelCache.set(a.name, ids)
      }
      return `- ${a.name}: [${ids.join(", ")}]`
    }))
    return lines.join("\n")
  }

  async council(prompt: string, context: Message[], options?: {
    onAgentComplete?: (response: AgentResponse) => void
    onAgentError?: (agentName: string, error: Error) => void
    onAgentStream?: (agentName: string, token: string) => void
    signal?: AbortSignal
  }): Promise<CouncilResult> {
    const respondents = this.adapters.filter(a => a.name !== this.router.name)
    const settled = await Promise.allSettled(respondents.map(async a => {
      const onToken = options?.onAgentStream ? (token: string) => options.onAgentStream!(a.name, token) : undefined
      // Context isolation: sub-agents reason independently, no shared history
      const resp = await this.queryAgent(a, prompt, [], "council", undefined, onToken, options?.signal)
      options?.onAgentComplete?.(resp)
      return resp
    }))
    const responses: AgentResponse[] = []
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        responses.push(result.value)
      } else {
        const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        options?.onAgentError?.(respondents[i].name, err)
      }
    })
    if (responses.length === 0) throw new Error("All agents failed to respond")
    const synthesisPrompt = [
      `You asked: "${prompt}"`,
      `Agent responses:`,
      ...responses.map(r => `[${r.agent}]: ${r.content}`),
      `Synthesize the best answer.`,
    ].join("\n")
    const synthesis = await this.router.query(synthesisPrompt, [])
    return { responses, synthesis: synthesis.content }
  }

  async dispatch(prompt: string, context: Message[], options?: {
    onRouted?: (agent: string, model?: string) => void
    onStream?: (token: string) => void
    signal?: AbortSignal
  }): Promise<AgentResponse> {
    const agentModels = await this.getAgentModelPrompt()
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents & models:\n${agentModels}\nRespond with JSON only: { "assignTo": "<agent name>", "model": "<model id>", "subPrompt": "<tailored prompt optimized for that agent's strengths>" }`,
      context,
    )
    let selection: { assignTo: string, model?: string, subPrompt?: string }
    let fallbackReason: string | undefined
    try {
      const parsed = extractJson(routerResp.content)
      const validated = dispatchSelectionSchema.parse(parsed)
      const exists = this.adapters.some(a => a.name === validated.assignTo)
      if (!exists) {
        throw new Error(`Agent '${validated.assignTo}' not found in active adapters`)
      }
      selection = validated
    } catch (e: any) {
      fallbackReason = e.message || String(e)
      selection = { assignTo: this.adapters[0]?.name ?? this.router.name }
    }
    const agent = this.adapters.find(a => a.name === selection.assignTo) ?? this.adapters[0]
    if (!agent) throw new Error("No agent available for dispatch")
    options?.onRouted?.(agent.name, selection.model)
    // Context isolation: sub-agent gets tailored prompt only, not full conversation history
    const resp = await this.queryAgent(agent, selection.subPrompt ?? prompt, [], "dispatch", selection.model, options?.onStream, options?.signal)
    if (fallbackReason) {
      resp.metadata = {
        ...resp.metadata,
        fallbackReason,
      }
    }
    return resp
  }

  async pipeline(prompt: string, context: Message[], options?: {
    onRouted?: (executor: string, model?: string) => void
    onExecutorStream?: (token: string) => void
    onExecutorComplete?: (content: string) => void
    onReviewComplete?: (review: PipelineReview) => void
    onIterationStart?: (iteration: number) => void
    onIterationComplete?: (iteration: number, approved: boolean) => void
    onWorkflowPlan?: (plan: WorkflowPlan) => void
    onStepStart?: (stepIndex: number, total: number, agentName: string) => void
    onStepComplete?: (result: WorkflowStepResult) => void
    maxIterations?: number
    requiresVerification?: boolean
    signal?: AbortSignal
  }): Promise<PipelineResult> {
    const maxIterations = options?.maxIterations ?? 1

    // Router generates a multi-step workflow plan (planned once, reused across correction iterations)
    const agentModels = await this.getAgentModelPrompt()
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents & models:\n${agentModels}\n\nDesign an agentic workflow of 1–5 steps. For each step specify the agent, a tailored subtask prompt, and which prior step indices this agent may see (canSee: [] = fully isolated). Only include indices in canSee when the agent genuinely needs that prior output.\nRespond with JSON only:\n{ "steps": [{ "agent": "<name>", "model": "<model id>", "subPrompt": "<tailored instructions>", "canSee": [<prior step indices>] }] }`,
      context,
    )

    let plan: WorkflowPlan
    let planFallbackReason: string | undefined
    try {
      const parsed = extractJson(routerResp.content)
      plan = workflowPlanSchema.parse(parsed)
      for (const step of plan.steps) {
        if (!this.adapters.some(a => a.name === step.agent)) {
          throw new Error(`Agent '${step.agent}' not found in active adapters`)
        }
      }
    } catch (e: any) {
      planFallbackReason = e.message || String(e)
      const fallback = this.adapters.find(a => a.name !== this.router.name) ?? this.adapters[0]
      if (!fallback) throw new Error("No executor agent available — adapters list is empty")
      plan = { steps: [{ agent: fallback.name, subPrompt: prompt, canSee: [] }] }
    }
    options?.onWorkflowPlan?.(plan)

    // Reviewers are adapters not assigned in any workflow step (and not the router).
    // Fall back to the router when all non-router agents are consumed by the plan.
    const planAgentNames = new Set(plan.steps.map(s => s.agent))
    const reviewers = this.adapters.filter(a => a.name !== this.router.name && !planAgentNames.has(a.name))
    const effectiveReviewers = reviewers.length > 0 ? reviewers : [this.router]

    let taskContent = ""
    let reviews: PipelineReview[] = []
    let approved = false
    let workflowSteps: WorkflowStepResult[] | undefined
    let rewritePrompt = ""
    let actualIterations = 0

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      actualIterations = iteration
      options?.onIterationStart?.(iteration)

      if (iteration === 1) {
        // Execute full multi-step workflow with per-step access list isolation
        const stepResults: WorkflowStepResult[] = []
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]
          const agent = this.adapters.find(a => a.name === step.agent)
          if (!agent) continue
          options?.onStepStart?.(i, plan.steps.length, agent.name)
          options?.onRouted?.(agent.name, step.model)

          // Build context strictly from access list indices
          const allowedContext: Message[] = step.canSee
            .filter(idx => idx >= 0 && idx < i && stepResults[idx] != null)
            .map(idx => ({ role: "agent" as const, agent: stepResults[idx].agent, content: stepResults[idx].content }))

          const isLastStep = i === plan.steps.length - 1
          const onToken = isLastStep ? options?.onExecutorStream : undefined
          const resp = await this.queryAgent(agent, step.subPrompt, allowedContext, "pipeline", step.model, onToken, options?.signal)
          if (i === 0 && planFallbackReason) resp.metadata = { ...resp.metadata, fallbackReason: planFallbackReason }

          const result: WorkflowStepResult = { stepIndex: i, agent: agent.name, content: resp.content }
          stepResults.push(result)
          options?.onStepComplete?.(result)
        }
        workflowSteps = stepResults

        // Single step: pass through. Multi-step: router synthesizes all outputs.
        if (stepResults.length === 1) {
          taskContent = stepResults[0].content
        } else {
          const synthesisPrompt = [
            `Task: "${prompt}"`,
            `Workflow outputs:`,
            ...stepResults.map((r, idx) => `[Step ${idx + 1} — ${r.agent}]: ${r.content}`),
            `Synthesize these into the final answer.`,
          ].join("\n")
          taskContent = (await this.router.query(synthesisPrompt, [])).content
        }
        options?.onExecutorComplete?.(taskContent)
      } else {
        // Correction iteration: last plan step's agent rewrites with reviewer feedback
        const lastStep = plan.steps[plan.steps.length - 1]
        const rewriteAgent = this.adapters.find(a => a.name === lastStep.agent)
        if (!rewriteAgent) throw new Error(`Rewrite agent '${lastStep.agent}' is no longer available in the adapter pool`)
        options?.onRouted?.(rewriteAgent.name, lastStep.model)
        const resp = await this.queryAgent(rewriteAgent, rewritePrompt, [], "pipeline", lastStep.model, options?.onExecutorStream, options?.signal)
        taskContent = resp.content
        if (workflowSteps) {
          workflowSteps = [...workflowSteps, { stepIndex: workflowSteps.length, agent: rewriteAgent.name, content: taskContent }]
        }
        options?.onExecutorComplete?.(taskContent)
      }

      // Review phase (effectiveReviewers = plan-external agents, or router as fallback)
      {
        const requiresVerification = options?.requiresVerification
        const jsonFormat = requiresVerification
          ? `{ "verdict": "approved" | "changes_requested", "content": "<your feedback>", "verificationEvidence": "<actual command output and exit code>" }`
          : `{ "verdict": "approved" | "changes_requested", "content": "<your feedback>" }`
        const verificationInstruction = requiresVerification
          ? `\nThis step requires verification evidence. You MUST include a \`verificationEvidence\` field in your JSON response containing the actual command output and exit code. Phrases like "should work now" or "previous run showed OK" without command output are NOT acceptable evidence.`
          : ""
        const reviewPrompt = [
          `Task: "${prompt}"`,
          `Result:\n${taskContent}`,
          `Review and respond with JSON only: ${jsonFormat}${verificationInstruction}`,
        ].join("\n")
        const reviewSettled = await Promise.allSettled(effectiveReviewers.map(async a => {
          const r = await this.queryAgent(a, reviewPrompt, [], "pipeline")
          let review: PipelineReview
          let reviewFallbackReason: string | undefined
          try {
            const parsed = extractJson(r.content)
            const validated = pipelineReviewSchema.parse(parsed)
            const gated = applyEvidenceGate(requiresVerification, validated.verdict, validated.verificationEvidence)
            const finalContent = gated.downgraded
              ? `${validated.content}\n\n[Auto-downgraded: verification evidence required but not provided]`
              : validated.content
            review = { reviewer: a.name, verdict: gated.verdict, content: finalContent, verificationEvidence: validated.verificationEvidence }
          } catch (e: any) {
            reviewFallbackReason = e.message || String(e)
            review = { reviewer: a.name, verdict: getVerificationFallbackVerdict(requiresVerification), content: r.content, metadata: { fallbackReason: reviewFallbackReason } }
          }
          options?.onReviewComplete?.(review)
          return review
        }))
        reviews = reviewSettled
          .filter((r): r is PromiseFulfilledResult<PipelineReview> => r.status === "fulfilled")
          .map(r => r.value)
      }

      approved = reviews.length === 0 || reviews.every(r => r.verdict === "approved")
      options?.onIterationComplete?.(iteration, approved)
      if (approved || iteration === maxIterations) break

      // Build rewrite prompt for correction iteration
      const feedback = reviews
        .filter(r => r.verdict === "changes_requested")
        .map(r => `[${r.reviewer}]: ${r.content}`)
        .join("\n")
      rewritePrompt = [
        `Original task: "${prompt}"`,
        `Your previous attempt:\n${taskContent}`,
        `Reviewer feedback:\n${feedback}`,
        `Rewrite your answer addressing the feedback above.`,
      ].join("\n\n")
    }

    return { taskContent, reviews, approved, iterationCount: actualIterations, workflowSteps }
  }

  async reviewContent(
    taskContent: string,
    originalPrompt: string,
    options?: {
      onReviewComplete?: (review: PipelineReview) => void
    },
  ): Promise<{ reviews: PipelineReview[]; approved: boolean }> {
    const reviewers = this.adapters.filter(a => a.name !== this.router.name)
    const reviewPrompt = [
      `Task: "${originalPrompt}"`,
      `Result:\n${taskContent}`,
      `Review and respond with JSON only: { "verdict": "approved" | "changes_requested", "content": "<your feedback>" }`,
    ].join("\n")
    const settled = await Promise.allSettled(reviewers.map(async a => {
      const r = await this.queryAgent(a, reviewPrompt, [], "pipeline")
      let review: PipelineReview
      let reviewFallbackReason: string | undefined
      try {
        const parsed = extractJson(r.content)
        const validated = pipelineReviewSchema.parse(parsed)
        review = {
          reviewer: a.name,
          verdict: validated.verdict,
          content: validated.content,
        }
      } catch (e: any) {
        reviewFallbackReason = e.message || String(e)
        review = {
          reviewer: a.name,
          verdict: "approved",
          content: r.content,
          metadata: {
            fallbackReason: reviewFallbackReason,
          },
        }
      }
      options?.onReviewComplete?.(review)
      return review
    }))
    const reviews = settled
      .filter((r): r is PromiseFulfilledResult<PipelineReview> => r.status === "fulfilled")
      .map(r => r.value)
    return { reviews, approved: reviews.every(r => r.verdict === "approved") }
  }

  async suggestFollowups(
    synthesis: string,
    originalPrompt: string,
    completedMode: string,
  ): Promise<{ label: string; mode: string; prompt: string }[]> {
    const resp = await this.router.query(
      `A "${completedMode}" session just completed.\nOriginal topic: "${originalPrompt}"\nSynthesis: ${synthesis}\n\nSuggest 2-3 natural follow-up actions the user might want to take next.\nAvailable modes: council (multiple perspectives), debate (argue positions), pipeline (build+review), dispatch (single agent task).\n\nRespond with JSON only:\n{ "suggestions": [{ "label": "<short action label>", "mode": "<mode>", "prompt": "<the actual prompt to run>" }] }`,
      [],
    )
    try {
      const parsed = JSON.parse(resp.content)
      return Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    } catch {
      return []
    }
  }

  async debate(
    prompt: string,
    context: Message[],
    options: {
      maxRounds?: number
      onRoundStart?: (roundNum: number) => void
      onAgentStream?: (agentName: string, token: string) => void
      onAgentComplete?: (agentName: string) => void
      onRoundComplete?: (roundNum: number, responses: DebateRound) => Promise<boolean | undefined>
      signal?: AbortSignal
    } = {},
  ): Promise<DebateResult> {
    const maxRounds = options.maxRounds ?? 5
    const rounds: DebateRound[] = []
    const agents = this.adapters.filter(a => a.name !== this.router.name)

    const history = (): string =>
      rounds.flatMap((round, i) =>
        round.map(r => `[Round ${i + 1}] [${r.agent}]: ${r.content}`)
      ).join("\n")

    // Round 1: all agents give their initial response (plain text, no pass/fail)
    options.onRoundStart?.(1)
    const round1 = await Promise.all(
      agents.map(async a => {
        const onToken = options.onAgentStream ? (token: string) => options.onAgentStream!(a.name, token) : undefined
        const resp = await this.queryAgent(
          a,
          `Debate topic: "${prompt}"\n\nGive your initial position.`,
          [], // context isolation: debate agents reason from the topic only
          "debate",
          undefined,
          onToken,
          options.signal,
        )
        options.onAgentComplete?.(a.name)
        return { agent: a.name, content: resp.content }
      })
    )
    rounds.push(round1)

    if (options.onRoundComplete) {
      const cont = await options.onRoundComplete(1, round1)
      if (cont === false) {
        const synthesis = await this.router.query(
          `Debate topic: "${prompt}"\n\nFull debate:\n${history()}\n\nSynthesize the best conclusion.`,
          [],
        )
        return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: rounds.length }
      }
    }

    // Rounds 2+
    for (let round = 2; round <= maxRounds; round++) {
      options.onRoundStart?.(round)
      const debateHistory = history()
      const roundResponses = await Promise.all(
        agents.map(async a => {
          const onToken = options.onAgentStream ? (token: string) => options.onAgentStream!(a.name, token) : undefined
          const resp = await this.queryAgent(
            a,
            `Debate topic: "${prompt}"\n\nDebate so far:\n${debateHistory}\n\nDo you have anything to add or challenge? Respond with JSON only:\n{ "pass": true } if you have nothing new to add\n{ "pass": false, "content": "<your response>" } if you want to speak`,
            [], // debate history is embedded in the prompt string above; user context history is not relevant here
            "debate",
            undefined,
            onToken,
            options.signal,
          )
          options.onAgentComplete?.(a.name)
          try {
            const parsed = JSON.parse(resp.content)
            if (parsed.pass === true) return null
            return { agent: a.name, content: (parsed.content as string) ?? "" }
          } catch {
            // agent didn't follow JSON format — treat as a response
            return { agent: a.name, content: resp.content }
          }
        })
      )
      const nonPass = roundResponses.filter((r): r is { agent: string; content: string } => r !== null)

      if (options.onRoundComplete) {
        const cont = await options.onRoundComplete(round, nonPass)
        if (cont === false) {
          if (nonPass.length > 0) rounds.push(nonPass)
          const synthesis = await this.router.query(
            `Debate topic: "${prompt}"\n\nFull debate:\n${history()}\n\nSynthesize the best conclusion.`,
            [],
          )
          return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: rounds.length }
        }
      }

      if (nonPass.length === 0) {
        // All agents passed — consensus
        const synthesisPrompt = [
          `Debate topic: "${prompt}"`,
          `Full debate:\n${history()}`,
          `Consensus was reached. Synthesize the final position.`,
        ].join("\n")
        const synthesis = await this.router.query(synthesisPrompt, [])
        return { rounds, synthesis: synthesis.content, consensusReached: true, roundCount: round }
      }

      rounds.push(nonPass)
    }

    // Max rounds reached
    const synthesisPrompt = [
      `Debate topic: "${prompt}"`,
      `Full debate:\n${history()}`,
      `The debate reached the maximum number of rounds (${maxRounds}). Synthesize the best conclusion from what was said.`,
    ].join("\n")
    const synthesis = await this.router.query(synthesisPrompt, [])
    return { rounds, synthesis: synthesis.content, consensusReached: false, roundCount: maxRounds }
  }

  async review(content: string, context: Message[], options?: {
    angles?: string[]
    onAngleComplete?: (finding: ReviewFinding) => void
    signal?: AbortSignal
  }): Promise<ReviewResult> {
    const angles = options?.angles ?? [
      "correctness and bugs",
      "security vulnerabilities",
      "performance",
      "maintainability and code quality",
    ]
    const reviewers = this.adapters.length > 0 ? this.adapters : [this.router]

    const settled = await Promise.allSettled(angles.map(async (angle, i) => {
      const reviewer = reviewers[i % reviewers.length]
      const prompt = `Review the following code for ${angle}. List specific findings with severity (critical/high/medium/low) and line references where applicable. Be concise.\n\n${content}`
      const resp = await this.queryAgent(reviewer, prompt, [], "review", undefined, undefined, options?.signal)
      const finding: ReviewFinding = { angle, reviewer: reviewer.name, content: resp.content }
      options?.onAngleComplete?.(finding)
      return finding
    }))

    const findings = settled
      .filter((r): r is PromiseFulfilledResult<ReviewFinding> => r.status === "fulfilled")
      .map(r => r.value)

    if (findings.length === 0) throw new Error("All review angles failed")

    const synthesisPrompt = [
      `Code review findings across ${findings.length} dimensions:`,
      ...findings.map(f => `[${f.angle}]:\n${f.content}`),
      `Synthesize into a ranked findings list. Most critical first. Remove duplicates. Include line references where available.`,
    ].join("\n\n")

    const synthesis = await this.router.query(synthesisPrompt, [])
    return { findings, synthesis: synthesis.content }
  }
}
