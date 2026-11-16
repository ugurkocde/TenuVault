import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { signedInOnly } from "../src/shared/services/modules"
import { ENTRA_5B_TYPES as ENTRA_TYPES } from "../src/shared/intune/entra"
import { withReadBudget } from "../src/main/backup/read-budget"
import type { Item } from "../src/shared/intune/registry"
import { GraphSession } from "../src/main/backup/graph-session"
import { NetworkCircuit } from "../src/main/backup/engine"
import { graphVersion } from "../src/shared/intune/read"
import { readEntraType, type ReadFixture } from "./helpers/entra-5b"

const configured = Boolean(process.env.TENUVAULT_E2E_TENANT_ID && process.env.TENUVAULT_E2E_CLIENT_ID && process.env.TENUVAULT_E2E_CLIENT_SECRET)

/** Only sanitized JSON responses are recorded. The token and request headers never enter a fixture. */
function sanitized<T>(value: T): T {
  const alias = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12)
  const guids = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => `00000000-0000-4000-8000-${alias(id)}`)
  const text = guids(JSON.stringify(value))
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, email => `user-${alias(email)}@example.test`)
    .replace(/[a-z0-9][a-z0-9.-]*\.(?:onmicrosoft\.com|de|com|net|org|io|test)\b/gi, domain => domain === "graph.microsoft.com" || domain === "microsoft.com" || domain.endsWith("example.test") ? domain : `tenant-${alias(domain)}.example.test`)
  return JSON.parse(JSON.stringify(JSON.parse(text), (key, entry) => {
    if (key === "innerError" || key === "@odata.context") return undefined
    if (typeof entry !== "string") return entry
    if (key !== "retry-after" && /^\+?[0-9]{7,15}$/.test(entry)) return "0000000000"
    if (key === "state" && ["enabled", "disabled", "default"].includes(entry)) return entry
    if (/^(displayName|name|description|street|city|state|postalCode|telephoneNumber|signInPageText|usernameHintText)$/i.test(key)) return `Example ${key}`
    return entry
  })) as T
}

describe.skipIf(!configured)("Entra 5b lab through the application's read path", () => {
  const originalFetch = globalThis.fetch
  let accessToken: string
  let guarded: typeof fetch
  let recorded: ReadFixture["responses"] = {}
  let session: GraphSession
  const discoveries = new Map<string, Promise<Item[]>>()
  const requests: string[] = []
  const measurements: Record<string, unknown>[] = []
  beforeAll(async () => {
    const response = await originalFetch(`https://login.microsoftonline.com/${process.env.TENUVAULT_E2E_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST", body: new URLSearchParams({ client_id: process.env.TENUVAULT_E2E_CLIENT_ID!, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET!, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    })
    const result = await response.json() as { access_token?: string }
    if (!response.ok || !result.access_token) throw new Error(`Lab sign-in failed (HTTP ${response.status})`)
    accessToken = result.access_token
    guarded = (async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === "graph.microsoft.com" && request.method !== "GET") throw new Error("The lab permits Graph GET only")
      if (new URL(request.url).hostname === "graph.microsoft.com") requests.push(new URL(request.url).pathname)
      const destination = recorded
      const response = await originalFetch(request)
      if (new URL(request.url).hostname === "graph.microsoft.com") {
        const url = new URL(request.url)
        destination[url.pathname + url.search] = { status: response.status, body: await response.clone().json(), ...(response.headers.has("retry-after") ? { headers: { "retry-after": response.headers.get("retry-after")! } } : {}) }
      }
      return response
    }) as typeof fetch
    globalThis.fetch = guarded
    session = new GraphSession(guarded, async () => accessToken, new NetworkCircuit(10), { service: "entra", isolated: true })
  })
  afterAll(() => {
    globalThis.fetch = originalFetch
    accessToken = ""
    // Counts and type declarations only, with no tenant identifiers, headers or response bodies.
    const output = new URL("../out/", import.meta.url)
    mkdirSync(output, { recursive: true })
    writeFileSync(new URL("entra-5b-lab-report.json", output), JSON.stringify(measurements, null, 2) + "\n")
  })

  it("refuses every Graph method except GET before sending it", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]) await expect(guarded("https://graph.microsoft.com/v1.0/organization", { method })).rejects.toThrow("GET only")
  })

  it("verifies filtered PIM schedule reads independently of empty PIM resource discovery", async () => {
    const discovery: ReadFixture["responses"] = {}
    recorded = discovery
    const resources = await session.list("https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/resources?$select=id", { headers: { "Accept-Language": "en-US" } })
    if (process.env.TENUVAULT_RECORD_ENTRA_FIXTURES === "1") writeFileSync(new URL("./fixtures/entra-5b/pim-resource-discovery.json", import.meta.url), JSON.stringify(sanitized({ source: "Live diagnostic only: resource discovery is insufficient for schedule coverage", objectCount: resources.length, responses: discovery }), null, 2) + "\n")
    // Diagnostic only: these directory group IDs never enter a backup and are not PIM discovery.
    const { value: scopes } = await session.get<{ value: Array<{ id: string }> }>("https://graph.microsoft.com/v1.0/groups?$select=id&$top=1")
    expect(scopes.length).toBeGreaterThan(0)
    for (const folder of ["PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules"]) {
      const type = ENTRA_TYPES.find(type => type.folder === folder)!
      const responses: ReadFixture["responses"] = {}
      recorded = responses
      const url = `https://graph.microsoft.com/v1.0/${type.path}?$filter=${encodeURIComponent(`groupId eq '${scopes[0]!.id}'`)}`
      const entries = await session.list(url, { headers: type.headers })
      if (process.env.TENUVAULT_RECORD_ENTRA_FIXTURES === "1") writeFileSync(new URL(`./fixtures/entra-5b/${folder}.probe.json`, import.meta.url), JSON.stringify(sanitized({ folder, source: "Live diagnostic: first directory group, not discovered as a PIM resource; no coverage claim", objectCount: entries.length, responses }), null, 2) + "\n")
    }
  }, 120_000)

  for (const type of ENTRA_TYPES) it(type.folder, async () => {
    const responses: ReadFixture["responses"] = {}
    recorded = responses
    const version = graphVersion(type)
    const url = (path: string) => path.startsWith("https://") ? path : `https://graph.microsoft.com/${version}/${path}`
    const budget = type.listSource?.budget
    const started = requests.length
    const runSignal = new AbortController().signal
    const reader = (control = {}) => ({ get: (path: string) => session.get<Item>(url(path), type.headers, control), list: (path: string) => session.list(url(path), { ...control, headers: type.headers }) as Promise<Item[]> })
    const discover = (path: string) => {
      let scopes = discoveries.get(path)
      if (!scopes) {
        scopes = withReadBudget(runSignal, budget!.durationMs, Infinity, control => reader(control).list(path))
        discoveries.set(path, scopes)
      }
      return scopes
    }
    const result = budget
      ? await withReadBudget(runSignal, budget.durationMs, budget.maxRequests, control => readEntraType(type, reader(control), discover))
      : await readEntraType(type, reader())
    const sent = requests.slice(started)
    measurements.push({ folder: type.folder, path: type.path, version, shape: type.staticIds ? "two singletons" : type.singleton ? "singleton" : "list", signIn: type.backupMode === "application" ? "app-only" : "both", outcome: result.outcome, objects: result.objects.length, ...("cause" in result ? { cause: result.cause } : {}), gets: sent.length, discovery: sent.filter(path => path === "/v1.0/groups").length, schedules: sent.filter(path => path.includes("privilegedAccess/group")).length })
    console.log(`${type.folder}: GETs=${sent.length}, discovery=${sent.filter(path => path === "/v1.0/groups").length}, schedules=${sent.filter(path => path.includes("privilegedAccess/group")).length}`)
    console.log(`${type.folder}: ${result.outcome}${result.outcome === "saved" ? ` (${result.objects.length})` : "cause" in result ? ` (${result.cause})` : ""}`)
    if (process.env.TENUVAULT_RECORD_ENTRA_FIXTURES === "1") {
      const fixture = sanitized({ folder: type.folder, path: type.path, apiVersion: version, shape: type.staticIds ? "two singletons" : type.singleton ? type.singleton.collection ? "one-item collection" : "singleton" : "list", signIn: type.backupMode === "application" ? "app-only" : signedInOnly(type.folder) ? "admin" : "both", objectCount: result.objects.length, verified: "2026-11-16", source: "Live app-only read through GraphSession and readObject", outcome: result.outcome, ...("cause" in result ? { cause: result.cause } : {}), responses })
      const folder = new URL("./fixtures/entra-5b/", import.meta.url)
      mkdirSync(folder, { recursive: true })
      writeFileSync(new URL(`${type.folder}.json`, folder), JSON.stringify(fixture, null, 2) + "\n")
    }
    expect(result.outcome).not.toBe("failed")
  }, 600_000)
})
