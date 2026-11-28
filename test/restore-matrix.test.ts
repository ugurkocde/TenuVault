import { moduleForFolder } from "../src/shared/services/modules"
import { describe, expect, it, vi } from "vitest"
import { guardedGraphIO } from "../src/main/restore/graph-io"
import { restoreFingerprint, type GuardedStep } from "../src/main/restore/guarded-run"
import { RESTORE_MATRIX } from "../src/shared/intune/restore-matrix"
import { INTUNE_TYPES, typeForFolder, type Item } from "../src/shared/intune/registry"
import type { RestoreActor } from "../src/shared/intune/restore-guards"

vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))
vi.hoisted(() => vi.stubGlobal("__TV_LAB_PRIVILEGED_RESTORE__", true))

const actor: RestoreActor = { tenantId: "tenant", userId: "admin", clientId: "client", applicationObjectId: "app-object", servicePrincipalId: "sp-object", recoveryAccountIds: [] }
const token = (permissions: string[]) => `header.${Buffer.from(JSON.stringify({ scp: permissions.join(" "), tid: "tenant", oid: "admin", appid: "client" })).toString("base64url")}.signature`
const references = async () => ({ principals: [], applications: [], complete: true })

describe("restore write matrix", () => {
  it("has one row for each new-service type without changing capability", () => {
    expect(RESTORE_MATRIX.map(row => row.folder).sort()).toEqual(INTUNE_TYPES.filter(type => type.restoreSafety === "identity").map(type => type.folder).sort())
    expect(new Set(RESTORE_MATRIX.map(row => row.folder)).size).toBe(74)
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
        expect(write.propertyAudit?.date).toBe("2026-11-17")
        expect(write.propertyAudit?.sources).toEqual([write.documentation, row.verification.resourceDocumentation])
        for (const property of Object.keys(write.propertyAudit?.excluded ?? {})) expect(write.properties).not.toContain(property)
        expect(write.documentation).toMatch(/^https:\/\/learn.microsoft.com\/en-us\/graph\/api\//)
        expect(write.path).not.toMatch(/^https?:/)
        expect(write.propertyEvidence).toMatch(/request-body-table|resource-and-examples/)
        if (row.configurationRestore?.builder !== "enabled-closed-subset" && (write.propertyCoverage === "partial" || write.schemaDocumentation?.length || write.index !== "matched")) expect(write.blockedReason).toBeTruthy()
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
  for (const row of RESTORE_MATRIX.filter(row => row.create)) it(`${row.folder}: refuses capability none and incomplete contracts before a create can be sent`, async () => {
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
    const permissions = ["Policy.Read.All", ...write.permissions, ...(Array.isArray(need) ? need.flat() : [])]
    const io = guardedGraphIO(token(permissions), actor, references, fetchImpl, async () => [])
    // The transport itself also refuses a backup-only type, even if called without the executor.
    const originalCapability = type.restore
    delete type.restore
    try { await expect(io.write(step, desired, undefined, () => {})).rejects.toThrow() } finally { type.restore = originalCapability }
    expect(creates).toBe(0)
    if (write.blockedReason) {
      const previous = type.restore
      type.restore = "create"
      try { await expect(io.write(step, desired, undefined, () => {})).rejects.toThrow() }
      finally { if (previous) type.restore = previous; else delete type.restore }
      expect(creates).toBe(0)
      return
    }

  })
  it("excludes reserved, immutable update keys and computed state from executable contracts", () => {
    const properties = (folder: string, operation: "create" | "update") => RESTORE_MATRIX.find(row => row.folder === folder)![operation]!.properties
    expect(properties("ExternalIdentitiesPolicy", "update")).toEqual(["allowExternalIdentitiesToLeave"])
    expect(properties("UserFlowAttributes", "create")).not.toContain("id")
    expect(properties("UserFlowAttributes", "create")).not.toContain("userFlowAttributeType")
    for (const folder of ["Groups", "Applications"]) expect(properties(folder, "update")).not.toContain("uniqueName")
    expect(properties("AuthenticationEventsFlows", "update")).not.toContain("id")
    expect(properties("EntraDevices", "update")).not.toContain("isCompliant")
    expect(properties("EntraDevices", "update")).not.toContain("isManaged")
    for (const operation of ["create", "update"] as const) {
      expect(properties("B2bManagementPolicies", operation)).not.toContain("deletedDateTime")
    }
  })
  it("blocks discrepant contracts, unknown properties and missing permissions before a request", async () => {
    const io = guardedGraphIO(token(["Policy.Read.All"]), actor, references, (async () => { throw new Error("must not fetch") }) as typeof fetch)
    const step: GuardedStep = { key: "one", folder: "TokenLifetimePolicies", sourceId: "old", operation: "update", targetId: "old", desired: { displayName: "Example" }, properties: ["displayName"], preview: "preview", requires: [] }
    await expect(io.read(step)).rejects.toThrow("permission")
    const permitted = guardedGraphIO(token(["Policy.Read.All", "Policy.ReadWrite.ApplicationConfiguration", "Application.Read.All"]), actor, references)
    await expect(permitted.read({ ...step, properties: ["passwordProfile"] })).rejects.toThrow("outside")
  })
})
