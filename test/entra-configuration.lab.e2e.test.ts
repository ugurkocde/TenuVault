import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { configurationLab, LAB_8B_APP, LAB_8B_FOLDERS, LAB_8B_TENANT } from "./helpers/entra-configuration-lab"

// Never runs from npm test or from the credentials launcher alone. Only the 8b write
// launcher opts in. This app-only adapter cannot verify the product's delegated boundary.
const approved = process.env.TENUVAULT_LAB_WRITE_8B === "owner-approved-phase2"
describe.skipIf(!approved)("8b lab contracts with guaranteed cleanup attempts", () => {
  let lab: ReturnType<typeof configurationLab> | undefined
  beforeAll(async () => {
    if (process.env.TENUVAULT_E2E_TENANT_ID !== LAB_8B_TENANT || process.env.TENUVAULT_E2E_CLIENT_ID !== LAB_8B_APP || !process.env.TENUVAULT_E2E_CLIENT_SECRET) throw new Error("Run through the approved 8b lab launcher")
    const response = await fetch(`https://login.microsoftonline.com/${LAB_8B_TENANT}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: LAB_8B_APP, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })
    const answer = await response.json() as { access_token?: string }
    if (!response.ok || !answer.access_token) throw new Error(`Lab sign-in failed (HTTP ${response.status})`)
    const recoveryRoot = process.env.TENUVAULT_LAB_8B_RECOVERY
    if (!recoveryRoot) throw new Error("The lab launcher must supply an outside-repository recovery directory")
    mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
    if (readdirSync(recoveryRoot).length) throw new Error("A previous singleton original needs recovery. Resolve the files in the lab recovery directory before another write run.")
    lab = configurationLab(answer.access_token, LAB_8B_TENANT, LAB_8B_APP, fetch, {
      save: (folder, original) => {
        const file = openSync(join(recoveryRoot, folder + ".json"), "wx", 0o600)
        try { writeSync(file, JSON.stringify({ folder, tenant: LAB_8B_TENANT, original })); fsyncSync(file) } finally { closeSync(file) }
      },
      clear: folder => { const file = join(recoveryRoot, folder + ".json"); if (existsSync(file)) unlinkSync(file) },
    })
  })
  afterAll(async () => { try { await lab?.cleanup() } finally { lab = undefined } })
  for (const folder of LAB_8B_FOLDERS) it(folder, async () => {
    try { expect(await lab!.run(folder)).toMatchObject({ folder }) }
    finally { await lab!.cleanup() }
  }, 300_000)
})
