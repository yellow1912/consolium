import React from "react"
import { Box, Text } from "ink"
import { Select } from "@inkjs/ui"

type Session = {
  id: string
  mode: string
  status: string
  router: string
}

type SessionPickerProps = {
  sessions: Session[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export default function SessionPicker({ sessions, onSelect }: SessionPickerProps) {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>No sessions found.</Text>
      </Box>
    )
  }

  const options = sessions.map((s) => {
    const truncatedId = s.id.length > 8 ? s.id.slice(0, 8) : s.id
    return {
      label: `${truncatedId}  ${s.mode}  ${s.router}  [${s.status}]`,
      value: s.id,
    }
  })

  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Select a session to resume:</Text>
      </Box>
      <Select options={options} onChange={(value) => onSelect(value)} />
    </Box>
  )
}
