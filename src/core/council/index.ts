import type { AgentAdapter, AgentResponse, Message, QueryOptions } from "../adapters/types"

export type CouncilResult = {
  responses: AgentResponse[]
  synthesis: string
}

export type PipelineResult = {
  taskContent: string
  reviews: { reviewer: string; verdict: string; content: string }[]
  approved: boolean
}

export type DebateRound = { agent: string; content: string }[]

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
  ): Promise<AgentResponse> {
    const agentSessionId = this.getStoredSessionId(agent.name)
    const isResume = agentSessionId !== undefined
    const deltaPrompt = isResume ? this.buildDeltaMessage(prompt, context, agent.name) : prompt
    const options: QueryOptions = {
      model,
      agentSessionId,
      systemPrompt: isResume ? undefined : this.buildSystemPrompt(agent.name, mode),
    }
    const resp = isResume
      ? await agent.query(deltaPrompt, [], options)
      : await agent.query(prompt, context, options)
    if (resp.sessionId) this.saveSessionId(agent.name, resp.sessionId)
    return resp
  }

  private async getAgentModelPrompt(): Promise<string> {
    const lines = await Promise.all(this.adapters.map(async a => {
      const cached = this.modelOverrides[a.name]
      const modelIds = cached && cached.length > 0
        ? cached
        : (await a.getModels()).map(m => m.id)
      return `- ${a.name}: [${modelIds.join(", ")}]`
    }))
    return lines.join("\n")
  }

  async council(prompt: string, context: Message[], options?: {
    onAgentComplete?: (response: AgentResponse) => void
  }): Promise<CouncilResult> {
    const respondents = this.adapters.filter(a => a.name !== this.router.name)
    const responses = await Promise.all(respondents.map(async a => {
      const resp = await this.queryAgent(a, prompt, context, "council")
      options?.onAgentComplete?.(resp)
      return resp
    }))
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
  }): Promise<AgentResponse> {
    const agentModels = await this.getAgentModelPrompt()
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents & models:\n${agentModels}\nRespond with JSON only: { "assignTo": "<agent name>", "model": "<model id>" }`,
      context,
    )
    let selection: { assignTo: string, model?: string }
    try {
      selection = JSON.parse(routerResp.content)
    } catch {
      selection = { assignTo: this.adapters[0]?.name ?? this.router.name }
    }
    const agent = this.adapters.find(a => a.name === selection.assignTo) ?? this.adapters[0]
    if (!agent) throw new Error("No agent available for dispatch")
    options?.onRouted?.(agent.name, selection.model)
    return this.queryAgent(agent, prompt, context, "dispatch", selection.model)
  }

  async pipeline(prompt: string, context: Message[], options?: {
    onRouted?: (executor: string, model?: string) => void
    onExecutorComplete?: (content: string) => void
    onReviewComplete?: (review: { reviewer: string; verdict: string; content: string }) => void
  }): Promise<PipelineResult> {
    // Router picks executor (routing call — direct, no session tracking)
    const agentModels = await this.getAgentModelPrompt()
    const routerResp = await this.router.query(
      `Task: "${prompt}"\nAvailable agents & models:\n${agentModels}\nRespond with JSON only: { "assignTo": "<agent name>", "model": "<model id>" }`,
      context,
    )
    let selection: { assignTo: string, model?: string }
    try {
      selection = JSON.parse(routerResp.content)
    } catch {
      selection = { assignTo: this.adapters[0]?.name ?? this.router.name }
    }
    const executor = this.adapters.find(a => a.name === selection.assignTo) ?? this.adapters[0]
    if (!executor) throw new Error("No executor agent available")
    options?.onRouted?.(executor.name, selection.model)

    // Executor does the work
    const taskResp = await this.queryAgent(executor, prompt, context, "pipeline", selection.model)
    options?.onExecutorComplete?.(taskResp.content)

    // Peers review (everyone except executor and router)
    const reviewers = this.adapters.filter(a => a.name !== executor.name && a.name !== this.router.name)
    const reviewPrompt = [
      `Task: "${prompt}"`,
      `Result:\n${taskResp.content}`,
      `Review and respond with JSON only: { "verdict": "approved" | "changes_requested", "content": "<your feedback>" }`,
    ].join("\n")

    const reviews = await Promise.all(reviewers.map(async a => {
      const r = await this.queryAgent(a, reviewPrompt, [], "pipeline") // reviewers get full task+result in prompt, not from context
      let review: { reviewer: string; verdict: string; content: string }
      try {
        const parsed = JSON.parse(r.content)
        review = {
          reviewer: a.name,
          verdict: (parsed.verdict ?? "approved") as string,
          content: (parsed.content ?? r.content) as string,
        }
      } catch {
        review = { reviewer: a.name, verdict: "approved", content: r.content }
      }
      options?.onReviewComplete?.(review)
      return review
    }))

    return {
      taskContent: taskResp.content,
      reviews,
      approved: reviews.every(r => r.verdict === "approved"),
    }
  }

  async reviewContent(
    taskContent: string,
    originalPrompt: string,
    options?: {
      onReviewComplete?: (review: { reviewer: string; verdict: string; content: string }) => void
    },
  ): Promise<{ reviews: { reviewer: string; verdict: string; content: string }[]; approved: boolean }> {
    const reviewers = this.adapters.filter(a => a.name !== this.router.name)
    const reviewPrompt = [
      `Task: "${originalPrompt}"`,
      `Result:\n${taskContent}`,
      `Review and respond with JSON only: { "verdict": "approved" | "changes_requested", "content": "<your feedback>" }`,
    ].join("\n")
    const reviews = await Promise.all(reviewers.map(async a => {
      const r = await this.queryAgent(a, reviewPrompt, [], "pipeline")
      let review: { reviewer: string; verdict: string; content: string }
      try {
        const parsed = JSON.parse(r.content)
        review = {
          reviewer: a.name,
          verdict: (parsed.verdict ?? "approved") as string,
          content: (parsed.content ?? r.content) as string,
        }
      } catch {
        review = { reviewer: a.name, verdict: "approved", content: r.content }
      }
      options?.onReviewComplete?.(review)
      return review
    }))
    return { reviews, approved: reviews.every(r => r.verdict === "approved") }
  }

  async debate(
    prompt: string,
    context: Message[],
    options: {
      maxRounds?: number
      onRoundComplete?: (roundNum: number, responses: DebateRound) => Promise<boolean | undefined>
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
    const round1 = await Promise.all(
      agents.map(async a => {
        const resp = await this.queryAgent(
          a,
          `Debate topic: "${prompt}"\n\nGive your initial position.`,
          context,
          "debate",
        )
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
      const debateHistory = history()
      const roundResponses = await Promise.all(
        agents.map(async a => {
          const resp = await this.queryAgent(
            a,
            `Debate topic: "${prompt}"\n\nDebate so far:\n${debateHistory}\n\nDo you have anything to add or challenge? Respond with JSON only:\n{ "pass": true } if you have nothing new to add\n{ "pass": false, "content": "<your response>" } if you want to speak`,
            [], // debate history is embedded in the prompt string above; user context history is not relevant here
            "debate",
          )
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
}
