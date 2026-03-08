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
}
