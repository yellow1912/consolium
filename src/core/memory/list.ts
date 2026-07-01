import type { Database } from "bun:sqlite"
import type { KnowledgeRecord, KnowledgeScope } from "./index.js"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 200

export interface ListOptions {
  scope?: KnowledgeScope
  tags?: string[]
  query?: string
  sort?: "title" | "created" | "updated" | "scope"
  limit?: number
  offset?: number
}

export interface ListResult {
  records: KnowledgeRecord[]
  total: number
  hasMore: boolean
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/["*]/g, "") + "*")
    .join(" ")
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : []
  } catch {
    return []
  }
}

function rowToRecord(row: Record<string, unknown>): KnowledgeRecord {
  return {
    id: row.id as string,
    title: row.title as string,
    content: row.content as string,
    tags: parseTags(row.tags as string),
    scope: row.scope as KnowledgeScope,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const ORDER_BY: Record<string, string> = {
  title: "ORDER BY title ASC",
  created: "ORDER BY created_at DESC",
  scope: "ORDER BY scope ASC",
  updated: "ORDER BY updated_at DESC",
}

export function listKnowledge(db: Database, opts: ListOptions = {}): ListResult {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(opts.offset ?? 0, 0)

  const where: string[] = []
  const params: unknown[] = []

  if (opts.query?.trim()) {
    where.push("rowid IN (SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?)")
    params.push(buildFtsQuery(opts.query))
  }

  if (opts.scope) {
    where.push("scope = ?")
    params.push(opts.scope)
  }

  for (const tag of opts.tags ?? []) {
    where.push("tags LIKE ?")
    params.push(`%"${tag}"%`)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const orderBy = ORDER_BY[opts.sort ?? "updated"] ?? ORDER_BY.updated

  const totalRow = db
    .query(`SELECT COUNT(*) as total FROM knowledge ${whereSql}`)
    .get(...(params as Parameters<ReturnType<Database["query"]>["get"]>)) as { total: number } | null
  const total = totalRow?.total ?? 0

  const rows = db
    .query(
      `SELECT id, title, content, tags, scope, created_at, updated_at FROM knowledge ${whereSql} ${orderBy} LIMIT ? OFFSET ?`
    )
    .all(...([...params, limit, offset] as Parameters<ReturnType<Database["query"]>["all"]>)) as Record<string, unknown>[]

  return {
    records: rows.map(rowToRecord),
    total,
    hasMore: offset + rows.length < total,
  }
}
