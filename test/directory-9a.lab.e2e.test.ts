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
    // Recovery discovery precedes new fixtures. A cleanup refusal prevents all new mutations.
    await lab.cleanup()
    try {
      const domain = LAB_9A_DOMAIN
      mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
      const user = await lab.createUser(domain)
      const manager = await lab.createUser(domain)
      await lab.manager(user, manager)
      await lab.lifecycleUser(user)
      if (LAB_9A_GROUP_CLEANUP.admitted) {
        for (const [roleAssignable, microsoft365] of [[false, false], [false, true], [true, false]]) {
          const group = await lab.createGroup(roleAssignable, microsoft365)
          await lab.relationship(group, user, "members", true)
          await lab.relationship(group, user, "members", false)
          if (!roleAssignable) {
            await lab.relationship(group, user, "owners", true)
            await lab.relationship(group, user, "owners", false)
          }
          await lab.lifecycleGroup(group)
        }
      }
    } finally { await lab.cleanup() }
    expect(await lab.audit()).toEqual([])
  }, 300_000)
})
