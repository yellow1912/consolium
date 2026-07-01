import { test, expect, beforeEach, afterEach } from "bun:test"
import { DbStore } from "../db/index.js"
import { MemoryStore } from "./index.js"

let dbStore: DbStore
let memStore: MemoryStore

beforeEach(() => {
  dbStore = new DbStore(":memory:")
  memStore = new MemoryStore(dbStore)
})

afterEach(() => {
  dbStore.close()
})

// 1. Store + retrieve basic entry
test("storeKnowledge returns stored record", () => {
  const record = memStore.storeKnowledge({
    title: "TypeScript tips",
    content: "Use strict mode for safer code.",
    tags: ["typescript", "tips"],
    scope: "global",
  })

  expect(record.id).toBeString()
  expect(record.title).toBe("TypeScript tips")
  expect(record.content).toBe("Use strict mode for safer code.")
  expect(record.tags).toEqual(["typescript", "tips"])
  expect(record.scope).toBe("global")
  expect(record.createdAt).toBeString()
  expect(record.updatedAt).toBeString()
})

// 2. Dedup by normalized title + scope
test("storing same title+scope upserts instead of creating duplicate", () => {
  const first = memStore.storeKnowledge({
    title: "My Note",
    content: "Original content.",
    scope: "global",
  })

  const second = memStore.storeKnowledge({
    title: "my note",   // same normalized title (lowercased)
    content: "Updated content.",
    scope: "global",
  })

  expect(second.id).toBe(first.id)
  expect(second.content).toBe("Updated content.")

  // Search should find only one entry
  const results = memStore.searchKnowledge({ query: "note" })
  expect(results.length).toBe(1)
})

// 3. Dedup by content hash + scope
test("storing same content+scope upserts title instead of duplicating", () => {
  const first = memStore.storeKnowledge({
    title: "Version A",
    content: "Identical content body.",
    scope: "global",
  })

  const second = memStore.storeKnowledge({
    title: "Version B",
    content: "Identical content body.",
    scope: "global",
  })

  expect(second.id).toBe(first.id)
  expect(second.title).toBe("Version B")

  const results = memStore.searchKnowledge({ query: "Identical" })
  expect(results.length).toBe(1)
})

// 4. Search returns BM25-ranked results
test("searchKnowledge returns relevant results ranked by BM25", () => {
  memStore.storeKnowledge({ title: "Bun runtime guide", content: "Bun is a fast JavaScript runtime with built-in bundler.", scope: "global" })
  memStore.storeKnowledge({ title: "Node.js overview", content: "Node.js is a JavaScript runtime built on V8.", scope: "global" })
  memStore.storeKnowledge({ title: "Unrelated entry", content: "Something completely different.", scope: "global" })

  const results = memStore.searchKnowledge({ query: "Bun runtime" })

  expect(results.length).toBeGreaterThanOrEqual(1)
  // The Bun entry should rank first (title + content match "Bun")
  expect(results[0].title).toBe("Bun runtime guide")
})

// 5. contextTag boost: record with matching tag ranks above equal-BM25 record without it
test("contextTag boost promotes entries with matching tags", () => {
  // Both have identical content so BM25 scores are equal
  memStore.storeKnowledge({
    title: "Item alpha",
    content: "quxquux ranking document content",
    tags: ["important"],
    scope: "global",
  })
  memStore.storeKnowledge({
    title: "Item beta",
    content: "quxquux ranking document content",
    tags: ["irrelevant"],
    scope: "project:x",   // different scope avoids content_hash+scope unique conflict
  })

  const results = memStore.searchKnowledge({
    query: "quxquux",
    contextTags: ["important"],
  })

  expect(results.length).toBe(2)
  expect(results[0].tags).toContain("important")
})

// 6. scope boost: global entry gets +0.2 boost when searching without scope filter
test("global scope entries rank above project-scoped entries of equal relevance", () => {
  memStore.storeKnowledge({
    title: "Global doc",
    content: "scopetest zebra alpha beta",
    scope: "global",
  })
  memStore.storeKnowledge({
    title: "Project doc",
    content: "scopetest zebra alpha beta",
    scope: "project:acme",   // same content hash but different scope → stored separately
  })

  const results = memStore.searchKnowledge({ query: "scopetest zebra" })

  expect(results.length).toBe(2)
  expect(results[0].scope).toBe("global")
})

// 7. Length validation
test("storeKnowledge throws when title exceeds 100 characters", () => {
  expect(() =>
    memStore.storeKnowledge({
      title: "a".repeat(101),
      content: "valid content",
    })
  ).toThrow("title must be ≤100 characters")
})

test("storeKnowledge throws when content exceeds 5000 characters", () => {
  expect(() =>
    memStore.storeKnowledge({
      title: "valid title",
      content: "x".repeat(5001),
    })
  ).toThrow("content must be ≤5000 characters")
})

// 8. Trigger sync
test("insert trigger: newly stored entry is searchable", () => {
  memStore.storeKnowledge({
    title: "Trigger insert test",
    content: "fts5triggertest content should be findable",
    scope: "global",
  })

  const results = memStore.searchKnowledge({ query: "fts5triggertest" })
  expect(results.length).toBe(1)
  expect(results[0].title).toBe("Trigger insert test")
})

test("delete trigger: deleted entry is no longer searchable", () => {
  const record = memStore.storeKnowledge({
    title: "To be deleted",
    content: "deleteme unique content phrase",
    scope: "global",
  })

  // Confirm it's searchable before deletion
  const before = memStore.searchKnowledge({ query: "deleteme" })
  expect(before.length).toBe(1)

  memStore.deleteKnowledge(record.id)

  const after = memStore.searchKnowledge({ query: "deleteme" })
  expect(after.length).toBe(0)
})

test("update trigger: updated content is searchable, old content is not", () => {
  const record = memStore.storeKnowledge({
    title: "Updatable entry",
    content: "oldphrase unique original content",
    scope: "global",
  })

  memStore.updateKnowledge({
    id: record.id,
    content: "newphrase unique updated content",
  })

  const oldResults = memStore.searchKnowledge({ query: "oldphrase" })
  expect(oldResults.length).toBe(0)

  const newResults = memStore.searchKnowledge({ query: "newphrase" })
  expect(newResults.length).toBe(1)
})

// updateKnowledge throws for unknown id
test("updateKnowledge throws for unknown id", () => {
  expect(() =>
    memStore.updateKnowledge({ id: "non-existent-id", content: "new content" })
  ).toThrow("Knowledge entry not found")
})
