import type { Database } from "bun:sqlite"

export interface KnowledgeSummary {
  total: number
  byScope: Record<string, number>
  topTags: Array<{ tag: string; count: number }>
  recency: { today: number; week: number; month: number; older: number }
}

export function getKnowledgeSummary(db: Database): KnowledgeSummary {
  const totalRow = db
    .query("SELECT COUNT(*) as total FROM knowledge")
    .get() as { total: number } | null
  const total = totalRow?.total ?? 0

  const scopeRows = db
    .query("SELECT scope, COUNT(*) as count FROM knowledge GROUP BY scope ORDER BY scope ASC")
    .all() as Array<{ scope: string; count: number }>

  const byScope: Record<string, number> = {}
  for (const row of scopeRows) {
    byScope[row.scope] = row.count
  }

  const tagRows = db
    .query(
      "SELECT value as tag, COUNT(*) as count FROM knowledge, json_each(tags) GROUP BY value ORDER BY count DESC LIMIT 10"
    )
    .all() as Array<{ tag: string; count: number }>

  const recencyRow = db
    .query(`
      SELECT
        SUM(CASE WHEN (julianday('now') - julianday(updated_at)) < 1 THEN 1 ELSE 0 END) as today,
        SUM(CASE WHEN (julianday('now') - julianday(updated_at)) < 7 THEN 1 ELSE 0 END) as within_week,
        SUM(CASE WHEN (julianday('now') - julianday(updated_at)) < 30 THEN 1 ELSE 0 END) as within_month
      FROM knowledge
    `)
    .get() as { today: number; within_week: number; within_month: number } | null

  const todayCount = recencyRow?.today ?? 0
  const withinWeek = recencyRow?.within_week ?? 0
  const withinMonth = recencyRow?.within_month ?? 0

  return {
    total,
    byScope,
    topTags: tagRows,
    recency: {
      today: todayCount,
      week: withinWeek - todayCount,
      month: withinMonth - withinWeek,
      older: total - withinMonth,
    },
  }
}
