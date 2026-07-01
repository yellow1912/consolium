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
  contextTags?: string[]
  limit?: number
}

export class MemoryStore {
  private db: Database

  constructor(store: DbStore) {
    this.db = store.rawSqlite()
    this.ensureSchema()
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT 'global',
        normalized_title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, content, tags,
        content=knowledge,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END;
    `)
  }

  storeKnowledge(params: { title: string; content: string; tags?: string[]; scope?: KnowledgeScope }): KnowledgeRecord {
    const { title, content, tags = [], scope = "global" } = params

    if (title.length > 100) throw new Error("title must be ≤100 characters")
    if (content.length > 5000) throw new Error("content must be ≤5000 characters")

    const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, " ")
    const contentHash = createHash("sha256").update(content).digest("hex")
    const now = new Date().toISOString()
    const tagsJson = JSON.stringify(tags)

    const existingByTitle = this.getByNormalizedTitle(normalizedTitle, scope)
    if (existingByTitle) {
      return this.updateKnowledge({ id: existingByTitle.id, content, tags, scope })
    }

    const existingByHash = this.getByContentHash(contentHash, scope)
    if (existingByHash) {
      return this.updateKnowledge({ id: existingByHash.id, title, tags, scope })
    }

    const id = crypto.randomUUID()
    this.db.run(
      "INSERT INTO knowledge (id, title, content, tags, scope, normalized_title, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, title, content, tagsJson, scope, normalizedTitle, contentHash, now, now]
    )

    return this.getById(id)!
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
      sql += " AND (" + tags.map(() => "k.tags LIKE ?").join(" OR ") + ")"
      tags.forEach(t => bindings.push(`%"${t}"%`))
    }

    sql += " ORDER BY bm25_score LIMIT ?"
    bindings.push(limit * 3)

    const rows = this.db.query(sql).all(...(bindings as Parameters<ReturnType<Database["query"]>["all"]>)) as Record<string, unknown>[]

    const ranked = rows.map(row => {
      let score = -(row.bm25_score as number)
      const rowTags: string[] = JSON.parse((row.tags as string) || "[]")
      for (const ct of contextTags) {
        if (rowTags.includes(ct)) score *= 1.1
      }
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
