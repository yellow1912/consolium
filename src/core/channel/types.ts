export interface ChannelConfig {
  name: string
  type: "telegram"
  botToken: string
  chatId: string
  agentId: string     // agent name or PID to route messages to
  createdAt: string
}
