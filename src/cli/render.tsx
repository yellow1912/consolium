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
    />
  )
  await waitUntilExit()
}
