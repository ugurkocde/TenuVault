import { afterEach, describe, expect, it } from "vitest"
import { requireServiceAccess } from "../src/main/services/access"
import { setRestoreJournalAuthorization, setRestoreJournalStore } from "../src/main/storage/restore-journal"
import { POST } from "../src/portal/app/api/restore-journal/route"
import type { ModuleId } from "../src/shared/services/modules"
import { memoryStore } from "./helpers"

/** What the restore history route answers when the tenant may not open it. */

const TENANT = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"
const list = () => POST(new Request("http://localhost/api/restore-journal", { method: "POST", body: JSON.stringify({ tenantId: TENANT, action: "list" }) }))
const authorizeWith = (services: ModuleId[], answer: () => Response) =>
  setRestoreJournalAuthorization(() => requireServiceAccess({ services, areas: {} }, async () => answer(), "this tenant's restore history"))

describe("restore history refusals", () => {
  afterEach(() => setRestoreJournalAuthorization(async () => { throw new Error("Sign in to this tenant before opening restore history.") }))

  it("tells a tenant without Intune and Conditional Access which service to turn on", async () => {
    setRestoreJournalStore(memoryStore())
    for (const services of [[], ["entra"], ["defender"]] as ModuleId[][]) {
      authorizeWith(services, () => Response.json({ value: [] }))
      const response = await list()
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "Turn on Intune or Entra Conditional Access for this tenant in Settings before opening this tenant's restore history." })
    }
  })

  it("keeps the one general answer for every other refusal, so nothing about the account is told", async () => {
    setRestoreJournalStore(memoryStore())
    const general = { error: "Sign in with a license and management access to this tenant before viewing or changing restore history." }
    authorizeWith(["intune"], () => Response.json({ error: { message: "Forbidden for admin@contoso.com" } }, { status: 403 }))
    expect(await (await list()).json()).toEqual(general)
    setRestoreJournalAuthorization(async () => { throw new Error("The license key ABC-123 does not cover this tenant.") })
    const response = await list()
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(general)
  })

  it("opens the history for a tenant whose service answers", async () => {
    setRestoreJournalStore(memoryStore())
    authorizeWith(["conditionalAccess"], () => Response.json({ value: [{ id: "p1" }] }))
    const response = await list()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ records: [] })
  })
})
