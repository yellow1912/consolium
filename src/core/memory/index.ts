import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { DbStore } from "../db/index.js"

export type KnowledgeScope = `global` | `project:${string}` | `repo:${string}`

export interface KnowledgeRecord {
  id: string
  title: string
  content: string
  tags: string[]
  scope: KnowledgeScope
  createdAt: string
  updatedAt: string
}

export interface SearchOptions {
  query: string
  tags?: string[]
  scope?: KnowledgeScope
  contextTags?: string[]  // used for post-BM25 tag boost
  limit?: number
}

export class MemoryStore {
  private db: Database

  constructor(store: DbStore) {
    this.db = store.rawSqlite()
  }

  storeKnowledge(params: { title: string; content: string; tags?: string[]; scope?: KnowledgeScope }): KnowledgeRecord {
    const { title, content, tags = [], scope = "global" } = params

    if (title.length > 100) throw new Error("title must be ≤100 characters")
    if (content.length > 5000) throw new Error("content must be ≤5000 characters")

    const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, " ")
    const contentHash = createHash("sha256").update(content).digest("hex")
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const tagsJson = JSON.stringify(tags)

    // UPSERT: on unique conflict (normalized_title+scope or content_hash+scope), update
    this.db.run(`
      INSERT INTO knowledge (id, title, content, tags, scope, normalized_title, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_title, scope) DO UPDATE SET
        content = excluded.content,
        tags = excluded.tags,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      ON CONFLICT(content_hash, scope) DO UPDATE SET
        title = excluded.title,
        tags = excluded.tags,
        normalized_title = excluded.normalized_title,
        updated_at = excluded.updated_at
    `, [id, title, content, tagsJson, scope, normalizedTitle, contentHash, now, now])

    return (
      this.getById(id) ??
      this.getByNormalizedTitle(normalizedTitle, scope) ??
      this.getByContentHash(contentHash, scope)!
    )
  }

  updateKnowledge(params: { id: string; title?: string; content?: string; tags?: string[]; scope?: KnowledgeScope }): KnowledgeRecord {
    const existing = this.getById(params.id)
    if (!existing) throw new Error(`Knowledge entry not found: ${params.id}`)

    const title = params.title ?? existing.title
    const content = params.content ?? existing.content
    const tags = params.tags ?? existing.tags
    const scope = params.scope ?? existing.scope

    if (title.length > 100) throw new Error("title must be ≤100 characters")
    if (content.length > 5000) throw new Error("content must be ≤5000 characters")

    const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, " ")
    const contentHash = createHash("sha256").update(content).digest("hex")
    const now = new Date().toISOString()

    this.db.run(
      "UPDATE knowledge SET title=?, content=?, tags=?, scope=?, normalized_title=?, content_hash=?, updated_at=? WHERE id=?",
      [title, content, JSON.stringify(tags), scope, normalizedTitle, contentHash, now, params.id]
    )

    return this.getById(params.id)!
  }

  deleteKnowledge(id: string): void {
    this.db.run("DELETE FROM knowledge WHERE id=?", [id])
  }

  searchKnowledge(opts: SearchOptions): KnowledgeRecord[] {
    const { query, tags, scope, contextTags = [], limit = 10 } = opts

    // Build FTS5 query: each word suffix-matched
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .map(w => w.replace(/["*]/g, "") + "*")
      .join(" ")

    let sql = `
      SELECT k.*, bm25(knowledge_fts, 10.0, 5.0, 1.0) as bm25_score
      FROM knowledge k
      JOIN knowledge_fts ON k.rowid = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ?
    `
    const bindings: unknown[] = [ftsQuery]

    if (scope) {
      sql += " AND k.scope = ?"
      bindings.push(scope)
    }
    if (tags && tags.length > 0) {
      // filter: record must contain at least one of the requested tags
      sql += " AND (" + tags.map(() => "k.tags LIKE ?").join(" OR ") + ")"
      tags.forEach(t => bindings.push(`%"${t}"%`))
    }

    sql += " ORDER BY bm25_score LIMIT ?"
    bindings.push(limit * 3) // over-fetch for re-ranking

    const rows = this.db.query(sql).all(...(bindings as Parameters<ReturnType<Database["query"]>["all"]>)) as Record<string, unknown>[]

    // Post-BM25 re-ranking
    const ranked = rows.map(row => {
      let score = -(row.bm25_score as number) // bm25 is negative; flip to positive
      // tag boost: +10% per contextTag match
      const rowTags: string[] = JSON.parse((row.tags as string) || "[]")
      for (const ct of contextTags) {
        if (rowTags.includes(ct)) score *= 1.1
      }
      // scope boost
      if (scope && row.scope === scope) score += 0.5
      else if (row.scope === "global") score += 0.2
      return { row, score }
    })

    ranked.sort((a, b) => b.score - a.score)

    return ranked.slice(0, limit).map(({ row }) => ({
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      scope: row.scope as KnowledgeScope,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }))
  }

  private getById(id: string): KnowledgeRecord | null {
    const row = this.db.query("SELECT * FROM knowledge WHERE id=?").get(id) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToRecord(row)
  }

  private getByNormalizedTitle(normalizedTitle: string, scope: string): KnowledgeRecord | null {
    const row = this.db.query("SELECT * FROM knowledge WHERE normalized_title=? AND scope=?").get(normalizedTitle, scope) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToRecord(row)
  }

  private getByContentHash(contentHash: string, scope: string): KnowledgeRecord | null {
    const row = this.db.query("SELECT * FROM knowledge WHERE content_hash=? AND scope=?").get(contentHash, scope) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToRecord(row)
  }

  private rowToRecord(row: Record<string, unknown>): KnowledgeRecord {
    return {
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      scope: row.scope as KnowledgeScope,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }
  }
}
