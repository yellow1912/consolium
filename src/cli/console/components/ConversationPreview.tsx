import React from "react"
import { Box, Text } from "ink"
import type { AgentRegistryEntry } from "../../../core/agent-monitor/types.js"
import type { ConversationMessage } from "../hooks/useAgentConversation.js"

interface Props {
  agent: AgentRegistryEntry | undefined
  messages: ConversationMessage[]
  height: number
}

export function ConversationPreview({ agent, messages, height }: Props) {
  const label = agent ? `${agent.name} (${agent.type} pid:${agent.pid})` : "No agent selected"
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray">
      <Text bold color="cyan"> {label}</Text>
      {messages.length === 0 && <Text color="gray">  No conversation history</Text>}
      {messages.slice(-(height - 4)).map((msg, i) => (
        <Box key={i} marginLeft={1}>
          <Text color={msg.role === "user" ? "yellow" : "green"}>
            [{msg.role === "user" ? "you" : "agent"}] {msg.content.slice(0, 120)}{msg.content.length > 120 ? "…" : ""}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
