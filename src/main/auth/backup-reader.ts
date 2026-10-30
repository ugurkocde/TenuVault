import { ConfidentialClientApplication, LogLevel } from "@azure/msal-node"
import type { BackupRequest, RunTokens } from "../backup/engine"
import type { BackupReaderStatus, BackupReaderTestResult } from "../../shared/ipc"
import type { SecureStore } from "../storage/secure-store"
import { RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid } from "../../shared/security"
import { certificateIdentity, createSelfSignedCertificate, type GeneratedCertificate } from "./certificate"

/**
 * The Backup Reader: an optional, read-only app-only identity a tenant can add so scheduled backups
 * keep running when Conditional Access session controls (such as sign-in frequency) end the admin's
 * session. It is a separate single-tenant app registration with a certificate credential whose
 * private key never leaves this device's encrypted store. Only scheduled backups use it; every
 * manual backup, restore and other change uses the admin's own sign-in.
 */

/** The Microsoft Graph application permissions a Backup Reader must have. */
export const READER_REQUIRED_ROLES = [
  "DeviceManagementApps.Read.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementRBAC.Read.All",
  "DeviceManagementScripts.Read.All",
  "DeviceManagementServiceConfig.Read.All",
] as const

/** Optional: also exposes the managed device inventory, so it is opt-in for the two types that need it. */
export const DEVICE_INVENTORY_ROLE = "DeviceManagementManagedDevices.Read.All"

/** Types Microsoft Graph only returns with DEVICE_INVENTORY_ROLE. */
export const DEVICE_INVENTORY_TYPES = ["DeviceCategories", "DeviceCleanupRules"]

const ALLOWED_ROLES = new Set<string>([...READER_REQUIRED_ROLES, DEVICE_INVENTORY_ROLE])

const CERTIFICATE_DAYS = 365

const AUDIENCES = {
  graph: new Set(["https://graph.microsoft.com", "https://graph.microsoft.com/", "00000003-0000-0000-c000-000000000000"]),
  storage: new Set(["https://storage.azure.com", "https://storage.azure.com/", "e406a681-f3d4-42a8-90b6-c2b029497af1"]),
}

/**
 * The Backup Reader cannot be used: it is not set up, its certificate or permissions changed, or
 * Microsoft refused it. Signing in again cannot fix it, so it is never a SignInRequiredError.
 */
export class BackupReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "BackupReaderError"
  }
}

type Certificate = GeneratedCertificate

export interface BackupReaderCredential {
  tenantId: string
  /** The Backup Reader app registration's application (client) ID; empty until linked. */
  clientId: string
  /** The certificate Microsoft accepted at the last verification; null before the first one. */
  active: Certificate | null
  /** A new certificate waiting to be uploaded and verified, for setup or renewal. */
  pending: Certificate | null
  /** The exact Graph roles seen at the last verification. Any change stops the reader until verified again. */
  verifiedRoles: string[] | null
  verifiedAt?: string
  /** The certificate file last saved from the card, tied to its certificate so a new one hides it. */
  exportedCertificate?: { fileName: string; at: string; thumbprintSha256: string }
  lastTest?: BackupReaderTestResult
  /** The last scheduled backup that ran app-only, whatever its outcome. */
  lastRun?: { at: string; status: string }
}

export interface AcquiredToken {
  accessToken: string
}

/**
 * Requests an app-only token for `scope` with the certificate; replaced in tests. `fresh` skips the
 * token cache, so a verification sees permission changes made since the last token.
 */
export type AcquireToken = (credential: { tenantId: string; clientId: string; certificate: Certificate }, scope: string, options?: { fresh?: boolean }) => Promise<AcquiredToken>

const KEY = "backupReader."

export class BackupReaderService {
  private readonly now: () => Date
  private readonly acquire: AcquireToken

  constructor(
    private readonly store: SecureStore,
    options: { now?: () => Date; acquire?: AcquireToken } = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.acquire = options.acquire ?? msalAcquire()
  }

  status(tenantId: string): BackupReaderStatus | null {
    const credential = this.read(tenantId)
    if (!credential) return null
    const shown = credential.pending ?? credential.active!
    const identity = certificateIdentity(shown.certificatePem)
    const exported = credential.exportedCertificate
    return {
      tenantId: credential.tenantId,
      clientId: credential.clientId,
      state: credential.active && credential.verifiedRoles ? "verified" : "pending",
      certificatePem: shown.certificatePem,
      thumbprintSha256: shown.thumbprintSha256,
      thumbprint: identity.thumbprint,
      certificateName: identity.name,
      notAfter: (credential.active ?? shown).notAfter,
      verifiedRoles: credential.verifiedRoles,
      verifiedAt: credential.verifiedAt ?? null,
      exportedCertificate: exported && exported.thumbprintSha256 === shown.thumbprintSha256 ? { fileName: exported.fileName, at: exported.at } : null,
      lastTest: credential.lastTest ?? null,
      lastRun: credential.lastRun ?? null,
      excludedTypes: excludedTypes(credential.verifiedRoles),
      renewalPending: !!credential.active && !!credential.pending,
    }
  }

  /**
   * Creates a certificate to upload with the setup script: the first one, or a renewal kept next to
   * the active certificate until it is verified. A certificate already waiting is kept, so running
   * the script with the exported file and then verifying always matches.
   */
  prepare(tenantId: string, deviceName: string): BackupReaderStatus {
    const tenant = tenantId.toLowerCase()
    const credential = this.read(tenant) ?? { tenantId: tenant, clientId: "", active: null, pending: null, verifiedRoles: null }
    if (!credential.pending) {
      const subject = `TenuVault Backup Reader (${deviceName.replace(/[^\w .-]/g, "").slice(0, 48) || "device"})`
      credential.pending = createSelfSignedCertificate(subject, CERTIFICATE_DAYS, this.now())
      delete credential.exportedCertificate
    }
    this.write(credential)
    return this.status(tenant)!
  }

  /**
   * Checks the Backup Reader with Microsoft and records the exact roles it has, so later runs refuse it
   * when they change. Checks the active certificate, or the waiting one at the first setup or when
   * `renewal` asks for it; a verified renewal replaces the active certificate. Always asks Microsoft for
   * a new token. Throws BackupReaderError with the reason when Microsoft or the checks refuse it.
   */
  async verify(tenantId: string, clientId: string, options: { renewal?: boolean } = {}): Promise<BackupReaderStatus> {
    const credential = this.read(tenantId)
    if (!credential) throw new BackupReaderError("Create the Backup Reader certificate first.")
    if (!isGuid(clientId)) throw new BackupReaderError("Enter the Backup Reader's application (client) ID that the setup script printed.")
    if (credential.active && credential.clientId && credential.clientId.toLowerCase() !== clientId.toLowerCase()) {
      throw new BackupReaderError("This tenant already has a Backup Reader with a different application ID. Remove it first to switch.")
    }
    if (options.renewal && !credential.pending) throw new BackupReaderError("No renewal certificate is waiting. Create one with Renew certificate.")
    const certificate = options.renewal || !credential.active ? credential.pending! : credential.active
    const app = { tenantId: credential.tenantId, clientId: clientId.toLowerCase(), certificate }
    const token = await this.acquire(app, RESOURCE_SCOPES.graph, { fresh: true }).catch((error: unknown) => {
      throw refused(error) ?? error
    })
    const roles = checkReaderToken(token.accessToken, app, "graph")
    credential.clientId = app.clientId
    if (certificate === credential.pending) {
      credential.active = certificate
      credential.pending = null
    }
    credential.verifiedRoles = roles
    credential.verifiedAt = this.now().toISOString()
    // A new certificate or new roles make an earlier confidence test meaningless.
    delete credential.lastTest
    this.write(credential)
    return this.status(credential.tenantId)!
  }

  /** Discards a renewal certificate that was not uploaded; the active certificate stays in use. */
  cancelRenewal(tenantId: string): BackupReaderStatus | null {
    const credential = this.read(tenantId)
    if (credential?.active && credential.pending) {
      credential.pending = null
      this.write(credential)
    }
    return this.status(tenantId)
  }

  /** Remembers which public certificate file the admin saved, so the card can name it days later. */
  recordExport(tenantId: string, fileName: string): void {
    const credential = this.read(tenantId)
    const shown = credential?.pending ?? credential?.active
    if (!credential || !shown) return
    credential.exportedCertificate = { fileName, at: this.now().toISOString(), thumbprintSha256: shown.thumbprintSha256 }
    this.write(credential)
  }

  /** Records a confidence test run by the main process (Graph read plus storage check). */
  recordTest(tenantId: string, result: Omit<BackupReaderTestResult, "at">): void {
    const credential = this.read(tenantId)
    if (!credential) return
    credential.lastTest = { ...result, at: this.now().toISOString() }
    this.write(credential)
  }

  /** Records that a scheduled backup actually ran with the reader, for the card and Schedule tab. */
  recordRun(tenantId: string, status: string): void {
    const credential = this.read(tenantId)
    if (!credential) return
    credential.lastRun = { at: this.now().toISOString(), status }
    this.write(credential)
  }

  remove(tenantId: string): void {
    this.store.delete(KEY + tenantId.toLowerCase())
  }

  /**
   * Tokens for a scheduled backup of the tenant, or null when it has no verified Backup Reader or its
   * certificate has expired, so the backup uses the admin's sign-in as before. Every token is checked
   * before use: right tenant, app and audience, app-only, and exactly the verified roles.
   */
  tokens(request: BackupRequest): RunTokens | null {
    const credential = this.read(request.tenantId)
    if (!credential?.active || !credential.verifiedRoles || !credential.clientId) return null
    if (Date.parse(credential.active.notAfter) <= this.now().getTime()) return null
    const app = { tenantId: credential.tenantId, clientId: credential.clientId, certificate: credential.active }
    const verified = credential.verifiedRoles
    const token = async (resource: "graph" | "storage") => {
      const acquired = await this.acquire(app, RESOURCE_SCOPES[resource]).catch((error: unknown) => {
        // A network failure or a transient refusal stays as it is, so the backup is retried.
        throw refused(error, { permanentOnly: true }) ?? error
      })
      const roles = checkReaderToken(acquired.accessToken, app, resource)
      if (resource === "graph" && !sameRoles(roles, verified)) {
        throw new BackupReaderError(
          `The Backup Reader's Microsoft Graph permissions changed since they were verified (now: ${roles.join(", ") || "none"}). Verify the Backup Reader again in Settings.`,
        )
      }
      return acquired.accessToken
    }
    return { mode: "app-only", graph: () => token("graph"), storage: () => token("storage"), excludedTypes: excludedTypes(verified) }
  }

  private read(tenantId: string): BackupReaderCredential | null {
    const tenant = tenantId.toLowerCase()
    const raw = this.store.get(KEY + tenant)
    if (!raw) return null
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    if (isCredential(parsed, tenant)) { parsed.verifiedRoles ??= null; return parsed }
    // A corrupt or old-schema credential must not throw into every scheduled backup: it reads
    // as "no Backup Reader", so backups fall back to the admin's sign-in as documented. The
    // raw value (which holds the private key) is set aside in the same encrypted store, not
    // deleted, so it can still be recovered.
    this.store.set(`${KEY}${tenant}.unreadable.${this.now().getTime()}`, raw)
    this.store.delete(KEY + tenant)
    console.warn(`[backup-reader] Set aside an unreadable stored credential for tenant ${tenant}.`)
    return null
  }

  private write(credential: BackupReaderCredential): void {
    this.store.set(KEY + credential.tenantId.toLowerCase(), JSON.stringify(credential))
  }
}

function isCertificate(value: unknown): value is Certificate {
  if (!value || typeof value !== "object") return false
  const certificate = value as Partial<Certificate>
  return ["certificatePem", "privateKeyPem", "thumbprintSha256", "notBefore", "notAfter"].every((field) => typeof certificate[field as keyof Certificate] === "string" && certificate[field as keyof Certificate] !== "")
}

/** Whether a stored value has the credential shape every reader of it dereferences. */
function isCredential(value: unknown, tenant: string): value is BackupReaderCredential {
  if (!value || typeof value !== "object") return false
  const credential = value as Partial<BackupReaderCredential>
  if (typeof credential.tenantId !== "string" || credential.tenantId.toLowerCase() !== tenant) return false
  if (typeof credential.clientId !== "string") return false
  if (credential.active !== null && !isCertificate(credential.active)) return false
  if (credential.pending !== null && !isCertificate(credential.pending)) return false
  if (!credential.active && !credential.pending) return false
  if (credential.verifiedRoles !== undefined && credential.verifiedRoles !== null && (!Array.isArray(credential.verifiedRoles) || credential.verifiedRoles.some((role) => typeof role !== "string"))) return false
  return true
}

function excludedTypes(roles: string[] | null): string[] {
  return roles?.includes(DEVICE_INVENTORY_ROLE) ? [] : DEVICE_INVENTORY_TYPES
}

function sameRoles(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((role) => b.includes(role))
}

/**
 * Checks an app-only token before any request uses it, and returns its Graph roles. The signature is
 * not verified: MSAL received the token over TLS from Microsoft's token endpoint, so this guards
 * against a misconfigured app registration, not a forged token.
 */
export function checkReaderToken(token: string, app: { tenantId: string; clientId: string }, resource: "graph" | "storage"): string[] {
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    throw new BackupReaderError("Microsoft returned a Backup Reader token the app cannot read.")
  }
  const appId = typeof claims.appid === "string" ? claims.appid : claims.azp
  if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== app.tenantId.toLowerCase()) throw new BackupReaderError("The Backup Reader token was issued for a different tenant.")
  if (typeof appId !== "string" || appId.toLowerCase() !== app.clientId.toLowerCase()) throw new BackupReaderError("The Backup Reader token was issued to a different app registration.")
  if (typeof claims.aud !== "string" || !AUDIENCES[resource].has(claims.aud)) throw new BackupReaderError("The Backup Reader token is for a different resource.")
  // Delegated tokens carry scp; the Backup Reader is only ever an application.
  if (claims.scp !== undefined || (claims.idtyp !== undefined && claims.idtyp !== "app")) throw new BackupReaderError("The Backup Reader token is not an app-only token.")
  const roles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string").sort() : []
  if (resource === "storage") return roles
  const extra = roles.filter((role) => !ALLOWED_ROLES.has(role))
  if (extra.length) {
    throw new BackupReaderError(
      `The Backup Reader has permissions beyond read-only backup: ${extra.join(", ")}. Remove them from the app registration; TenuVault only uses a reader that cannot change Intune.`,
    )
  }
  const missing = READER_REQUIRED_ROLES.filter((role) => !roles.includes(role))
  if (missing.length) {
    throw new BackupReaderError(`The Backup Reader is missing permissions or their admin consent: ${missing.join(", ")}. Run the setup script again or grant admin consent.`)
  }
  return roles
}

/**
 * Refusals that retrying cannot fix, with what to do. Other codes, such as AADSTS90033 (a transient
 * service error) or AADSTS700024 (an assertion outside its time window, for example after a clock
 * correction), may succeed on a retry.
 */
const PERMANENT_REFUSALS: Record<string, string> = {
  AADSTS700027: "Microsoft does not know this certificate. Upload the exported certificate with the setup script, then verify again.",
  AADSTS7000222: "The certificate has expired. Create a renewal certificate in Settings and upload it.",
  AADSTS700016: "No app registration with this application ID exists in the tenant.",
  AADSTS7000112: "The Backup Reader app registration is disabled.",
  AADSTS7000229: "The Backup Reader app registration has no service principal in the tenant. Run the setup script again.",
  AADSTS53003: "Conditional Access for workload identities blocked the Backup Reader from this location.",
}

/**
 * Microsoft's refusal of the certificate as a BackupReaderError naming the AADSTS code, without token or
 * key material; null for any other failure, such as a network error. With `permanentOnly`, a refusal
 * that may pass on a retry is also null, so a scheduled backup retries it like a network failure.
 */
function refused(error: unknown, options: { permanentOnly?: boolean } = {}): BackupReaderError | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = /AADSTS\d+/.exec(message)?.[0]
  if (!code) return null
  const hint = PERMANENT_REFUSALS[code]
  if (!hint && options.permanentOnly) return null
  return new BackupReaderError(`Microsoft refused the Backup Reader (${code}). ${hint ?? "Try again in a few minutes, then check the app registration and its certificate."}`, { cause: error })
}

/** MSAL confidential clients per certificate, with MSAL's in-memory token cache only. */
function msalAcquire(): AcquireToken {
  const apps = new Map<string, ConfidentialClientApplication>()
  return async ({ tenantId, clientId, certificate }, scope, options) => {
    const key = `${tenantId}|${clientId}|${certificate.thumbprintSha256}`
    let app = apps.get(key)
    if (!app) {
      app = new ConfidentialClientApplication({
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${tenantId}`,
          clientCertificate: { thumbprintSha256: certificate.thumbprintSha256, privateKey: certificate.privateKeyPem },
        },
        system: { loggerOptions: { logLevel: LogLevel.Warning, piiLoggingEnabled: false, loggerCallback: (_level, message) => console.log(`[msal reader] ${message}`) } },
      })
      apps.set(key, app)
    }
    const result = await app.acquireTokenByClientCredential({ scopes: [scope], skipCache: options?.fresh === true })
    if (!result?.accessToken) throw new Error("Microsoft returned no token for the Backup Reader.")
    return { accessToken: result.accessToken }
  }
}
