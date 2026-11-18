import { expect, it } from "vitest"
import { ModuleSettings } from "../src/main/services/settings"
import { additionPermissions } from "../src/main/services/addition-permissions"
import { graphPermissions } from "../src/shared/services/manifest"
function settings() { const saved = new Map<string, string>(); return new ModuleSettings({ get: key => saved.get(key) ?? null, set: (key, value) => { saved.set(key, value) }, delete: key => { saved.delete(key) } }) }
it("requests no tenant write scopes for backup and keeps today's Intune restore permissions", () => {
  const store = settings()
  store.setChoice("tenant", { intune: { access: "backup" } })
  const backup = additionPermissions(store.get("tenant"))
  expect(backup.some(name => name.includes("ReadWrite"))).toBe(false)
  store.setAccess("tenant", "intune", "restore")
  const restore = additionPermissions(store.get("tenant"))
  expect(restore).toEqual(graphPermissions({ intune: { access: "restore" } }, "delegated"))
  expect(restore).toContain("DeviceManagementManagedDevices.Read.All")
  expect(restore).not.toContain("DeviceManagementManagedDevices.ReadWrite.All")
})
it("limits additions to enabled services and selected opt-in areas, with no unsupported restore access", () => {
  const store = settings()
  store.setChoice("tenant", { entra: { access: "backup" } })
  const original = additionPermissions(store.get("tenant"))
  expect(original).not.toContain("Group.Read.All")
  store.setArea("tenant", "entra", "groups", true)
  expect(additionPermissions(store.get("tenant"))).toContain("Group.Read.All")
  store.setAccess("tenant", "entra", "restore")
  expect(additionPermissions(store.get("tenant"))).toEqual(graphPermissions({ entra: { access: "restore", areas: ["groups"] } }, "delegated"))
  store.set("tenant", "entra", false)
  expect(additionPermissions(store.get("tenant"))).toEqual(["User.Read", "Organization.Read.All"])
})
