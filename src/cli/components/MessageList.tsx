import React from "react"
import { Box, Text, useStdout } from "ink"
import type { Message as MessageType } from "../../core/adapters/types.js"
import Message from "./Message.js"

// Reserve rows for: input line, status bar, spinner, live streams, padding
const RESERVED_ROWS = 10

type MessageListProps = {
  messages: MessageType[]
  resumed?: boolean
}

export default function MessageList({ messages, resumed }: MessageListProps) {
  const { stdout } = useStdout()
  const termRows = stdout?.rows ?? 24
  // Estimate ~3 rows per message (label + content line + margin); min 3 messages always shown
  const maxVisible = Math.max(3, Math.floor((termRows - RESERVED_ROWS) / 3))

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

  const hidden = messages.length > maxVisible ? messages.length - maxVisible : 0
  const visible = hidden > 0 ? messages.slice(-maxVisible) : messages

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
