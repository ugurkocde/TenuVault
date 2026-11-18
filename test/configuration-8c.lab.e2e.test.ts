import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { configuration8cLab, LAB_8C_APP, LAB_8C_FOLDERS, LAB_8C_TENANT } from "./helpers/configuration-8c-lab"

// Never runs from npm test or from the credentials launcher alone. Only the 8c write
// launcher opts in. This app-only adapter cannot verify the product's delegated boundary.
const folders = LAB_8C_FOLDERS
const approved = process.env.TENUVAULT_LAB_WRITE_8C === "owner-approved-phase2"
describe.skipIf(!approved)("8c lab contracts with guaranteed cleanup attempts", () => {
  let lab: ReturnType<typeof configuration8cLab> | undefined
  beforeAll(async () => {
    if (process.env.TENUVAULT_E2E_TENANT_ID !== LAB_8C_TENANT || process.env.TENUVAULT_E2E_CLIENT_ID !== LAB_8C_APP || !process.env.TENUVAULT_E2E_CLIENT_SECRET) throw new Error("Run through the approved 8c lab launcher")
    const response = await fetch(`https://login.microsoftonline.com/${LAB_8C_TENANT}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({ client_id: LAB_8C_APP, client_secret: process.env.TENUVAULT_E2E_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })
    const answer = await response.json() as { access_token?: string }
    if (!response.ok || !answer.access_token) throw new Error(`Lab sign-in failed (HTTP ${response.status})`)
    const recoveryRoot = process.env.TENUVAULT_LAB_8C_RECOVERY
    if (!recoveryRoot) throw new Error("The lab launcher must supply an outside-repository recovery directory")
    mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
    if (readdirSync(recoveryRoot).length) throw new Error("A previous singleton original needs recovery. Resolve the files in the lab recovery directory before another write run.")
    const artifactRoot = process.env.TENUVAULT_LAB_8C_ARTIFACT
    if (!artifactRoot || !artifactRoot.startsWith("/tmp/")) throw new Error("The launcher must supply a private outside-repository artifact directory")
    const originals: Record<string, unknown> = {}, final: Record<string, unknown> = {}
    const artifact = () => writeFileSync(join(artifactRoot, "singleton-originals.json"), JSON.stringify({ tenant: LAB_8C_TENANT, originals, verifiedEndState: final }, null, 2), { mode: 0o600 })
    lab = configuration8cLab(answer.access_token, LAB_8C_TENANT, LAB_8C_APP, fetch, {
      recordEvidence: event => appendFileSync(join(artifactRoot, "evidence.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 }),
      recordOriginal: (folder, original) => {
        // Only non-personal settings are retained in the review artifact.
        if (!LAB_8C_FOLDERS.includes(folder)) return
        originals[folder] = original; artifact()
      },
      recordVerified: (folder, original) => { if (folder in originals) { final[folder] = original; artifact() } },
      save: (folder, original) => {
        const file = openSync(join(recoveryRoot, folder + ".json"), "wx", 0o600)
        try { writeSync(file, JSON.stringify({ folder, tenant: LAB_8C_TENANT, original })); fsyncSync(file) } finally { closeSync(file) }
      },
      clear: folder => { const file = join(recoveryRoot, folder + ".json"); if (existsSync(file)) unlinkSync(file) },
    })
    await lab.captureOriginals()
  }, 300_000)
  afterAll(async () => { try { await lab?.verifyEndState() } finally { lab = undefined } }, 300_000)
  for (const folder of folders) it(folder, async () => {
    console.log(`Verifying ${folder}`)
    try { const result = await lab!.run(folder); expect(result).toMatchObject({ folder }); console.log(`${folder}: ${result.operations}`) }
    finally { await lab!.cleanup() }
  }, 300_000)
})
