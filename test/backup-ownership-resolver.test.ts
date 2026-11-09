import { describe, expect, it, vi } from "vitest"
import { DAMAGED_OWNER_MARKER, resolveBackupOwnership, type OwnershipFile } from "../src/shared/backup-ownership"
import { BACKUP_OWNER_FILE } from "../src/shared/constants"

const A = "11111111-1111-1111-1111-111111111111"
const B = "22222222-2222-2222-2222-222222222222"
const found = (value: unknown): OwnershipFile => ({ kind: "found", value })
const missing: OwnershipFile = { kind: "missing" }

function reader(manifest: OwnershipFile, marker: OwnershipFile) {
  return vi.fn(async (file: string) => file === "metadata.json" ? manifest : marker)
}

describe("the shared backup ownership resolver", () => {
  it("takes the tenant from the manifest without reading the marker", async () => {
    const read = reader(found({ TenantId: A.toUpperCase(), Status: "Success" }), found({ TenantId: B }))
    const result = await resolveBackupOwnership(read, A)
    expect(result.owner).toMatchObject({ kind: "owned", source: "manifest" })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("places a manifest that names no tenant, or a missing one, by the marker", async () => {
    expect((await resolveBackupOwnership(reader(found({ Status: "Success" }), found({ TenantId: B, RunId: "run" })), A)).owner).toEqual({ kind: "other", tenantId: B, source: "marker", runId: "run" })
    expect((await resolveBackupOwnership(reader(missing, found({ TenantId: A })), A))).toMatchObject({ manifest: { kind: "missing" }, owner: { kind: "owned", source: "marker" } })
  })

  it("is untagged only without any tenant evidence", async () => {
    expect((await resolveBackupOwnership(reader(found({ Status: "Success" }), missing), A)).owner).toEqual({ kind: "untagged" })
    expect((await resolveBackupOwnership(reader(missing, missing), A)).owner).toEqual({ kind: "untagged" })
  })

  it("treats a marker that names no tenant, or a failed marker read, as unreadable", async () => {
    for (const value of [{ Source: "TenuVault Desktop" }, "text", null, []]) {
      const { owner } = await resolveBackupOwnership(reader(missing, found(value)), A)
      expect(owner).toMatchObject({ kind: "unreadable", error: new Error(DAMAGED_OWNER_MARKER) })
    }
    const error = new Error("sealed")
    expect((await resolveBackupOwnership(reader(missing, { kind: "unreadable", error }), A)).owner).toEqual({ kind: "unreadable", error })
  })

  it("reports a manifest that is not a JSON object as unreadable and still places the folder by its marker", async () => {
    const result = await resolveBackupOwnership(reader(found("not an object"), found({ TenantId: B })), A)
    expect(result.manifest).toMatchObject({ kind: "unreadable" })
    expect(result.owner).toMatchObject({ kind: "other", tenantId: B })
  })

  it("lets a failure the caller cannot classify stop it", async () => {
    const read = vi.fn(async (file: string) => { if (file === BACKUP_OWNER_FILE) throw new Error("network"); return missing })
    await expect(resolveBackupOwnership(read, A)).rejects.toThrow("network")
  })
})
