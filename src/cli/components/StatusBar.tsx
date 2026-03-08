import React from "react"
import { Box, Text } from "ink"
import type { Mode } from "../types.js"

const modeColors: Record<Mode, string> = {
  council: "cyan",
  dispatch: "green",
  pipeline: "yellow",
  debate: "magenta",
}

type StatusBarProps = {
  mode: Mode
  router: string
  sessionId: string
  messageCount: number
  debateRound?: number
  debateMaxRounds?: number
}

export default function StatusBar({
  mode,
  router,
  sessionId,
  messageCount,
  debateRound,
  debateMaxRounds,
}: StatusBarProps) {
  const truncatedId = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
  const color = modeColors[mode]

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text>
          mode: <Text color={color} bold>{mode}</Text>
        </Text>
        <Text>
          router: <Text bold>{router}</Text>
        </Text>
        <Text>
          session: <Text dimColor>{truncatedId}</Text>
        </Text>
      </Box>
      <Box gap={2}>
        {mode === "debate" && debateRound != null && debateMaxRounds != null && (
          <Text>
            round: <Text color="magenta">{debateRound}/{debateMaxRounds}</Text>
          </Text>
        )}
        <Text>
          msgs: <Text bold>{messageCount}</Text>
        </Text>
      </Box>
    </Box>
  )
}
