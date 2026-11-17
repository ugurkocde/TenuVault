import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { ENTRA_DIRECTORY_TYPES } from "../src/shared/intune/entra-directory"
import { captureLarge } from "../src/main/backup/large"
import { GraphSession, type ReadControl } from "../src/main/backup/graph-session"
import { NetworkCircuit } from "../src/main/backup/engine"
import { typeReadBudget } from "../src/main/backup/read-budget"
import { LARGE_TYPE_MS, LARGE_TYPE_REQUESTS } from "../src/shared/large-backup"
import type { Item } from "../src/shared/intune/registry"

const configured = Boolean(process.env.TENUVAULT_E2E_TENANT_ID && process.env.TENUVAULT_E2E_CLIENT_ID && process.env.TENUVAULT_E2E_CLIENT_SECRET)
// Replace every string value before any fixture is written. No lab text or identifiers survive.
function synthetic(value: unknown, key = ""): unknown {
  if (typeof value === "string") return key === "id" ? "00000000-0000-4000-8000-000000000001" : "Example"
  if (Array.isArray(value)) return value.slice(0, 1).map(entry => synthetic(entry, key))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("@odata")).map(([key, child]) => [key, synthetic(child, key)]))
  return value
}
describe.skipIf(!configured)("Directory lab through the application streaming read path", () => {
  const originalFetch = globalThis.fetch
  let token = "", guarded: typeof fetch, session: GraphSession
  beforeAll(async () => {
    const response = await originalFetch(`https://login.microsoftonline.com/${process.env.TENUVAULT_E2E_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: process.env.TENUVAULT_E2E_CLIENT_ID!, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET!, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })
    const answer = await response.json() as { access_token?: string }
    if (!response.ok || !answer.access_token) throw new Error(`Lab sign-in failed (HTTP ${response.status})`)
    token = answer.access_token
    guarded = (async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === "graph.microsoft.com" && request.method !== "GET") throw new Error("The lab permits Graph GET only")
      return originalFetch(request)
    }) as typeof fetch
    globalThis.fetch = guarded
    session = new GraphSession(guarded, async () => token, new NetworkCircuit(10), { service: "entra", isolated: true })
  })
  afterAll(() => { token = ""; globalThis.fetch = originalFetch })
  it("blocks all non-GET Graph methods before sending", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) await expect(guarded("https://graph.microsoft.com/v1.0/users", { method })).rejects.toThrow("GET only")
  })
  for (const type of ENTRA_DIRECTORY_TYPES) it(type.folder, async () => {
    const signal = new AbortController().signal
    const budget = typeReadBudget(signal, { durationMs: LARGE_TYPE_MS, maxRequests: LARGE_TYPE_REQUESTS })
    const url = (path: string) => path.startsWith("https:") ? path : `https://graph.microsoft.com/v1.0/${path}`
    const samples: Record<string, unknown> = {}, shapes: Record<string, { pages: number; entries: number; keys: string[] }> = {}
    const pages = async function* (path: string) {
      // Each path has its own iterator and shares the actual GET allowance, including retries.
      let current: ReadControl = {}
      const iterator = session.pages(url(path), { get signal() { return current.signal }, beforeRequest: () => current.beforeRequest?.(), headers: type.headers, filter: path.startsWith(type.path + "?") ? type.filter : undefined })
      for (;;) {
        const next = await budget(control => { current = control; return iterator.next() })
        if (next.done) break
        const property = path.startsWith(type.path + "?") ? "object" : path.split("?")[0]!.split("/").at(-1)!
        const page = next.value as Item[]
        const shape = shapes[property] ??= { pages: 0, entries: 0, keys: [] }
        shape.pages++; shape.entries += page.length
        if (page[0]) { shape.keys = Object.keys(page[0]).filter(key => !key.startsWith("@odata")); samples[property] ??= synthetic(page[0]) }
        yield page
      }
    }
    const files: string[] = []
    const index = await captureLarge({ type, signal, reader: { get: path => budget(control => session.get<Item>(url(path), type.headers, control)), list: async () => { throw new Error("Must stream") } }, pages, saved: () => {}, put: async path => { files.push(path); if (path.startsWith(type.folder + "/")) expect(path).toMatch(new RegExp(`^${type.folder}/[A-Za-z0-9_-]+\\.json$`)) } }).catch(error => {
      const status = (error as { status?: number }).status
      throw new Error(`${type.folder}: directory lab read failed${Number.isInteger(status) ? ` (HTTP ${status})` : ""}`)
    })
    console.log(JSON.stringify({ folder: type.folder, outcome: index.complete ? "saved" : "incomplete", count: index.count, shapes }))
    if (process.env.TENUVAULT_RECORD_DIRECTORY_FIXTURES === "1") {
      const root = new URL("./fixtures/entra-directory/", import.meta.url); mkdirSync(root, { recursive: true })
      writeFileSync(new URL(`${type.folder}.json`, root), JSON.stringify({ verified: "2026-11-17", liveCount: index.count, samples, shapes }, null, 2) + "\n")
    }
    expect(index.complete).toBe(true)
  }, 600_000)
})
