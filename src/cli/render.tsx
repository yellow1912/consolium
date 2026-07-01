import React from "react"
import { render } from "ink"
import App from "./app"
import type { Mode } from "./types"

export async function startInkCLI(options: {
  mode?: Mode
  router?: string
  resumeId?: string
  personas?: boolean
}) {
  const { waitUntilExit } = render(
    <App
      initialMode={options.mode}
      initialRouter={options.router}
      resumeSessionId={options.resumeId}
      personas={options.personas}
    />
  )
  await waitUntilExit()
}

export async function startConsole(): Promise<void> {
  const { render: inkRender } = await import("ink")
  const { ConsoleApp } = await import("./console/ConsoleApp.js")
  const React = await import("react")
  const { waitUntilExit } = inkRender(React.default.createElement(ConsoleApp))
  await waitUntilExit()
}
