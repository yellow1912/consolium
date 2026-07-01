import React from "react"
import { Box, Text } from "ink"
import type { AgentRegistryEntry } from "../../../core/agent-monitor/types.js"

const STATUS_EMOJI: Record<string, string> = {
  running: "🟢",
  waiting: "🟡",
  idle: "⚪",
  unknown: "❓",
}

interface Props {
  agents: AgentRegistryEntry[]
  selectedIndex: number
  height: number
}

export function AgentListPane({ agents, selectedIndex, height }: Props) {
  if (agents.length === 0) {
    return (
      <Box flexDirection="column" width={30} borderStyle="single" borderColor="gray">
        <Text color="gray"> No agents detected</Text>
        <Text color="gray"> Run an agent to see it here</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={30} borderStyle="single" borderColor="cyan">
      {agents.slice(0, height - 2).map((agent, i) => (
        <Box key={agent.pid}>
          <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
            {i === selectedIndex ? "▶ " : "  "}
            {STATUS_EMOJI[agent.status] ?? "❓"} {agent.name}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
