import { describe, it, expect, afterEach } from "bun:test"
import { ModelCache } from "./cache"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import os from "node:os"

const testPath = join(os.tmpdir(), `consilium-test-cache-${Date.now()}.json`)

afterEach(async () => {
  await rm(testPath, { force: true })
})

describe("ModelCache", () => {
  it("returns empty array for unknown agent", async () => {
    const cache = new ModelCache(testPath)
    expect(cache.get("claude")).toEqual([])
  })

  it("saves and loads model list", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-opus-4-6", "claude-sonnet-4-6"])
    await cache.save()

    const cache2 = new ModelCache(testPath)
    await cache2.load()
    expect(cache2.get("claude")).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"])
  })

  it("isStale returns true when entry is older than ttl", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-sonnet-4-6"])
    // manually set old fetchedAt
    ;(cache as any).entries["claude"].fetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    expect(cache.isStale("claude", 24 * 60 * 60 * 1000)).toBe(true)
  })

  it("isStale returns false for fresh entry", async () => {
    const cache = new ModelCache(testPath)
    cache.set("claude", ["claude-sonnet-4-6"])
    expect(cache.isStale("claude", 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("isStale returns true for unknown agent", async () => {
    const cache = new ModelCache(testPath)
    expect(cache.isStale("unknown", 24 * 60 * 60 * 1000)).toBe(true)
  })
})
