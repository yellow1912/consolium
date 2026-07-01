import React, { useState, useCallback } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { useAgentList } from "./hooks/useAgentList.js"
import { useAgentConversation } from "./hooks/useAgentConversation.js"
import { AgentListPane } from "./components/AgentListPane.js"
import { ConversationPreview } from "./components/ConversationPreview.js"

export function ConsoleApp() {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termHeight = stdout?.rows ?? 24

  const [selectedIndex, setSelectedIndex] = useState(0)
  const [inputText, setInputText] = useState("")
  const [isInputFocused, setIsInputFocused] = useState(false)
  const [statusMessage, setStatusMessage] = useState("")

  const agents = useAgentList(isInputFocused)
  const selectedAgent = agents[selectedIndex]
  const messages = useAgentConversation(selectedAgent?.sessionFilePath)

  const sendMessage = useCallback(async (text: string) => {
    if (!selectedAgent) {
      setStatusMessage("No agent selected")
      return
    }
    try {
      const { TtyWriter } = await import("../../core/agent-monitor/tty-writer.js")
      const writer = new TtyWriter()
      const location = writer.detectTerminal(selectedAgent.pid)
      if (!location) {
        setStatusMessage(`No supported terminal for ${selectedAgent.name} (tmux/WezTerm/iTerm2/Terminal.app required)`)
        return
      }
      writer.send(location, text)
      setStatusMessage(`✓ Sent to ${selectedAgent.name} via ${location.type}`)
    } catch (e) {
      setStatusMessage(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [selectedAgent])

  useInput((input, key) => {
    if (isInputFocused) {
      if (key.escape) {
        setIsInputFocused(false)
        setInputText("")
        return
      }
      if (key.return) {
        if (inputText.trim()) {
          const text = inputText.trim()
          setInputText("")
          setIsInputFocused(false)
          sendMessage(text)
        }
        return
      }
      if (key.backspace || key.delete) {
        setInputText(prev => prev.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setInputText(prev => prev + input)
      }
      return
    }

    // Navigation mode
    if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(prev => Math.min(agents.length - 1, prev + 1))
      return
    }
    if (key.return) {
      setIsInputFocused(true)
      setStatusMessage("")
      return
    }
    if (input === "q") {
      exit()
    }
  })

  const listHeight = termHeight - 4  // reserve rows for status + input
  const previewHeight = termHeight - 4

  return (
    <Box flexDirection="column" height={termHeight}>
      <Box flexDirection="row" flexGrow={1}>
        <AgentListPane
          agents={agents}
          selectedIndex={selectedIndex}
          height={listHeight}
        />
        <ConversationPreview
          agent={selectedAgent}
          messages={messages}
          height={previewHeight}
        />
      </Box>
      <Box>
        {isInputFocused ? (
          <Text color="cyan">{"> "}{inputText}<Text color="gray">_</Text></Text>
        ) : (
          <Text color="gray">  ↑↓ select · Enter focus input · q quit{statusMessage ? `  |  ${statusMessage}` : ""}</Text>
        )}
      </Box>
    </Box>
  )
}
