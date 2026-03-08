import React from "react"
import { Box, Text } from "ink"
import type { Message as MessageType } from "../../core/adapters/types.js"

let Markdown: React.ComponentType<{ children: string }> | null = null
try {
  Markdown = require("ink-markdown").default
} catch {
  // ink-markdown not available; fall back to plain text
}

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
        {role === "agent" && Markdown ? (
          <Markdown>{content}</Markdown>
        ) : (
          <Text wrap="wrap">{content}</Text>
        )}
      </Box>
    </Box>
  )
}
