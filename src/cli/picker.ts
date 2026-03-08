import { select } from "@clack/prompts"

type PickerItem = { label: string; value: string; hint?: string }

export async function pick(items: PickerItem[], title: string): Promise<string | null> {
  if (items.length === 0) {
    console.log("(no items)")
    return null
  }

  const result = await select({
    message: title,
    options: items.map(item => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
  })

  if (typeof result === "symbol") return null // user cancelled
  return result as string
}
