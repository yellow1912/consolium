import type { AgentAdapter, AgentResponse, Message } from "../adapters/types"

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

export class CouncilRunner {
  private router: AgentAdapter
  private adapters: AgentAdapter[]
  private modelOverrides: Record<string, string[]>

  constructor(input: { router: AgentAdapter; adapters: AgentAdapter[]; modelOverrides?: Record<string, string[]> }) {
    this.router = input.router
    this.adapters = input.adapters
    this.modelOverrides = input.modelOverrides ?? {}
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

  async council(prompt: string, context: Message[]): Promise<CouncilResult> {
    const respondents = this.adapters.filter(a => a.name !== this.router.name)
    const responses = await Promise.all(respondents.map(a => a.query(prompt, context)))
    const synthesisPrompt = [
      `You asked: "${prompt}"`,
      `Agent responses:`,
      ...responses.map(r => `[${r.agent}]: ${r.content}`),
      `Synthesize the best answer.`,
    ].join("\n")
    const synthesis = await this.router.query(synthesisPrompt, [])
    return { responses, synthesis: synthesis.content }
  }

  async dispatch(prompt: string, context: Message[]): Promise<AgentResponse> {
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
    return agent.query(prompt, context, { model: selection.model })
  }

  async pipeline(prompt: string, context: Message[]): Promise<PipelineResult> {
    // Router picks executor
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

    // Executor does the work
    const taskResp = await executor.query(prompt, context, { model: selection.model })

    // Peers review (everyone except executor and router)
    const reviewers = this.adapters.filter(a => a.name !== executor.name && a.name !== this.router.name)
    const reviewPrompt = [
      `Task: "${prompt}"`,
      `Result:\n${taskResp.content}`,
      `Review and respond with JSON only: { "verdict": "approved" | "changes_requested", "content": "<your feedback>" }`,
    ].join("\n")

    const reviews = await Promise.all(reviewers.map(async a => {
      const r = await a.query(reviewPrompt, [])
      try {
        const parsed = JSON.parse(r.content)
        return {
          reviewer: a.name,
          verdict: (parsed.verdict ?? "approved") as string,
          content: (parsed.content ?? r.content) as string,
        }
      } catch {
        return { reviewer: a.name, verdict: "approved", content: r.content }
      }
    }))

    return {
      taskContent: taskResp.content,
      reviews,
      approved: reviews.every(r => r.verdict === "approved"),
    }
  }

  async debate(
    prompt: string,
    context: Message[],
    options: { maxRounds?: number } = {},
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
        const resp = await a.query(
          `Debate topic: "${prompt}"\n\nGive your initial position.`,
          context,
        )
        return { agent: a.name, content: resp.content }
      })
    )
    rounds.push(round1)

    // Rounds 2+
    for (let round = 2; round <= maxRounds; round++) {
      const debateHistory = history()
      const roundResponses = await Promise.all(
        agents.map(async a => {
          const resp = await a.query(
            `Debate topic: "${prompt}"\n\nDebate so far:\n${debateHistory}\n\nDo you have anything to add or challenge? Respond with JSON only:\n{ "pass": true } if you have nothing new to add\n{ "pass": false, "content": "<your response>" } if you want to speak`,
            [],
          )
          try {
            const parsed = JSON.parse(resp.content)
            if (parsed.pass === true) return null
            return { agent: a.name, content: parsed.content as string }
          } catch {
            // agent didn't follow JSON format — treat as a response
            return { agent: a.name, content: resp.content }
          }
        })
      )
      const nonPass = roundResponses.filter((r): r is { agent: string; content: string } => r !== null)
      rounds.push(nonPass)

      if (nonPass.length === 0) {
        const synthesisPrompt = [
          `Debate topic: "${prompt}"`,
          `Full debate:\n${history()}`,
          `Consensus was reached. Synthesize the final position.`,
        ].join("\n")
        const synthesis = await this.router.query(synthesisPrompt, [])
        return { rounds, synthesis: synthesis.content, consensusReached: true, roundCount: round }
      }
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
