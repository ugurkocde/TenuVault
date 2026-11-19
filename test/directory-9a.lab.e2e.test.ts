import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, rmSync, appendFileSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { describe, it, expect } from "vitest"
import { directory9aLab, LAB_9A_GROUP_CLEANUP, LAB_9A_DOMAIN, type DirectoryLabIntent } from "./helpers/directory-9a-lab"
import { LAB_8C_TENANT, LAB_8C_APP } from "./helpers/configuration-8c-lab"
const approved = process.env.TENUVAULT_LAB_WRITE_9A === "owner-approved-phase2"
describe.skipIf(!approved)("9a approved directory lab scope", () => {
  it("verifies disabled user lifecycle, recycle recovery and permanent cleanup", async () => {
    if (process.env.TENUVAULT_E2E_TENANT_ID !== LAB_8C_TENANT || process.env.TENUVAULT_E2E_CLIENT_ID !== LAB_8C_APP) throw new Error("Wrong lab connection")
    const recoveryRoot = process.env.TENUVAULT_LAB_9A_RECOVERY, artifacts = process.env.TENUVAULT_LAB_9A_ARTIFACT
    if (!recoveryRoot?.startsWith("/tmp/") || !artifacts?.startsWith("/tmp/")) throw new Error("Private recovery and artifact directories are required")
    mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 }); mkdirSync(artifacts, { recursive: true, mode: 0o700 })
    const response = await fetch(`https://login.microsoftonline.com/${LAB_8C_TENANT}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: LAB_8C_APP, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET ?? "", scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })
    const answer = await response.json() as { access_token?: string }
    if (!response.ok || !answer.access_token) throw new Error("Lab sign-in failed")
    const lab = directory9aLab(answer.access_token, LAB_8C_TENANT, LAB_8C_APP, {
      save: intent => {
        const key = createHash("sha256").update(intent.name).digest("hex")
        const temporary = join(recoveryRoot, key + ".tmp"), destination = join(recoveryRoot, key + ".json")
        const file = openSync(temporary, "w", 0o600)
        try { writeSync(file, JSON.stringify(intent)); fsyncSync(file) } finally { closeSync(file) }
        renameSync(temporary, destination)
        const directory = openSync(recoveryRoot, "r")
        try { fsyncSync(directory) } finally { closeSync(directory) }
      },
      load: () => readdirSync(recoveryRoot).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(recoveryRoot, name), "utf8")) as DirectoryLabIntent),
      clear: () => rmSync(recoveryRoot, { recursive: true, force: true }),
      evidence: event => appendFileSync(join(artifacts, "evidence.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }),
    })
    if (process.env.TENUVAULT_LAB_9A_AUDIT_ONLY === "true") {
      const remaining = await lab.audit()
      expect(remaining.every(item => item.folder === "directory/deletedItems/microsoft.graph.group" && typeof item.deletedDateTime === "string")).toBe(true)
      return
    }
    // Recovery discovery precedes new fixtures. A cleanup refusal prevents all new mutations.
    await lab.cleanup()
    try {
      const domain = LAB_9A_DOMAIN
      mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
      const results = new Map<string, boolean>()
      const probe = async (name: string, run: () => Promise<void>) => {
        try { await run(); results.set(name, true); appendFileSync(join(artifacts, "results.jsonl"), JSON.stringify({ name, result: "matched" }) + "\n", { mode: 0o600 }) }
        catch (error) { results.set(name, false); appendFileSync(join(artifacts, "results.jsonl"), JSON.stringify({ name, result: "blocked", reason: (error as Error).message }) + "\n", { mode: 0o600 }) }
      }
      const user = await lab.createUser(domain)
      const manager = await lab.createUser(domain)
      await probe("manager", () => lab.manager(user, manager))
      await probe("user-profile", () => lab.profileUser(user))
      await probe("user-update-recycle", async () => { await lab.lifecycleUser(await lab.createUser(domain)) })
      await probe("user-new-id", async () => { await lab.recreateUser(await lab.createUser(domain)) })
      if (LAB_9A_GROUP_CLEANUP.admitted) {
        for (const [name, roleAssignable, microsoft365, dynamic] of [["security", false, false, false], ["unified", false, true, false], ["role-assignable", true, false, false], ["dynamic", false, false, true]] as const) {
          if (process.env.TENUVAULT_LAB_9A_ENABLED_ONLY === "true" && (roleAssignable || microsoft365)) continue
          let group: string | undefined
          await probe(name + "-create", async () => { group = await lab.createGroup(roleAssignable, microsoft365, dynamic) })
          if (!group) continue
          if (!dynamic) {
            await probe(name + "-member", async () => { await lab.relationship(group!, user, "members", true); await lab.relationship(group!, user, "members", false) })
            await probe(name + "-owner-add", () => lab.relationship(group!, user, "owners", true))
            await probe(name + "-owner-remove", () => lab.relationship(group!, user, "owners", false))
          } else await probe("dynamic-rule", () => lab.dynamicRule(group!))
          await probe(name + "-update-recycle", () => lab.lifecycleGroup(group!))
        }
      }
      if (process.env.TENUVAULT_LAB_9A_ENABLED_ONLY === "true") for (const name of ["manager", "user-profile", "user-new-id", "security-create", "security-member", "security-owner-add", "security-update-recycle"]) expect(results.get(name), name).toBe(true)
    } finally { await lab.cleanup() }
    expect((await lab.audit()).filter(item => item.folder !== "directory/deletedItems/microsoft.graph.group")).toEqual([])
  }, 1_800_000)
})
