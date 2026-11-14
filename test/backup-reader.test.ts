import { mkdtempSync } from "node:fs"
import { X509Certificate, createPrivateKey } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BackupReaderError, BackupReaderService, checkReaderToken, readerConfidenceRead, type AcquireToken } from "../src/main/auth/backup-reader"
import { certificateIdentity, createSelfSignedCertificate } from "../src/main/auth/certificate"
import { SecureStore } from "../src/main/storage/secure-store"
import { readerRoles } from "../src/shared/services/manifest"
import { MODULES, type ServiceSelection } from "../src/shared/services/modules"

// The Backup Reader's permissions as they were before services could be chosen, written out here so
// a change to the permission manifest that moves them fails these tests.
const READER_REQUIRED_ROLES = ["DeviceManagementApps.Read.All", "DeviceManagementConfiguration.Read.All", "DeviceManagementRBAC.Read.All", "DeviceManagementScripts.Read.All", "DeviceManagementServiceConfig.Read.All"]
const DEVICE_INVENTORY_ROLE = "DeviceManagementManagedDevices.Read.All"
const DEVICE_INVENTORY_TYPES = ["DeviceCategories", "DeviceCleanupRules"]
const CONDITIONAL_ACCESS_ROLE = "Policy.Read.All"
const CONDITIONAL_ACCESS_TYPES = ["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"]
/** A tenant that backs up Intune and Conditional Access, the two services that existed before. */
const CLASSIC: ServiceSelection = { services: ["intune", "conditionalAccess"] }

const TENANT = "11111111-1111-1111-1111-111111111111"
const READER = "44444444-4444-4444-4444-444444444444"
const cipher = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
const store = () => new SecureStore(join(mkdtempSync(join(tmpdir(), "tv-reader-")), "store.enc"), cipher)

/** An unsigned JWT with the given claims; the reader only decodes claims, it never verifies signatures. */
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const graphToken = (overrides: Record<string, unknown> = {}) =>
  jwt({ aud: "https://graph.microsoft.com", tid: TENANT, appid: READER, idtyp: "app", roles: [...READER_REQUIRED_ROLES], ...overrides })
const storageToken = (overrides: Record<string, unknown> = {}) => jwt({ aud: "https://storage.azure.com", tid: TENANT, appid: READER, idtyp: "app", ...overrides })

function service(options: { graph?: () => string; now?: string; selection?: ServiceSelection; store?: SecureStore } = {}) {
  let graph = options.graph ?? (() => graphToken())
  let selection = options.selection ?? CLASSIC
  const acquire = vi.fn<AcquireToken>(async (_app, scope) => ({ accessToken: scope.includes("storage") ? storageToken() : graph() }))
  const reader = new BackupReaderService(options.store ?? store(), { acquire, now: () => new Date(options.now ?? "2026-10-26T12:00:00Z"), services: () => selection })
  return { reader, acquire, setGraph: (next: () => string) => { graph = next }, setSelection: (next: ServiceSelection) => { selection = next } }
}

const scheduled = { tenantId: TENANT, clientId: "22222222-2222-2222-2222-222222222222", storageAccountName: "contoso", trigger: "scheduled" as const }

describe("self-signed certificate", () => {
  it("is a valid X.509 certificate for the generated key, with a matching SHA-256 thumbprint", () => {
    const generated = createSelfSignedCertificate("TenuVault Backup Reader (LAPTOP-1)", 365, new Date("2026-10-26T00:00:00Z"))
    const certificate = new X509Certificate(generated.certificatePem)
    expect(certificate.subject).toBe("CN=TenuVault Backup Reader (LAPTOP-1)")
    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.checkPrivateKey(createPrivateKey(generated.privateKeyPem))).toBe(true)
    expect(certificate.fingerprint256.replaceAll(":", "")).toBe(generated.thumbprintSha256)
    expect(new Date(certificate.validTo).toISOString()).toBe("2027-10-26T00:00:00.000Z")
  })

  it("encodes validity after 2049 as GeneralizedTime", () => {
    const certificate = new X509Certificate(createSelfSignedCertificate("x", 3650, new Date("2045-01-01T00:00:00Z")).certificatePem)
    expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2054)
  })
})

describe("checkReaderToken", () => {
  const app = { tenantId: TENANT, clientId: READER }

  it("accepts an app-only Graph token with exactly the read roles", () => {
    expect(checkReaderToken(graphToken(), app, "graph")).toEqual([...READER_REQUIRED_ROLES].sort())
    expect(checkReaderToken(graphToken({ roles: [...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE] }), app, "graph")).toContain(DEVICE_INVENTORY_ROLE)
  })

  it.each([
    ["a write role", { roles: [...READER_REQUIRED_ROLES, "DeviceManagementConfiguration.ReadWrite.All"] }, /beyond read-only backup: DeviceManagementConfiguration.ReadWrite.All/],
    ["a read role that backs up no service", { roles: [...READER_REQUIRED_ROLES, "Mail.Read"] }, /beyond read-only backup: Mail.Read/],
    ["the write role of a service that is off", { roles: [...READER_REQUIRED_ROLES, "Policy.ReadWrite.Authorization"] }, /beyond read-only backup: Policy.ReadWrite.Authorization/],
    ["a missing role", { roles: READER_REQUIRED_ROLES.slice(1) }, /missing permissions or their admin consent: DeviceManagementApps.Read.All/],
    ["another tenant", { tid: "99999999-9999-9999-9999-999999999999" }, /different tenant/],
    ["another app", { appid: "99999999-9999-9999-9999-999999999999" }, /different app registration/],
    ["another audience", { aud: "https://management.azure.com" }, /different resource/],
    ["a delegated token", { scp: "DeviceManagementConfiguration.Read.All", idtyp: "user" }, /not an app-only token/],
  ])("refuses a token with %s", (_case, overrides, message) => {
    expect(() => checkReaderToken(graphToken(overrides), app, "graph")).toThrow(message)
  })

  it("checks storage tokens for tenant, app and audience", () => {
    expect(checkReaderToken(storageToken(), app, "storage")).toEqual([])
    expect(() => checkReaderToken(storageToken({ appid: "99999999-9999-9999-9999-999999999999" }), app, "storage")).toThrow(BackupReaderError)
    expect(() => checkReaderToken(graphToken(), app, "storage")).toThrow(/different resource/)
  })

  it("refuses an unreadable token", () => {
    expect(() => checkReaderToken("not-a-jwt", app, "graph")).toThrow(/cannot read/)
  })
})

describe("BackupReaderService", () => {
  it("offers no tokens until the reader is verified", async () => {
    const { reader } = service()
    expect(reader.tokens(scheduled)).toBeNull()
    const pending = reader.prepare(TENANT, "LAPTOP-1")
    expect(pending.state).toBe("pending")
    expect(pending.certificatePem).toContain("BEGIN CERTIFICATE")
    expect(JSON.stringify(pending)).not.toContain("PRIVATE KEY")
    expect(reader.tokens(scheduled)).toBeNull()
  })

  it("keeps a waiting certificate, so the uploaded file always matches", () => {
    const { reader } = service()
    expect(reader.prepare(TENANT, "LAPTOP-1").thumbprintSha256).toBe(reader.prepare(TENANT, "LAPTOP-1").thumbprintSha256)
  })

  it("verifies the reader, records its roles and leaves out the device inventory types without that permission", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    const verified = await reader.verify(TENANT, READER)
    expect(verified.state).toBe("verified")
    expect(verified.verifiedRoles).toEqual([...READER_REQUIRED_ROLES].sort())
    expect(verified.excludedTypes).toEqual([...DEVICE_INVENTORY_TYPES, ...CONDITIONAL_ACCESS_TYPES])

    const tokens = reader.tokens(scheduled)!
    expect(tokens.mode).toBe("app-only")
    expect(tokens.excludedTypes).toEqual([...DEVICE_INVENTORY_TYPES, ...CONDITIONAL_ACCESS_TYPES])
    expect(await tokens.graph()).toBe(graphToken())
    expect(await tokens.storage()).toBe(storageToken())
  })

  it("includes the device inventory types when the reader has that permission", async () => {
    const { reader } = service({ graph: () => graphToken({ roles: [...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    expect((await reader.verify(TENANT, READER)).excludedTypes).toEqual(CONDITIONAL_ACCESS_TYPES)
  })

  it("includes the Conditional Access types when the reader may read Entra policies, and never accepts a write role for them", async () => {
    const { reader } = service({ graph: () => graphToken({ roles: [...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE, CONDITIONAL_ACCESS_ROLE] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    expect((await reader.verify(TENANT, READER)).excludedTypes).toEqual([])
    expect(CONDITIONAL_ACCESS_TYPES).toEqual(["NamedLocations", "AuthenticationStrengths", "ConditionalAccessPolicies"])
    const app = { tenantId: TENANT, clientId: READER }
    expect(() => checkReaderToken(graphToken({ roles: [...READER_REQUIRED_ROLES, "Policy.ReadWrite.ConditionalAccess"] }), app, "graph")).toThrow(/beyond read-only backup: Policy.ReadWrite.ConditionalAccess/)
  })

  it("refuses to verify a reader with write permissions and keeps it unverified", async () => {
    const { reader } = service({ graph: () => graphToken({ roles: [...READER_REQUIRED_ROLES, "DeviceManagementApps.ReadWrite.All"] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    await expect(reader.verify(TENANT, READER)).rejects.toThrow(/beyond read-only backup/)
    expect(reader.status(TENANT)!.state).toBe("pending")
    expect(reader.tokens(scheduled)).toBeNull()
  })

  it("keeps running when a role was removed after verification, leaves its types to Microsoft Graph and asks for a new verification", async () => {
    const { reader, setGraph } = service({ graph: () => graphToken({ roles: [...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    expect(reader.status(TENANT)!.roleChange).toBeNull()
    setGraph(() => graphToken())
    // The scheduled backup still gets the reader's token: it never moves to the admin's sign-in by itself.
    const tokens = reader.tokens(scheduled)!
    expect(tokens.mode).toBe("app-only")
    expect(await tokens.graph()).toBe(graphToken())
    expect(reader.status(TENANT)!.roleChange).toEqual({ added: [], removed: [DEVICE_INVENTORY_ROLE], at: "2026-10-26T12:00:00.000Z" })
    expect(reader.status(TENANT)!.state).toBe("verified")
    // Verifying again in place takes the roles as they are now and ends the notice.
    const verified = await reader.verify(TENANT, READER)
    expect(verified.roleChange).toBeNull()
    expect(verified.excludedTypes).toEqual([...DEVICE_INVENTORY_TYPES, ...CONDITIONAL_ACCESS_TYPES])
  })

  it("forgets a noted change once the roles match the verified ones again", async () => {
    const { reader, setGraph } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    setGraph(() => graphToken({ roles: [...READER_REQUIRED_ROLES, CONDITIONAL_ACCESS_ROLE] }))
    await reader.tokens(scheduled)!.graph()
    expect(reader.status(TENANT)!.roleChange).toMatchObject({ added: [CONDITIONAL_ACCESS_ROLE], removed: [] })
    setGraph(() => graphToken())
    await reader.tokens(scheduled)!.graph()
    expect(reader.status(TENANT)!.roleChange).toBeNull()
  })

  it("reports Microsoft's refusal with its code and no token material", async () => {
    const acquire: AcquireToken = async () => { throw new Error("AADSTS700027: Client assertion contains an invalid signature. Trace ID: abc") }
    const reader = new BackupReaderService(store(), { acquire })
    reader.prepare(TENANT, "LAPTOP-1")
    const error = await reader.verify(TENANT, READER).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BackupReaderError)
    expect((error as Error).message).toBe("Microsoft refused the Backup Reader (AADSTS700027). Microsoft does not know this certificate. Upload the exported certificate with the setup script, then verify again.")
  })

  it("passes a network failure through unchanged, so the backup counts as unreachable", async () => {
    const offline = new TypeError("fetch failed")
    const backing = store()
    const working = new BackupReaderService(backing, { acquire: async () => ({ accessToken: graphToken() }) })
    working.prepare(TENANT, "LAPTOP-1")
    await working.verify(TENANT, READER)
    const reader = new BackupReaderService(backing, { acquire: async () => { throw offline } })
    await expect(reader.tokens(scheduled)!.graph()).rejects.toBe(offline)
  })

  it("rejects an application ID that is not a GUID", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await expect(reader.verify(TENANT, "my-app")).rejects.toThrow(/application \(client\) ID/)
  })

  it("renews with a second certificate and keeps using the active one until the renewal is verified", async () => {
    const { reader, acquire } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    const first = await reader.verify(TENANT, READER)
    const renewal = reader.prepare(TENANT, "LAPTOP-1")
    expect(renewal.renewalPending).toBe(true)
    expect(renewal.thumbprintSha256).not.toBe(first.thumbprintSha256)

    await reader.tokens(scheduled)!.graph()
    expect(acquire.mock.calls.at(-1)![0].certificate.thumbprintSha256).toBe(first.thumbprintSha256)

    const renewed = await reader.verify(TENANT, READER, { renewal: true })
    expect(renewed.renewalPending).toBe(false)
    expect(renewed.thumbprintSha256).toBe(renewal.thumbprintSha256)
    await reader.tokens(scheduled)!.graph()
    expect(acquire.mock.calls.at(-1)![0].certificate.thumbprintSha256).toBe(renewal.thumbprintSha256)
  })

  it("shows the portal thumbprint and computer name of the certificate", () => {
    const generated = createSelfSignedCertificate("TenuVault Backup Reader (LAPTOP-1)", 365, new Date("2026-10-26T00:00:00Z"))
    const certificate = new X509Certificate(generated.certificatePem)
    const identity = certificateIdentity(generated.certificatePem)
    // Entra ID and the setup script print the SHA-1 fingerprint; MSAL uses SHA-256.
    expect(identity.thumbprint).toBe(certificate.fingerprint.replaceAll(":", ""))
    expect(identity.thumbprint).not.toBe(generated.thumbprintSha256)
    expect(identity.name).toBe("TenuVault Backup Reader (LAPTOP-1)")
    const { reader } = service()
    expect(reader.prepare(TENANT, "LAPTOP-1")).toMatchObject({ certificateName: "TenuVault Backup Reader (LAPTOP-1)" })
    expect(reader.status(TENANT)!.thumbprint).toMatch(/^[0-9A-F]{40}$/)
  })

  it("remembers the saved certificate, tests and app-only runs, and drops a stale test on re-verify", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    reader.recordExport(TENANT, "TenuVault Backup Reader ABCD.cer")
    expect(reader.status(TENANT)!.exportedCertificate?.fileName).toBe("TenuVault Backup Reader ABCD.cer")
    await reader.verify(TENANT, READER)
    reader.recordTest(TENANT, { graph: true, storage: false, message: "no container" })
    reader.recordRun(TENANT, "Completed")
    expect(reader.status(TENANT)!.lastTest).toMatchObject({ graph: true, storage: false })
    expect(reader.status(TENANT)!.lastRun?.status).toBe("Completed")
    expect(reader.status(TENANT)!.verifiedAt).toBeTruthy()
    await reader.verify(TENANT, READER)
    expect(reader.status(TENANT)!.lastTest).toBeNull()
    // A new (renewal) certificate hides the export record of the previous one.
    reader.prepare(TENANT, "LAPTOP-1")
    expect(reader.status(TENANT)!.exportedCertificate).toBeNull()
  })

  it("verifies the active certificate again while a renewal waits, and keeps the renewal", async () => {
    const { reader, acquire } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    const first = await reader.verify(TENANT, READER)
    reader.prepare(TENANT, "LAPTOP-1")
    const again = await reader.verify(TENANT, READER)
    expect(acquire.mock.calls.at(-1)![0].certificate.thumbprintSha256).toBe(first.thumbprintSha256)
    expect(again.renewalPending).toBe(true)
  })

  it("asks Microsoft for a new token on every verification, so new permissions show at once", async () => {
    const { reader, acquire } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    expect(acquire.mock.calls.at(-1)![2]).toEqual({ fresh: true })
    await reader.tokens(scheduled)!.graph()
    expect(acquire.mock.calls.at(-1)![2]).toBeUndefined()
  })

  it("discards a renewal that was not uploaded and keeps the active certificate", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    const first = await reader.verify(TENANT, READER)
    reader.prepare(TENANT, "LAPTOP-1")
    const cancelled = reader.cancelRenewal(TENANT)!
    expect(cancelled).toMatchObject({ state: "verified", renewalPending: false, thumbprintSha256: first.thumbprintSha256 })
    await expect(reader.verify(TENANT, READER, { renewal: true })).rejects.toThrow(/No renewal certificate is waiting/)
  })

  it("stops a scheduled backup only for refusals a retry cannot fix", async () => {
    const backing = store()
    const working = new BackupReaderService(backing, { acquire: async () => ({ accessToken: graphToken() }) })
    working.prepare(TENANT, "LAPTOP-1")
    await working.verify(TENANT, READER)
    const transient = new Error("AADSTS90033: A transient error has occurred. Please try again.")
    const retried = new BackupReaderService(backing, { acquire: async () => { throw transient } })
    await expect(retried.tokens(scheduled)!.graph()).rejects.toBe(transient)
    const disabled = new BackupReaderService(backing, { acquire: async () => { throw new Error("AADSTS7000112: Application is disabled.") } })
    await expect(disabled.tokens(scheduled)!.graph()).rejects.toThrow(/AADSTS7000112.*disabled/)
    await expect(disabled.tokens(scheduled)!.graph()).rejects.toBeInstanceOf(BackupReaderError)
  })

  it("still explains a transient refusal when the admin verifies", async () => {
    const acquire: AcquireToken = async () => { throw new Error("AADSTS90033: A transient error has occurred.") }
    const reader = new BackupReaderService(store(), { acquire })
    reader.prepare(TENANT, "LAPTOP-1")
    await expect(reader.verify(TENANT, READER)).rejects.toThrow("Microsoft refused the Backup Reader (AADSTS90033). Try again in a few minutes")
  })

  it("refuses to switch an active reader to another application ID", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    await expect(reader.verify(TENANT, "55555555-5555-5555-5555-555555555555")).rejects.toThrow(/different application ID/)
  })

  it("falls back to the admin's sign-in once the certificate has expired", async () => {
    const backing = store()
    const acquire: AcquireToken = async () => ({ accessToken: graphToken() })
    const today = new BackupReaderService(backing, { acquire, now: () => new Date("2026-10-26T12:00:00Z") })
    today.prepare(TENANT, "LAPTOP-1")
    await today.verify(TENANT, READER)
    const nextYear = new BackupReaderService(backing, { acquire, now: () => new Date("2027-10-27T12:00:00Z") })
    expect(nextYear.tokens(scheduled)).toBeNull()
  })

  it("forgets the reader on removal", async () => {
    const { reader } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    reader.remove(TENANT)
    expect(reader.status(TENANT)).toBeNull()
    expect(reader.tokens(scheduled)).toBeNull()
  })

  it("sets a corrupt stored credential aside and falls back to the admin's sign-in", () => {
    const backing = store()
    backing.set(`backupReader.${TENANT}`, "{corrupt")
    const reader = new BackupReaderService(backing, { acquire: async () => ({ accessToken: graphToken() }), now: () => new Date("2026-10-26T12:00:00Z") })
    expect(reader.status(TENANT)).toBeNull()
    expect(reader.tokens(scheduled)).toBeNull()
    const aside = backing.keys().filter((key) => key.startsWith(`backupReader.${TENANT}.unreadable.`))
    expect(aside).toHaveLength(1)
    expect(backing.get(aside[0]!)).toBe("{corrupt")
  })

  it("treats a legacy-shaped credential without certificates as not set up", () => {
    const backing = store()
    backing.set(`backupReader.${TENANT}`, JSON.stringify({ tenantId: TENANT }))
    const reader = new BackupReaderService(backing, { acquire: async () => ({ accessToken: graphToken() }), now: () => new Date("2026-10-26T12:00:00Z") })
    expect(reader.status(TENANT)).toBeNull()
    expect(reader.tokens(scheduled)).toBeNull()
    expect(reader.prepare(TENANT, "LAPTOP-1").state).toBe("pending")
  })
})

describe("Backup Reader per service", () => {
  const app = { tenantId: TENANT, clientId: READER }
  const ENTRA: ServiceSelection = { services: ["entra"] }
  const entraRoles = [...readerRoles({ entra: { access: "backup" } })]
  const folders = (id: string) => MODULES.find((module) => module.id === id)!.areas.flatMap((area) => area.folders)

  it("asks for the Intune roles only when the tenant backs up Intune", () => {
    expect(() => checkReaderToken(graphToken({ roles: entraRoles }), app, "graph", CLASSIC)).toThrow(/missing permissions or their admin consent: DeviceManagementApps.Read.All/)
    expect(checkReaderToken(graphToken({ roles: entraRoles }), app, "graph", ENTRA)).toEqual([...entraRoles].sort())
    expect(checkReaderToken(graphToken({ roles: [] }), app, "graph", { services: ["conditionalAccess", "entra", "defender"] })).toEqual([])
  })

  it("gives a scheduled backup of an Entra-only tenant the reader's token without any Intune role", async () => {
    expect(entraRoles.some((role) => role.startsWith("DeviceManagement"))).toBe(false)
    const { reader, acquire } = service({ selection: ENTRA, graph: () => graphToken({ roles: entraRoles }) })
    reader.prepare(TENANT, "LAPTOP-1")
    const verified = await reader.verify(TENANT, READER)
    expect(verified.state).toBe("verified")
    expect(verified.verifiedRoles).toEqual([...entraRoles].sort())
    // Left out is only what Microsoft Graph lets no app-only identity read.
    expect(verified.excludedTypes).toEqual(["MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization"])
    const tokens = reader.tokens(scheduled)!
    expect(tokens.mode).toBe("app-only")
    expect(await tokens.graph()).toBe(graphToken({ roles: entraRoles }))
    expect(tokens.excludedTypes).toEqual(verified.excludedTypes)
    // Verifying and the token for the run ask Microsoft for tokens only; no Intune request is part of either.
    expect(acquire.mock.calls.map(([, scope]) => scope)).toEqual(["https://graph.microsoft.com/.default", "https://graph.microsoft.com/.default"])
  })

  it("tests an Entra-only reader with an Entra read, never an Intune one", () => {
    expect(readerConfidenceRead(ENTRA, entraRoles)).toEqual({ label: "Entra ID", path: "policies/authorizationPolicy?$select=id" })
    expect(readerConfidenceRead({ services: ["defender"] }, [...readerRoles({ defender: { access: "backup" } })])?.path).toBe("security/secureScoreControlProfiles?$top=1&$select=id")
    expect(readerConfidenceRead(CLASSIC, READER_REQUIRED_ROLES)).toEqual({ label: "Intune", path: "deviceManagement/deviceCompliancePolicies?$top=1&$select=id" })
    // With Intune on but only the Conditional Access role held, the read is the Conditional Access one.
    expect(readerConfidenceRead(CLASSIC, [CONDITIONAL_ACCESS_ROLE])?.path).toBe("identity/conditionalAccess/policies?$top=1&$select=id")
    expect(readerConfidenceRead(ENTRA, READER_REQUIRED_ROLES)).toBeUndefined()
    for (const selection of [ENTRA, { services: ["defender" as const] }, { services: ["conditionalAccess" as const] }]) expect(readerConfidenceRead(selection, [...entraRoles, "SecurityEvents.Read.All"])?.path).not.toContain("deviceManagement")
  })

  it.each([
    ["without the Conditional Access role", READER_REQUIRED_ROLES, [...DEVICE_INVENTORY_TYPES, ...CONDITIONAL_ACCESS_TYPES]],
    ["with the Conditional Access role", [...READER_REQUIRED_ROLES, CONDITIONAL_ACCESS_ROLE], DEVICE_INVENTORY_TYPES],
    ["with the device inventory and Conditional Access roles", [...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE, CONDITIONAL_ACCESS_ROLE], []],
  ])("keeps a reader working that was verified before services could be chosen, %s", async (_name, roles, excluded) => {
    // The record as the previous version stored it: no field this version added.
    const backing = store()
    const certificate = createSelfSignedCertificate("TenuVault Backup Reader (LAPTOP-1)", 365, new Date("2026-10-01T00:00:00Z"))
    const record = { tenantId: TENANT, clientId: READER, active: certificate, pending: null, verifiedRoles: [...roles].sort(), verifiedAt: "2026-10-01T00:00:00.000Z", lastRun: { at: "2026-10-25T02:00:00.000Z", status: "Completed" } }
    backing.set(`backupReader.${TENANT}`, JSON.stringify(record))
    const { reader } = service({ store: backing, graph: () => graphToken({ roles }) })
    expect(reader.status(TENANT)).toMatchObject({ state: "verified", verifiedRoles: [...roles].sort(), excludedTypes: excluded, roleChange: null })
    const tokens = reader.tokens(scheduled)!
    expect(await tokens.graph()).toBe(graphToken({ roles }))
    expect(await tokens.storage()).toBe(storageToken())
    expect(tokens.excludedTypes).toEqual(excluded)
    // Nothing about the stored reader changed by using it.
    expect(JSON.parse(backing.get(`backupReader.${TENANT}`)!)).toEqual(record)
  })

  it("never refuses a reader for the roles of a service the tenant has turned off", async () => {
    const roles = [...READER_REQUIRED_ROLES, ...entraRoles, ...readerRoles({ defender: { access: "backup" } })]
    const { reader } = service({ selection: { services: ["intune"] }, graph: () => graphToken({ roles }) })
    reader.prepare(TENANT, "LAPTOP-1")
    const verified = await reader.verify(TENANT, READER)
    expect(verified.state).toBe("verified")
    expect(verified.excludedTypes).toEqual(DEVICE_INVENTORY_TYPES)
    await expect(reader.tokens(scheduled)!.graph()).resolves.toBeTruthy()
  })

  it("leaves out only the folders of a service that is on when the reader lacks a role for it", async () => {
    // A reader for Intune that also holds Policy.Read.All, in a tenant that backs up Intune and Entra ID.
    const { reader } = service({ selection: { services: ["intune", "entra"] }, graph: () => graphToken({ roles: [...READER_REQUIRED_ROLES, "Policy.Read.All"] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    const excluded = (await reader.verify(TENANT, READER)).excludedTypes
    expect(excluded).toContain("Domains")
    expect(excluded).toContain("EntraRoleDefinitions")
    // What Policy.Read.All reads stays in, and so does all of Intune apart from the device inventory types.
    expect(excluded).not.toContain("AuthorizationPolicy")
    expect(excluded.filter((folder) => folders("intune").includes(folder))).toEqual(DEVICE_INVENTORY_TYPES)
    expect(excluded.every((folder) => folders("intune").includes(folder) || folders("entra").includes(folder))).toBe(true)
  })

  it("keeps Intune schedules running when roles for another service are added to the reader, and asks for a new verification in place", async () => {
    const { reader, setGraph } = service({ selection: { services: ["intune", "entra"] } })
    reader.prepare(TENANT, "LAPTOP-1")
    const before = await reader.verify(TENANT, READER)
    expect(before.excludedTypes).toEqual([...DEVICE_INVENTORY_TYPES, ...folders("entra").filter((folder) => !MODULES.find((module) => module.id === "entra")!.areas.some((area) => area.optIn && area.folders.includes(folder)))])
    // The Entra administrator runs the script again with -Services Intune,Entra.
    const widened = [...READER_REQUIRED_ROLES, ...entraRoles]
    setGraph(() => graphToken({ roles: widened }))
    const tokens = reader.tokens(scheduled)!
    expect(await tokens.graph()).toBe(graphToken({ roles: widened }))
    // The run still reads only what was verified: the new roles wait for the admin.
    expect(tokens.excludedTypes).toEqual(before.excludedTypes)
    const noted = reader.status(TENANT)!
    expect(noted.state).toBe("verified")
    expect(noted.roleChange).toEqual({ added: [...entraRoles].sort(), removed: [], at: "2026-10-26T12:00:00.000Z" })
    // Verify again on the same reader: no new certificate, no removal.
    const after = await reader.verify(TENANT, READER)
    expect(after.thumbprintSha256).toBe(before.thumbprintSha256)
    expect(after.roleChange).toBeNull()
    expect(after.excludedTypes).toEqual([...DEVICE_INVENTORY_TYPES, "MdmEnrollmentPolicies", "MamEnrollmentPolicies", "OnPremisesSynchronization"])
  })

  it("refuses a reader that can read nothing the tenant backs up, and names the services to set it up for", async () => {
    const { reader } = service({ selection: ENTRA })
    reader.prepare(TENANT, "LAPTOP-1")
    await expect(reader.verify(TENANT, READER)).rejects.toThrow("The Backup Reader has no permission to read Entra ID, which is all this tenant backs up. Have your Entra administrator run the setup script with -Services Entra, then verify again.")
    expect(reader.status(TENANT)!.state).toBe("pending")
  })

  it("stops a scheduled backup with that reason when the tenant's services moved away from the reader, without falling back to the admin's sign-in", async () => {
    const { reader, setSelection } = service()
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    setSelection({ services: ["entra", "defender"] })
    // The reader is still offered, so the engine does not take the admin's sign-in instead.
    const tokens = reader.tokens(scheduled)
    expect(tokens).not.toBeNull()
    const error = await tokens!.graph().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BackupReaderError)
    expect((error as Error).message).toContain("no permission to read Entra ID or Defender")
    expect((error as Error).message).toContain("-Services Entra,Defender")
  })

  it("still refuses a role outside the manifest at verification and at every scheduled backup", async () => {
    const { reader, setGraph } = service({ selection: ENTRA, graph: () => graphToken({ roles: entraRoles }) })
    reader.prepare(TENANT, "LAPTOP-1")
    await reader.verify(TENANT, READER)
    setGraph(() => graphToken({ roles: [...entraRoles, "Directory.ReadWrite.All"] }))
    await expect(reader.tokens(scheduled)!.graph()).rejects.toThrow(/beyond read-only backup: Directory.ReadWrite.All/)
    await expect(reader.verify(TENANT, READER)).rejects.toThrow(/beyond read-only backup: Directory.ReadWrite.All/)
    // The earlier verification stays, so the reader works again once the role is removed.
    setGraph(() => graphToken({ roles: entraRoles }))
    await expect(reader.tokens(scheduled)!.graph()).resolves.toBeTruthy()
  })

  it("lets a tenant without any service on keep its reader", async () => {
    const { reader } = service({ selection: { services: [] }, graph: () => graphToken({ roles: [] }) })
    reader.prepare(TENANT, "LAPTOP-1")
    expect((await reader.verify(TENANT, READER)).excludedTypes).toEqual([])
  })
})
