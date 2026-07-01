import { useState, useEffect, useRef } from "react"
import type { AgentRegistryEntry } from "../../../core/agent-monitor/types.js"
import { AgentRegistry } from "../../../core/agent-monitor/registry.js"

const POLL_INTERVAL_MS = 3000

export function useAgentList(paused: boolean) {
  const [agents, setAgents] = useState<AgentRegistryEntry[]>([])
  const registry = useRef(new AgentRegistry())

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      if (paused || cancelled) return
      const next = await registry.current.sync()
      if (cancelled) return
      // Quiet-update: only setState if list actually changed
      setAgents(prev => {
        const changed = JSON.stringify(prev) !== JSON.stringify(next)
        return changed ? next : prev
      })
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [paused])

  return agents
}
