import { expect, it } from "vitest"
import { DEFAULT_SETUP_CHOICE, graphPermissions } from "../src/shared/services/manifest"
import { canRequestRestore, hasOnboardingBackups, checkedOnboardingChoice, choiceLabel, DEFAULT_ONBOARDING_CHOICE, onboardingPermissions } from "../src/shared/services/onboarding"
import { checkOnboardingPermissions, saveOnboardingServices } from "../src/main/services/onboarding"
import { ModuleSettings } from "../src/main/services/settings"

it("keeps today's exact default permissions while enabling only Intune backups", () => {
  expect(onboardingPermissions(DEFAULT_ONBOARDING_CHOICE)).toEqual(DEFAULT_SETUP_CHOICE)
  expect(graphPermissions(onboardingPermissions(DEFAULT_ONBOARDING_CHOICE), "delegated")).toEqual(graphPermissions(DEFAULT_SETUP_CHOICE, "delegated"))
  expect(choiceLabel({ intune: { access: "restore" }, entra: { access: "backup" } })).toBe("Entra ID and Intune")
  expect(choiceLabel({ intune: { access: "restore" }, conditionalAccess: { access: "backup" }, defender: { access: "backup" } })).toBe("Defender, Entra ID (Conditional Access) and Intune")
  expect(choiceLabel({})).toBe("a service")
  expect(hasOnboardingBackups(DEFAULT_ONBOARDING_CHOICE)).toBe(true)
  expect(hasOnboardingBackups({ entra: { access: "backup" } })).toBe(true)
  expect(hasOnboardingBackups({ defender: { access: "backup" } })).toBe(true)
})
it("offers restore only where a writable backup type exists", () => {
  expect(canRequestRestore("intune")).toBe(true)
  expect(canRequestRestore("conditionalAccess")).toBe(true)
  expect(canRequestRestore("entra")).toBe(true)
  expect(checkedOnboardingChoice({ entra: { access: "restore" } })).toEqual({ entra: { access: "restore" } })
  for (const id of ["defender"] as const) {
    expect(canRequestRestore(id)).toBe(false)
    expect(() => checkedOnboardingChoice({ [id]: { access: "restore" } })).toThrow("not available")
  }
  expect(() => checkedOnboardingChoice({})).toThrow()
})
it("saves all service and area settings in one write before a non-Intune tenant can run", () => {
  const store = new Map<string, string>()
  let writes = 0
  const settings = new ModuleSettings({ get: key => store.get(key) ?? null, set: (key, value) => { writes++; store.set(key, value) }, delete: key => store.delete(key) })
  saveOnboardingServices(settings, "TENANT", { entra: { access: "backup", areas: ["groups"] } })
  expect(writes).toBe(1)
  expect(settings.selection("tenant")).toEqual({ services: ["entra"], areas: { entra: ["groups"] } })
  expect(settings.get("tenant").intune.enabled).toBe(false)
  expect(settings.get("tenant").entra.access).toBe("backup")
  saveOnboardingServices(settings, "other", DEFAULT_ONBOARDING_CHOICE)
  expect(settings.selection("other").services).toEqual(["intune"])
})
it("reports chosen missing permissions from a token and leaves unknown checks advisory", async () => {
  const choice = { entra: { access: "backup" as const } }
  const token = (scp: string) => ({ accessToken: `x.${Buffer.from(JSON.stringify({ scp })).toString("base64url")}.x` })
  expect((await checkOnboardingPermissions(choice, async () => token("User.Read Organization.Read.All"))).missing).toContain("Policy.Read.All")
  expect(await checkOnboardingPermissions(choice, async () => token(graphPermissions(choice, "delegated").join(" ")))).toEqual({ missing: [] })
  expect(await checkOnboardingPermissions(choice, async () => ({ accessToken: "unreadable" }))).toMatchObject({ missing: [], error: expect.any(String) })
  expect(await checkOnboardingPermissions(choice, async () => { throw new Error("Offline") })).toEqual({ missing: [], error: "Offline" })
})
