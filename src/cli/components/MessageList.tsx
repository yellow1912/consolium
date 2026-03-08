import React from "react"
import { Box, Text } from "ink"
import type { Message as MessageType } from "../../core/adapters/types.js"
import Message from "./Message.js"

const MAX_VISIBLE = 50

type MessageListProps = {
  messages: MessageType[]
  resumed?: boolean
}

export default function MessageList({ messages, resumed }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <Box marginY={1}>
        <Text dimColor>
          {resumed
            ? "No messages in this session yet."
            : "Type a message to begin."}
        </Text>
      </Box>
    )
  }

  const hidden = messages.length > MAX_VISIBLE ? messages.length - MAX_VISIBLE : 0
  const visible = hidden > 0 ? messages.slice(-MAX_VISIBLE) : messages

  return (
    <Box flexDirection="column">
      {hidden > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>... {hidden} earlier messages</Text>
        </Box>
      )}
      {visible.map((msg, i) => (
        <Message key={i} message={msg} />
      ))}
    </Box>
  )
}
