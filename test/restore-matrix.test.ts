import { moduleForFolder } from "../src/shared/services/modules"
import { describe, expect, it } from "vitest"
import { guardedGraphIO } from "../src/main/restore/graph-io"
import { GuardedRunJournal, executeGuardedRun, restoreFingerprint, type GuardedRun, type GuardedStep } from "../src/main/restore/guarded-run"
import { RESTORE_MATRIX } from "../src/shared/intune/restore-matrix"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import type { RestoreActor } from "../src/shared/intune/restore-guards"

const actor: RestoreActor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "app-object", servicePrincipalId: "sp-object", recoveryAccountIds: [] }
const token = (permissions: string[]) => `header.${Buffer.from(JSON.stringify({ scp: permissions.join(" "), tid: "tenant", oid: "admin", appid: "client" })).toString("base64url")}.signature`
const references = async () => ({ principals: [], applications: [], complete: true })

describe("restore write matrix", () => {
  it("has one row for each new-service type without changing capability", () => {
    expect(RESTORE_MATRIX.map(row => row.folder).sort()).toEqual(INTUNE_TYPES.filter(type => type.restoreSafety === "identity").map(type => type.folder).sort())
    expect(new Set(RESTORE_MATRIX.map(row => row.folder)).size).toBe(91)
    for (const row of RESTORE_MATRIX) {
      expect(row.reason).not.toBe("")
      expect(row.builtIn).not.toBe("")
      expect(row.verification.resourceFound).toBe(true)
      expect(row.verification.resourceDocumentation).toMatch(/^https:\/\/learn.microsoft.com\/en-us\/graph\/api\/resources\//)
      for (const supplemental of row.supplementalWrites) {
        expect(supplemental.documentation).toMatch(/^https:\/\/learn.microsoft.com\/en-us\/graph\/api\//)
        expect(supplemental.blockedReason).toContain("Evidence only")
      }
      for (const write of [row.create, row.update].filter(value => value !== null)) {
        expect(write.documentation).toMatch(/^https:\/\/learn.microsoft.com\/en-us\/graph\/api\//)
        expect(write.path).not.toMatch(/^https?:/)
        expect(write.propertyEvidence).toMatch(/request-body-table|resource-and-examples/)
        if (write.propertyCoverage === "partial" || write.schemaDocumentation?.length || write.index !== "matched") expect(write.blockedReason).toBeTruthy()
        expect(write.permissionDocumentation?.length).toBeGreaterThan(0)
        expect(write.properties.length).toBeGreaterThan(0)
        if (write.index === "matched") {
          const normalize = (path: string) => path.replace(/\{[^}]+\}/g, "{}").replace(/\/$/, "")
          const evidence = row as typeof row & { indexWrites: Record<string, Array<{ path: string }>> }
          expect(evidence.indexWrites[write.method]?.some(candidate => normalize(candidate.path) === normalize(`/${write.path}`))).toBe(true)
        }
      }
    }
  })
  for (const row of RESTORE_MATRIX.filter(row => row.create)) it(`${row.folder}: refuses capability none; a verified create reconciles an unanswered response without a second create`, async () => {
    const write = row.create!
    const type = typeForFolder(row.folder)!
    const properties = write.properties
    const desired: Item = Object.fromEntries(properties.map(property => [property, `fixture-${property}`]))
    // Fixed keys have to be present even when the documented example omits the optional key.
    for (const property of row.detection.properties ?? []) desired[property] ??= `fixture-${property}`
    const step: GuardedStep = { key: "one", folder: row.folder, sourceId: "old", operation: "create", desired, properties, preview: restoreFingerprint(null), requires: [] }
    let creates = 0
    const objects: Item[] = []
    const sent: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL, options?: RequestInit) => {
      sent.push(`${options?.method} ${String(input)}`)
      if (options?.method === "POST") {
        creates++
        const body = JSON.parse(String(options.body)) as Item
        objects.push({ ...body, id: typeof body.id === "string" ? body.id : "created-id" })
        throw new Error("The server committed, then the answer timed out")
      }
      return Response.json({ value: objects })
    }) as typeof fetch
    const need = moduleForFolder(row.folder)?.part.restore.delegated
    const permissions = [...write.permissions, ...(Array.isArray(need) ? need.flat() : [])]
    const io = guardedGraphIO(token(permissions), actor, references, fetchImpl, async () => [])
    // The transport itself also refuses a backup-only type, even if called without the executor.
    await expect(io.write(step, desired)).rejects.toThrow()
    expect(creates).toBe(0)
    if (need === "unsupported" || write.index !== "matched" || write.blockedReason || !write.permissions.length || row.disposition !== "configuration" || write.path.includes("{organizationId}") || (row.detection.properties ?? []).some(key => !properties.includes(key))) return
    const memory = new Map<string, string>()
    const journal = new GuardedRunJournal({ get: key => memory.get(key) ?? null, set: (key, value) => { memory.set(key, value) }, delete: key => { memory.delete(key) } })
    const input: GuardedRun = { version: 1, tenant: "tenant", id: "run", actor, origin: "restore", entries: [{ step, state: "pending" }], mappings: [] }
    const previous = type.restore
    type.restore = "create"
    try {
      expect((await executeGuardedRun(journal, input, io)).status).toBe("partial")
      const retry = await executeGuardedRun(journal, input, io)
      expect(retry).toMatchObject({ status: "complete", run: { entries: [{ state: "applied", targetId: typeof desired.id === "string" ? desired.id : "created-id" }] } })
      expect(creates).toBe(1)
      expect(objects).toHaveLength(1)
      expect(sent.some(call => call.startsWith("GET "))).toBe(true)
    } finally { if (previous) type.restore = previous; else delete type.restore }
  })
  it("blocks discrepant contracts, unknown properties and missing permissions before a request", async () => {
    const io = guardedGraphIO(token(["Policy.Read.All"]), actor, references, (async () => { throw new Error("must not fetch") }) as typeof fetch)
    const step: GuardedStep = { key: "one", folder: "SecurityDefaults", sourceId: "old", operation: "update", targetId: "old", desired: { isEnabled: true }, properties: ["isEnabled"], preview: "preview", requires: [] }
    await expect(io.read(step)).rejects.toThrow("permission")
    const permitted = guardedGraphIO(token(["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"]), actor, references)
    await expect(permitted.read({ ...step, properties: ["passwordProfile"] })).rejects.toThrow("outside")
    await expect(io.read({ ...step, folder: "DefenderIdentityAutoAuditing" })).rejects.toThrow("not been verified")
  })
})
