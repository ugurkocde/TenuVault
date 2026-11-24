import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, rmSync, appendFileSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import { privilegedRestoreEnabled } from "../src/shared/intune/directory-review-folders"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { directory9bLab, type AppLabIntent } from "./helpers/directory-9b-lab"
import { LAB_8C_TENANT, LAB_8C_APP } from "./helpers/configuration-8c-lab"
describe.skipIf(!privilegedRestoreEnabled || process.env.TENUVAULT_LAB_WRITE_9B !== "owner-approved-phase2")("9b approved application lab scope", () => {
  it("verifies fixture lifecycles and test-app-only access, then permanently cleans up", async () => {
    if (process.env.TENUVAULT_E2E_TENANT_ID !== LAB_8C_TENANT || process.env.TENUVAULT_E2E_CLIENT_ID !== LAB_8C_APP) throw new Error("Wrong lab connection")
    const recovery = "/tmp/tenuvault-9b-recovery", artifacts = process.env.TENUVAULT_LAB_9B_ARTIFACT
    if (!artifacts?.startsWith("/tmp/tenuvault-9b-lab-")) throw new Error("Use the lab launcher")
    mkdirSync(recovery, { recursive: true, mode: 0o700 })
    const response = await fetch(`https://login.microsoftonline.com/${LAB_8C_TENANT}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: LAB_8C_APP, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET ?? "", scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })
    const answer = await response.json() as { access_token?: string }
    if (!response.ok || !answer.access_token) throw new Error("Lab sign-in failed")
    const lab = directory9bLab(answer.access_token, LAB_8C_TENANT, LAB_8C_APP, {
      save: intent => {
        appendFileSync(join(artifacts, "ledger.jsonl"), JSON.stringify(intent) + "\n", { mode: 0o600 })
        mkdirSync(recovery, { recursive: true, mode: 0o700 })
        const key = createHash("sha256").update(intent.folder + ":" + intent.name).digest("hex"), temporary = join(recovery, key + ".tmp")
        const file = openSync(temporary, "w", 0o600)
        try { writeSync(file, JSON.stringify(intent)); fsyncSync(file) } finally { closeSync(file) }
        renameSync(temporary, join(recovery, key + ".json"))
        const directory = openSync(recovery, "r")
        try { fsyncSync(directory) } finally { closeSync(directory) }
      },
      load: () => readdirSync(recovery).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(recovery, name), "utf8")) as AppLabIntent),
      clear: () => { rmSync(recovery, { recursive: true, force: true }); mkdirSync(recovery, { mode: 0o700 }) },
      evidence: event => appendFileSync(join(artifacts, "evidence.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }),
    }, process.env.TENUVAULT_LAB_9B_PROTECTED_APP_ID ?? "")
    if (process.env.TENUVAULT_LAB_9B_AUDIT_ONLY === "true") { expect(await lab.audit()).toEqual([]); return }
    await lab.cleanup()
    try {
      const metadataOnly = process.env.TENUVAULT_LAB_9B_ENABLED_ONLY === "true" && ["ServicePrincipals", "OAuth2PermissionGrants"].every(folder => restoreMatrixRow(folder)!.directoryRestore!.phase !== "enabled")
      if (metadataOnly) {
        expect(restoreMatrixRow("Applications")!.directoryRestore!.evidence?.update?.result).toBe("round-trip-matched")
        const fixture = await lab.createApplication()
        await lab.metadata(fixture.id)
        appendFileSync(join(artifacts, "results.jsonl"), JSON.stringify({ operation: "application-metadata", matched: true }) + "\n", { mode: 0o600 })
      } else {
        const api = await lab.createApplication(), client = await lab.createApplication()
        const resource = await lab.createPrincipal(api.appId), principal = await lab.createPrincipal(client.appId)
        const failures: string[] = [], attempted: string[] = []
        for (const [operation, probe] of [
          ["application-owner", () => lab.owner(api.id, principal)],
          ["service-principal-owner", () => lab.owner(resource, principal)],
          ["consent", () => lab.consent(principal, resource)],
          ["app-role", () => lab.appRole(principal, resource, api.roleId)],
          ["service-principal-metadata", () => lab.metadata(principal)],
          ["application-metadata", () => lab.metadata(client.id)],
          ["service-principal-recycle", () => lab.recycle(principal)],
          ["application-recycle", () => lab.recycle(client.id)],
        ] as const) {
          if (process.env.TENUVAULT_LAB_9B_ENABLED_ONLY === "true") {
            const folder = operation === "consent" ? "OAuth2PermissionGrants" : operation.startsWith("application-") ? "Applications" : "ServicePrincipals"
            const action = operation.endsWith("metadata") ? "update" : operation.endsWith("owner") ? "owner" : operation.endsWith("recycle") ? "recycle" : operation
            const contract = restoreMatrixRow(folder)!.directoryRestore!
            if (contract.phase !== "enabled" || contract.evidence?.[action]?.result !== "round-trip-matched") continue
          }
          attempted.push(operation)
          try { await probe(); appendFileSync(join(artifacts, "results.jsonl"), JSON.stringify({ operation, matched: true }) + "\n", { mode: 0o600 }) }
          catch (error) {
            failures.push(operation)
            appendFileSync(join(artifacts, "results.jsonl"), JSON.stringify({ operation, matched: false, reason: error instanceof Error ? error.message : "Probe failed" }) + "\n", { mode: 0o600 })
          }
        }
        expect(attempted.length).toBeGreaterThan(0)
        expect(failures).toEqual([])
      }
    } finally { await lab.cleanup() }
    expect(await lab.audit()).toEqual([])
  }, 1_800_000)
})
