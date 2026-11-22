import { ConfidentialClientApplication, LogLevel } from "@azure/msal-node"
import type { BackupRequest, RunTokens } from "../backup/engine"
import type { BackupReaderStatus, BackupReaderTestResult } from "../../shared/ipc"
import type { SecureStore } from "../storage/secure-store"
import { RESOURCE_SCOPES } from "../../shared/constants"
import { isGuid } from "../../shared/security"
import { DEFAULT_SELECTION, MODULES, type ServiceSelection } from "../../shared/services/modules"
import { READER_ALLOWED_ROLES, readerExcludedFolders, readerRequiredRoles, SCRIPT_SERVICE } from "../../shared/services/manifest"
import { namedSignInCode, signInErrorRow } from "../../shared/sign-in-errors"
import { certificateIdentity, createSelfSignedCertificate, type GeneratedCertificate } from "./certificate"
import { fetchNetworkClient } from "./network-client"

/**
 * The Backup Reader: an optional, read-only app-only identity a tenant can add so scheduled backups
 * keep running when Conditional Access session controls (such as sign-in frequency) end the admin's
 * session. It is a separate single-tenant app registration with a certificate credential whose
 * private key never leaves this device's encrypted store. Only scheduled backups use it; every
 * manual backup, restore and other change uses the admin's own sign-in.
 */

/*
 * The Microsoft Graph application permissions of a Backup Reader come from the permission manifest
 * (shared/services/manifest) and follow the services the tenant backs up. It may hold the read
 * permission of any area of any service, and nothing else. It must hold every permission of a
 * service that is on and reads without a token pre-check, which is Intune. A permission it lacks
 * for any other service that is on only leaves that service's types out.
 */

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
  /** The exact Graph roles seen at the last verification. Scheduled backups use no role beyond them. */
  verifiedRoles: string[] | null
  verifiedAt?: string
  /** How the roles of the last token differed from the verified ones, until they match or are verified again. */
  roleChange?: { added: string[]; removed: string[]; at: string }
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
  private readonly connectionChanged?: (tenantId: string) => void
  private readonly now: () => Date
  private readonly acquire: AcquireToken
  private readonly services: (tenantId: string) => ServiceSelection

  constructor(
    private readonly store: SecureStore,
    // fetch: the bridged Chromium fetch MSAL token traffic must use, like AuthManager. Token
    // requests through the bridge are also license-checked there, so this must stay the bridge.
    // services: what the tenant backs up, which decides the roles its reader needs. When left out,
    // the services that are on by default.
    options: { now?: () => Date; acquire?: AcquireToken; fetch?: typeof fetch; services?: (tenantId: string) => ServiceSelection; connectionChanged?: (tenantId: string) => void } = {},
  ) {
    this.connectionChanged = options.connectionChanged
    this.now = options.now ?? (() => new Date())
    this.acquire = options.acquire ?? msalAcquire(options.fetch)
    this.services = options.services ?? (() => DEFAULT_SELECTION)
  }

  /** The credential used for requests, never the public certificate waiting beside an active one. */
  connectionIdentity(tenantId: string): string | null {
    const credential = this.read(tenantId)
    return (credential?.active ?? credential?.pending)?.thumbprintSha256 ?? null
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
      // A verified role the last token no longer carried reads nothing, so its types are named as left out.
      excludedTypes: readerExcludedFolders(credential.verifiedRoles && credential.verifiedRoles.filter((role) => !credential.roleChange?.removed.includes(role)), this.services(credential.tenantId)),
      roleChange: credential.roleChange ?? null,
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
   * Checks the Backup Reader with Microsoft and records the exact roles it has, so later runs use
   * nothing beyond them. Checks the active certificate, or the waiting one at the first setup or when
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
    const selection = this.services(credential.tenantId)
    const roles = checkReaderToken(token.accessToken, app, "graph", selection)
    requireSomethingToRead(roles, selection)
    credential.clientId = app.clientId
    if (certificate === credential.pending) {
      credential.active = certificate
      credential.pending = null
    }
    credential.verifiedRoles = roles
    credential.verifiedAt = this.now().toISOString()
    delete credential.roleChange
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
  recordRun(tenantId: string, status: string, trigger: BackupRequest["trigger"]): void {
    if (trigger !== "scheduled") return
    try {
      const credential = this.read(tenantId)
      if (!credential) return
      credential.lastRun = { at: this.now().toISOString(), status }
      this.write(credential)
    } catch { console.warn("[backup-reader] Scheduled run status could not be saved") }
  }

  remove(tenantId: string): void {
    this.store.delete(KEY + tenantId.toLowerCase())
    this.connectionChanged?.(tenantId)
  }

  /**
   * Tokens for a scheduled backup of the tenant, or null when it has no verified Backup Reader or its
   * certificate has expired, so the backup uses the admin's sign-in as before. Every token is checked
   * before use: right tenant, app and audience, app-only, and no role outside read-only backup.
   *
   * Roles that changed since the verification do not stop the backup. It reads only what the
   * verified roles its token still carries cover: a role added since then is not used, a role
   * removed leaves its types out, and the change is kept for the Backup Reader card to ask for a
   * new verification. A reader that can read nothing the tenant backs up is refused; the backup
   * never moves to the admin's sign-in on its own.
   */
  tokens(request: BackupRequest): RunTokens | null {
    const credential = this.read(request.tenantId)
    if (!credential?.active || !credential.verifiedRoles || !credential.clientId) return null
    if (Date.parse(credential.active.notAfter) <= this.now().getTime()) return null
    const app = { tenantId: credential.tenantId, clientId: credential.clientId, certificate: credential.active }
    const verified = credential.verifiedRoles
    const selection = this.services(credential.tenantId)
    // What the run may read with: the verified roles the reader's token still carries. Microsoft
    // Graph refuses a read whose role was removed from the app, whatever was verified.
    let usable = verified
    // A run asks for a token before every request, so the roles are compared once per set of roles.
    let seen: string | undefined
    const token = async (resource: "graph" | "storage", fresh = false) => {
      const acquired = await (fresh ? this.acquire(app, RESOURCE_SCOPES[resource], { fresh: true }) : this.acquire(app, RESOURCE_SCOPES[resource])).catch((error: unknown) => {
        // A network failure or a transient refusal stays as it is, so the backup is retried.
        throw refused(error, { permanentOnly: true }) ?? error
      })
      const roles = checkReaderToken(acquired.accessToken, app, resource, selection)
      if (resource === "graph" && roles.join(" ") !== seen) {
        this.noteRoleChange(credential.tenantId, roles)
        usable = verified.filter((role) => roles.includes(role))
        requireSomethingToRead(usable, selection)
        // Remembered only once the checks passed, so a refused reader is refused on every request of the run.
        seen = roles.join(" ")
      }
      return acquired.accessToken
    }
    return {
      mode: "app-only",
      registrationId: credential.clientId,
      graph: (options) => token("graph", options?.fresh),
      storage: () => token("storage"),
      // Answered from the roles in the reader's token, so a run leaves out the types of a role that was removed before it asks for them.
      excludedTypes: async () => {
        await token("graph")
        return readerExcludedFolders(usable, selection)
      },
    }
  }

  /**
   * Keeps how a token's roles differ from the verified ones, and forgets it once they match again.
   * It compares with the roles verified by now, so a backup that started before the admin verified
   * again does not bring the notice back.
   */
  private noteRoleChange(tenantId: string, roles: string[]): void {
    const credential = this.read(tenantId)
    if (!credential?.verifiedRoles) return
    const verified = credential.verifiedRoles
    const added = roles.filter((role) => !verified.includes(role))
    const removed = verified.filter((role) => !roles.includes(role))
    const previous = credential.roleChange
    if (!added.length && !removed.length) {
      if (!previous) return
      delete credential.roleChange
    } else {
      if (previous && previous.added.join(" ") === added.join(" ") && previous.removed.join(" ") === removed.join(" ")) return
      credential.roleChange = { added, removed, at: this.now().toISOString() }
    }
    this.write(credential)
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
    this.connectionChanged?.(credential.tenantId)
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

/**
 * Refuses a reader that can read nothing of what the tenant backs up. Its scheduled backups would
 * save nothing and still look fine, so the admin is told which services it lacks instead.
 */
function requireSomethingToRead(roles: readonly string[], selection: ServiceSelection): void {
  const backedUp = readerExcludedFolders([], selection)
  if (!backedUp.length || readerExcludedFolders(roles, selection).length < backedUp.length) return
  const services = MODULES.filter((module) => selection.services.includes(module.id) && module.areas.some((area) => area.folders.length))
  throw new BackupReaderError(
    `The Backup Reader has no permission to read ${services.map((module) => module.label).join(" or ")}, which is all this tenant backs up. Have your Entra administrator run the setup script with -Services ${services.map((module) => SCRIPT_SERVICE[module.id]).join(",")}, then verify again.`,
  )
}

/**
 * The first small read that shows a reader's token works for something the tenant backs up: the
 * test read of a service that is on and whose permission the reader holds. Undefined when it holds
 * the permission of none of them.
 */
export function readerConfidenceRead(selection: ServiceSelection, roles: readonly string[]): { label: string; path: string } | undefined {
  const module = MODULES.find((candidate) => selection.services.includes(candidate.id) && candidate.readerProbe && roles.includes(candidate.readerProbe.role))
  return module?.readerProbe && { label: module.label, path: module.readerProbe.path }
}

/**
 * Checks an app-only token before any request uses it, and returns its Graph roles. The signature is
 * not verified: MSAL received the token over TLS from Microsoft's token endpoint, so this guards
 * against a misconfigured app registration, not a forged token.
 *
 * `selection` is what the tenant backs up: it decides which roles the reader must hold. Without it,
 * the services that are on by default.
 */
export function checkReaderToken(token: string, app: { tenantId: string; clientId: string }, resource: "graph" | "storage", selection: ServiceSelection = DEFAULT_SELECTION): string[] {
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
  const extra = roles.filter((role) => !READER_ALLOWED_ROLES.has(role))
  if (extra.length) {
    throw new BackupReaderError(
      `The Backup Reader has permissions beyond read-only backup: ${extra.join(", ")}. Remove them from the app registration; TenuVault only uses a reader that cannot change Intune or Entra.`,
    )
  }
  const missing = readerRequiredRoles(selection).filter((role) => !roles.includes(role))
  if (missing.length) {
    throw new BackupReaderError(`The Backup Reader is missing permissions or their admin consent: ${missing.join(", ")}. Run the setup script again or grant admin consent.`)
  }
  return roles
}

/**
 * Microsoft's refusal of the certificate as a BackupReaderError naming the AADSTS code, without token or
 * key material; null for any other failure, such as a network error. With `permanentOnly`, a refusal
 * that may pass on a retry is also null, so a scheduled backup retries it like a network failure.
 */
function refused(error: unknown, options: { permanentOnly?: boolean } = {}): BackupReaderError | null {
  const message = error instanceof Error ? error.message : String(error)
  const code = namedSignInCode(message)
  if (!code) return null
  // The error table says which refusals no retry can fix, with what to do. Any other code, such as
  // AADSTS90033 (a transient service error) or AADSTS700024 (an assertion outside its time window,
  // for example after a clock correction), may succeed on a retry.
  const hint = signInErrorRow(code)?.reader
  if (!hint && options.permanentOnly) return null
  return new BackupReaderError(`Microsoft refused the Backup Reader (${code}). ${hint ?? "Try again in a few minutes, then check the app registration and its certificate."}`, { cause: error })
}

/** MSAL confidential clients per certificate, with MSAL's in-memory token cache only. */
function msalAcquire(fetchImpl?: typeof fetch): AcquireToken {
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
        system: {
          ...(fetchImpl ? { networkClient: fetchNetworkClient(fetchImpl) } : {}),
          loggerOptions: { logLevel: LogLevel.Warning, piiLoggingEnabled: false, loggerCallback: (_level, message) => console.log(`[msal reader] ${message}`) },
        },
      })
      apps.set(key, app)
    }
    const result = await app.acquireTokenByClientCredential({ scopes: [scope], skipCache: options?.fresh === true })
    if (!result?.accessToken) throw new Error("Microsoft returned no token for the Backup Reader.")
    return { accessToken: result.accessToken }
  }
}
