import { DbStore } from "../../db/index.js"
import { listKnowledge } from "../list.js"
import { getKnowledgeSummary } from "../summary.js"
import type { KnowledgeRecord, KnowledgeScope } from "../index.js"
import { DASHBOARD_HTML } from "./dashboard-html.js"

interface GraphNode {
  data: { id: string; label: string; type: "memory" | "tag" | "scope" }
}

interface GraphEdge {
  data: { source: string; target: string }
}

function buildGraph(records: KnowledgeRecord[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const tagsSeen = new Map<string, number>()
  const scopesSeen = new Set<string>()

  for (const record of records.slice(0, 250)) {
    nodes.push({ data: { id: `mem:${record.id}`, label: record.title, type: "memory" } })

    for (const tag of record.tags) {
      edges.push({ data: { source: `mem:${record.id}`, target: `tag:${tag}` } })
      tagsSeen.set(tag, (tagsSeen.get(tag) ?? 0) + 1)
    }

    scopesSeen.add(record.scope)
    edges.push({ data: { source: `mem:${record.id}`, target: `scope:${record.scope}` } })
  }

  for (const [tag] of tagsSeen) {
    nodes.push({ data: { id: `tag:${tag}`, label: tag, type: "tag" } })
  }

  for (const scope of scopesSeen) {
    nodes.push({ data: { id: `scope:${scope}`, label: scope, type: "scope" } })
  }

  return { nodes, edges }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export function startDashboard(opts: { port?: number; dbPath: string; openBrowser?: boolean }): void {
  const port = opts.port ?? 4242
  const dbStore = new DbStore(opts.dbPath)
  const db = dbStore.rawSqlite()

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req: Request): Response {
      const url = new URL(req.url)

      if (req.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405)
      }

      // Serve dashboard HTML
      if (url.pathname === "/") {
        return new Response(DASHBOARD_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        })
      }

      // GET /api/memories?q=&scope=&tags=&sort=&limit=&offset=
      if (url.pathname === "/api/memories") {
        try {
          const q = url.searchParams.get("q")?.trim() || undefined
          const rawScope = url.searchParams.get("scope")?.trim() || undefined
          const rawTags = url.searchParams.get("tags")?.trim()
          const tags = rawTags ? rawTags.split(",").map(t => t.trim()).filter(Boolean) : undefined
          const sort = (url.searchParams.get("sort")?.trim() || undefined) as
            | "title"
            | "created"
            | "updated"
            | "scope"
            | undefined
          const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 200)
          const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0)

          const result = listKnowledge(db, {
            query: q,
            scope: rawScope as KnowledgeScope | undefined,
            tags,
            sort,
            limit,
            offset,
          })
          return jsonResponse(result)
        } catch (err) {
          return jsonResponse({ error: String(err) }, 500)
        }
      }

      // GET /api/summary
      if (url.pathname === "/api/summary") {
        try {
          const summary = getKnowledgeSummary(db)
          return jsonResponse(summary)
        } catch (err) {
          return jsonResponse({ error: String(err) }, 500)
        }
      }

      // GET /api/graph — Cytoscape.js format, max 250 memory nodes
      if (url.pathname === "/api/graph") {
        try {
          const result = listKnowledge(db, { limit: 250 })
          const graph = buildGraph(result.records)
          return jsonResponse(graph)
        } catch (err) {
          return jsonResponse({ error: String(err) }, 500)
        }
      }

      return new Response("Not found", { status: 404 })
    },
  })

  console.log(`Memory dashboard running at http://localhost:${port}`)

  if (opts.openBrowser && process.platform === "darwin") {
    Bun.$`open http://localhost:${port}`.catch(() => {})
  }
}
