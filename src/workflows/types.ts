export type TrustLevel = "autonomous" | "checkpoint"

export type WorkflowStep = {
  agent?: string
  mode?: "council" | "dispatch" | "pipeline" | "debate"
  task: string
  output?: string
}

export type WorkflowDef = {
  name: string
  description?: string
  trust: TrustLevel
  steps: WorkflowStep[]
}
