import React from "react"
import { Box, Text } from "ink"
import type { Message as MessageType } from "../../core/adapters/types.js"

function getSenderColor(role: MessageType["role"], agent: string | null): string {
  if (role === "user") return "green"
  if (role === "system") return "gray"
  if (agent === "synthesis") return "magenta"
  if (agent === "pipeline" || agent === "debate") return "yellow"
  return "blue"
}

function getSenderName(role: MessageType["role"], agent: string | null): string {
  if (role === "user") return "you"
  return agent ?? role
}

export type MessageProps = {
  message: MessageType
  key?: React.Key
}

export default function Message({ message }: MessageProps) {
  const { role, agent, content } = message
  const color = getSenderColor(role, agent)
  const sender = getSenderName(role, agent)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>● {sender}</Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  )
}
