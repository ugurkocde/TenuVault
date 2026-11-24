import { expect, it } from "vitest"
import { graphPermissions } from "../src/shared/services/manifest"
import { canRequestRestore, hasOnboardingBackups, checkedOnboardingChoice, choiceLabel, DEFAULT_ONBOARDING_CHOICE, onboardingPermissions } from "../src/shared/services/onboarding"
import { checkOnboardingPermissions, saveOnboardingServices } from "../src/main/services/onboarding"
import { ModuleSettings } from "../src/main/services/settings"

it("defaults to Intune backup access and keeps the legacy Conditional Access read permission when requested", () => {
  expect(DEFAULT_ONBOARDING_CHOICE).toEqual({ intune: { access: "backup" } })
  expect(onboardingPermissions(DEFAULT_ONBOARDING_CHOICE)).toEqual({ intune: { access: "backup" }, conditionalAccess: { access: "backup" } })
  expect(choiceLabel({ intune: { access: "restore" }, entra: { access: "backup" } })).toBe("Entra ID and Intune")
  expect(choiceLabel({})).toBe("a service")
  expect(hasOnboardingBackups(DEFAULT_ONBOARDING_CHOICE)).toBe(true)
  expect(hasOnboardingBackups({ entra: { access: "backup" } })).toBe(true)
})
it("offers restore only where a writable backup type exists", () => {
  expect(canRequestRestore("intune")).toBe(true)
  expect(canRequestRestore("conditionalAccess")).toBe(true)
  expect(canRequestRestore("entra")).toBe(true)
  expect(checkedOnboardingChoice({ entra: { access: "restore" } })).toEqual({ entra: { access: "restore" } })
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
  expect(await checkOnboardingPermissions(choice, async () => token(graphPermissions(choice, "delegated").join(" ")))).toMatchObject({ missing: [] })
  expect(await checkOnboardingPermissions(choice, async () => ({ accessToken: "unreadable" }))).toMatchObject({ missing: [], error: expect.any(String) })
  expect(await checkOnboardingPermissions(choice, async () => { throw new Error("Offline") })).toMatchObject({ missing: [], error: "Offline" })
})
