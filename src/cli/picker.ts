import { select } from "@clack/prompts"
import type { Interface as ReadlineInterface } from "node:readline"

type PickerItem = { label: string; value: string; hint?: string }

export async function pick(items: PickerItem[], title: string, rl?: ReadlineInterface): Promise<string | null> {
  if (items.length === 0) {
    console.log("(no items)")
    return null
  }

  // Pause readline to prevent it from fighting with @clack/prompts over stdin
  if (rl) {
    rl.pause()
    process.stdin.setRawMode?.(false)
  }

  const result = await select({
    message: title,
    options: items.map(item => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
  })

  // Resume readline after picker is done
  if (rl) {
    rl.resume()
  }

  if (typeof result === "symbol") return null // user cancelled
  return result as string
}
