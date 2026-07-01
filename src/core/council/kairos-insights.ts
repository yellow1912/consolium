import { Database } from "bun:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"

const KAIROS_DB = join(homedir(), "Projects", "nilead", "kairos", "kairos.db")

type PolicyRow = {
  category: string
  provider: string
  model: string
  alpha: number
  beta: number
  mean_cost: number
  n: number
}

/**
 * Reads Kairos routing_policy stats and formats them as a compact block
 * for injection into LLM router prompts.
 *
 * Returns empty string on cold start (no data) or if DB is unavailable.
 */
export function getKairosRoutingInsights(category?: string): string {
  let db: Database | undefined
  try {
    db = new Database(KAIROS_DB, { readonly: true })

    let rows: PolicyRow[]
    if (category) {
      rows = db.query<PolicyRow, [string]>(
        "SELECT category, provider, model, alpha, beta, mean_cost, n FROM routing_policy WHERE category LIKE ? AND n > 0 ORDER BY n DESC LIMIT 10"
      ).all(`${category}%`)
    } else {
      rows = db.query<PolicyRow, []>(
        "SELECT category, provider, model, alpha, beta, mean_cost, n FROM routing_policy WHERE n > 0 ORDER BY n DESC LIMIT 10"
      ).all()
    }

    if (rows.length === 0) return ""

    const lines = rows.map(r => {
      const successRate = Math.round((r.alpha / (r.alpha + r.beta)) * 100)
      const cost = r.mean_cost < 0.001 ? "<$0.001" : `~$${r.mean_cost.toFixed(3)}`
      return `${r.category} → ${r.provider}/${r.model}: success ${successRate}% (n=${r.n}, cost ${cost})`
    })

    return `[Kairos routing history]\n${lines.join("\n")}`
  } catch {
    return ""
  } finally {
    db?.close()
  }
}
