import { expect, it, vi } from "vitest"
import { directoryObjectStep, directoryRelationshipSteps } from "../src/main/restore/directory-9a-plan"
import { directory9aIO } from "../src/main/restore/directory-9a-io"
import { previewDirectoryPage } from "../src/main/restore/directory-9a"
const id = "00000000-0000-4000-8000-000000000001", manager = "00000000-0000-4000-8000-000000000002"
const actor = { tenantId: "tenant", userId: "admin", clientId: "client", recoveryAccountIds: [] }
const token = `header.${Buffer.from(JSON.stringify({ tid: "tenant", oid: "admin", appid: "client", scp: "User.Read.All Group.Read.All" })).toString("base64url")}.signature`
const ioFor = (mode: "absent" | "live" | "deleted") => directory9aIO(token, actor, async () => ({ complete: true, principals: [], applications: [] }), vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname
  if (path === `/v1.0/users/${manager}`) return Response.json({ id: manager, displayName: "Manager" })
  if (path.endsWith("/manager")) return Response.json({ id: manager })
  if (path.includes("deletedItems")) return mode === "deleted" ? Response.json({ id, displayName: "Deleted user" }) : new Response(null, { status: 404 })
  return mode === "live" ? Response.json({ id, displayName: "User", assignedLicenses: [] }) : new Response(null, { status: 404 })
}))
it("creates from a real backup schema without mailNickname and distinguishes recycle, update and guest invitation", async () => {
  const snapshot = { id, displayName: "Saved", userPrincipalName: "saved@example.com", userType: "Member" }
  expect((await directoryObjectStep("Users", snapshot, ioFor("absent"))).desired).toMatchObject({ mailNickname: "saved", accountEnabled: false })
  expect((await directoryObjectStep("Users", snapshot, ioFor("deleted"))).directory?.action).toBe("recycle")
  expect((await directoryObjectStep("Users", snapshot, ioFor("live"))).directory?.action).toBe("update")
  const guest = { ...snapshot, userType: "Guest", mail: "guest@example.com" }
  const invitation = await directoryObjectStep("Users", guest, ioFor("absent"), "https://myapps.microsoft.com")
  expect(invitation.directory?.action).toBe("invite")
  expect(invitation.desired).toMatchObject({ invitedUserEmailAddress: guest.mail, sendInvitationMessage: false })
  await expect(directoryObjectStep("Users", guest, ioFor("absent"))).rejects.toThrow("Review a guest")
  await expect(directoryObjectStep("Users", { ...guest, onPremisesSyncEnabled: true }, ioFor("absent"), "https://myapps.microsoft.com")).rejects.toThrow("source directory")
  await expect(directoryObjectStep("Users", snapshot, ioFor("absent"), undefined, "00000000-0000-4000-8000-000000000003")).rejects.toThrow("mapped")
})
it("gives manager and each user license their own lazy preview row", async () => {
  const rows = await previewDirectoryPage(directoryRelationshipSteps("Users", id, id, { manager: { id: manager, complete: true }, assignedLicenses: [{ skuId: id, disabledPlans: [] }, { skuId: manager, disabledPlans: [] }] }, ioFor("live")))
  expect(rows.map(step => step.directory?.action)).toEqual(["manager", "license", "license"])
  expect(rows.every(step => step.preview.length === 64)).toBe(true)
  await expect(previewDirectoryPage(directoryRelationshipSteps("Users", id, id, { manager: { id: manager } }, ioFor("live")))).rejects.toThrow("incomplete")
})
it("keeps group exact choices separate, maps principals before preview and never writes dynamic members", async () => {
  async function* empty() { /* No relationships. */ }
  async function* current() { yield manager }
  const live = ioFor("live")
  const relation = { members: { saved: empty(), current: current() }, owners: { saved: empty(), current: current() }, exactMembers: true, mapPrincipal: async () => manager }
  const rows = await previewDirectoryPage(directoryRelationshipSteps("Groups", id, id, {}, live, relation))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ allowRemoval: true, desired: { present: false, principalId: manager }, directory: { exact: true, action: "member" } })
  const dynamic = { members: { saved: empty(), current: current() }, owners: { saved: empty(), current: empty() }, exactMembers: true, mapPrincipal: async () => manager }
  expect(await previewDirectoryPage(directoryRelationshipSteps("Groups", id, id, { groupTypes: ["DynamicMembership"] }, live, dynamic))).toEqual([])
})
