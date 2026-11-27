import { createHash } from "node:crypto"
import type { SignedInAccount } from "../../shared/ipc"
import { isGuid, normalizeGuid } from "../../shared/security"
import {
  SETUP_HELPER_CLIENT_ID,
  TENUVAULT_CLIENT_ID,
  connectionNeedsMethod,
  type ConnectionSwitchResult,
  type SignInMethod,
  type TenantConnection,
} from "../../shared/tenant-connection"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import type { SecureStore } from "../storage/secure-store"
import { parseStoredAccount, publicAccountKey, storedAccountKey, type StoredAccount } from "./stores"
import { ConnectionSwitchError } from "./switch-failure"

const PREFIX = "auth.connection."
export const TENANT_LIST_KEY = "renderer.tenuvault_tenants"
const SETUP_HELPER_CACHE_KEY = `msal.${SETUP_HELPER_CLIENT_ID}`

interface SavedTenant {
  credentials?: { tenantId?: string; appId?: string; clientSecret?: string }
  resources?: { storageAccountName?: string }
  createdAt?: string
}

interface StoredConnection extends Omit<TenantConnection, "method"> {
  method: SignInMethod | "graphCli" | null
}

function savedTenants(raw: string | null): SavedTenant[] | null {
  try {
    const tenants: unknown = JSON.parse(raw ?? "[]")
    return Array.isArray(tenants) ? tenants : null
  } catch {
    return null
  }
}

function profileId(tenant: SavedTenant): string | undefined {
  const id = tenant?.credentials?.tenantId
  return isGuid(id) ? normalizeGuid(id) : undefined
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isRemovedStartNow(record: StoredConnection | null): boolean {
  return Boolean(record && (record.method === "graphCli" || record.clientId?.toLowerCase() === SETUP_HELPER_CLIENT_ID))
}

function normalizeRecord(record: StoredConnection): TenantConnection {
  if (isRemovedStartNow(record) || record.needsSignInMethod || record.method === null) {
    const { graphScopes: _dropped, ...rest } = record
    return { ...rest, method: null, clientId: "", origin: "wizard", needsSignInMethod: true }
  }
  return record as TenantConnection
}

function targetOf(input: unknown): { method: SignInMethod; clientId: string } {
  if (!input || typeof input !== "object" || !("method" in input)) throw new ConnectionSwitchError("invalid_request", "Choose a sign-in method.")
  if (input.method === "tenuvaultApp") {
    if ("clientId" in input) throw new ConnectionSwitchError("invalid_request", "This sign-in method has a fixed client ID.")
    return { method: "tenuvaultApp", clientId: TENUVAULT_CLIENT_ID }
  }
  if (input.method !== "ownApp") throw new ConnectionSwitchError("invalid_request", "Unsupported sign-in method.")
  if (!("clientId" in input) || !isGuid(input.clientId)) throw new ConnectionSwitchError("invalid_request", "Enter the application (client) ID of your app registration.")
  const clientId = normalizeGuid(input.clientId)
  if (clientId === TENUVAULT_CLIENT_ID) throw new ConnectionSwitchError("invalid_request", "Choose the sign-in method that uses this client ID.")
  if (clientId === SETUP_HELPER_CLIENT_ID) throw new ConnectionSwitchError("invalid_request", "Microsoft Graph Command Line Tools is only used by the setup helper and cannot be used as a sign-in method.")
  return { method: "ownApp", clientId }
}

export interface StagedSignIn {
  missingOnboardingScopes?: string[]
  account: StoredAccount
  accessToken: string
  idToken?: string
  graphScopes?: string[]
  grantedScopes?: readonly string[]
  /** The staged cache is committed with the account, only if its original cache is still current. */
  cacheWrites?: () => Record<string, string>
}

interface ConnectionHost {
  store: Pick<SecureStore, "get" | "setMany">
  legacyCache?: Pick<SecureStore, "get"> & { delete?: (key: string) => void }
  signIn: Partial<Record<SignInMethod, (tenantId: string, clientId: string) => Promise<StagedSignIn>>>
  coverage: (tenantId: string, method: SignInMethod, accessToken: string, graphScopes?: string[], grantedScopes?: readonly string[]) => string[]
  now?: () => Date
  beforeSwitch?: (tenantId: string, currentClientId: string) => void
}

function legacyClientId(connection: TenantConnection): string {
  const id = connection.method === "ownApp" ? connection.clientId : connection.ownClientId
  return isGuid(id) && normalizeGuid(id) !== SETUP_HELPER_CLIENT_ID && normalizeGuid(id) !== TENUVAULT_CLIENT_ID ? id : ""
}

export class TenantConnections {
  private readonly switching = new Set<string>()
  private readonly now: () => Date

  constructor(private readonly host: ConnectionHost) {
    this.now = host.now ?? (() => new Date())
  }

  /** Add the record to the existing encrypted settings, without rewriting tenant or service settings. */
  migrate(raw = this.host.store.get(TENANT_LIST_KEY)): void {
    const entries = this.legacyEntries(raw)
    const removed: string[] = []
    const readded = new Set<string>()

    // Drop any persisted Graph CLI token cache left behind by the removed Start now method.
    if (this.host.store.get(SETUP_HELPER_CACHE_KEY) !== null) removed.push(SETUP_HELPER_CACHE_KEY)
    this.host.legacyCache?.delete?.(SETUP_HELPER_CACHE_KEY)

    for (const profile of savedTenants(raw) ?? []) {
      const tenant = profileId(profile)
      if (!tenant) continue
      const rawRecord = this.rawRecord(tenant)
      const legacyKey = storedAccountKey(tenant)
      const sharedKey = publicAccountKey(tenant)
      const profileClient = profile.credentials?.appId
      const createdAt = validTime(profile.createdAt) ? profile.createdAt : null

      // A profile whose stored appId was the removed Start now client ID is migrated to needsSignInMethod.
      if (!rawRecord && isGuid(profileClient) && normalizeGuid(profileClient) === SETUP_HELPER_CLIENT_ID) {
        if (this.host.store.get(legacyKey) !== null) removed.push(legacyKey)
        if (this.host.store.get(sharedKey) !== null) removed.push(sharedKey)
        continue
      }

      if (rawRecord && (isRemovedStartNow(rawRecord) || rawRecord.needsSignInMethod || rawRecord.method === null)) {
        const normalized = normalizeRecord(rawRecord)
        const fingerprint = this.legacyCacheFingerprint(normalized)
        const next: TenantConnection = {
          ...normalized,
          profileCreatedAt: rawRecord.profileCreatedAt !== undefined ? rawRecord.profileCreatedAt : createdAt,
          ...(this.host.legacyCache ? { legacyCacheFingerprint: fingerprint } : {}),
        }
        const serialized = JSON.stringify(next)
        if (serialized !== this.host.store.get(PREFIX + tenant)) entries[PREFIX + tenant] = serialized
        if (this.host.store.get(sharedKey) !== null) removed.push(sharedKey)
        if (this.host.store.get(legacyKey) !== null) removed.push(legacyKey)
        continue
      }

      const record = rawRecord ? normalizeRecord(rawRecord) : null
      if (record?.origin !== "wizard") continue
      const creationChanged = record.profileCreatedAt !== undefined
        ? record.profileCreatedAt !== createdAt
        : createdAt !== null && Date.parse(createdAt) > Date.parse(record.updatedAt)
      if (isGuid(profileClient) && normalizeGuid(profileClient) !== SETUP_HELPER_CLIENT_ID && (creationChanged ||
        (normalizeGuid(profileClient) !== normalizeGuid(legacyClientId(record)) && normalizeGuid(profileClient) !== normalizeGuid(record.clientId)))) {
        entries[PREFIX + tenant] = this.legacyRecord(profileClient, createdAt)
        readded.add(tenant)
        removed.push(sharedKey)
        continue
      }
      const legacy = this.host.store.get(legacyKey)
      const usesPublicClient = record.method !== "ownApp"
      const shared = usesPublicClient ? this.host.store.get(sharedKey) : null
      const saved = shared ?? legacy
      const fingerprint = this.legacyCacheFingerprint(record)
      const matches = (value: string | null) => {
        const account = parseStoredAccount(value)
        return account && normalizeGuid(account.tenantId) === tenant && normalizeGuid(account.clientId) === normalizeGuid(record.clientId)
      }
      const legacySignInChanged = (record.legacyCacheFingerprint ?? null) !== fingerprint ||
        (usesPublicClient && legacy !== null && (shared !== null || !matches(legacy)))
      if (usesPublicClient) {
        if (legacy !== null) removed.push(legacyKey)
        if (saved !== null && matches(saved) && !legacySignInChanged) {
          if (shared === null) entries[sharedKey] = saved
        } else if (shared !== null) removed.push(sharedKey)
      } else if (saved !== null && (!matches(saved) || legacySignInChanged)) removed.push(legacyKey)
      if (record.profileCreatedAt === undefined || (this.host.legacyCache && record.legacyCacheFingerprint !== fingerprint)) {
        entries[PREFIX + tenant] = JSON.stringify({ ...record, profileCreatedAt: createdAt, ...(this.host.legacyCache ? { legacyCacheFingerprint: fingerprint } : {}) })
      }
    }
    if (raw !== null) {
      const aligned = this.alignProfiles(raw, readded, entries)
      if (aligned !== raw) entries[TENANT_LIST_KEY] = aligned
    }
    this.host.store.setMany(entries, removed)
  }

  private legacyCacheFingerprint(record: TenantConnection): string | null {
    const client = legacyClientId(record)
    const cache = client ? this.host.legacyCache?.get(`msal.${client}`) : null
    return cache == null ? null : createHash("sha256").update(cache).digest("hex")
  }

  private legacyEntries(raw: string | null): Record<string, string> {
    const entries: Record<string, string> = {}
    for (const tenant of savedTenants(raw) ?? []) {
      const credentials = tenant?.credentials
      if (!isGuid(credentials?.tenantId) || !isGuid(credentials.appId)) continue
      const key = PREFIX + normalizeGuid(credentials.tenantId)
      if (this.host.store.get(key) !== null || Object.hasOwn(entries, key)) continue
      const createdAt = validTime(tenant.createdAt) ? tenant.createdAt : null
      if (normalizeGuid(credentials.appId) === SETUP_HELPER_CLIENT_ID) {
        entries[key] = this.needsMethodRecord(createdAt)
      } else {
        entries[key] = this.legacyRecord(credentials.appId, createdAt)
      }
    }
    return entries
  }

  private legacyRecord(clientId: string, createdAt: string | null): string {
    const updatedAt = this.now().toISOString()
    return JSON.stringify({
      version: 1, method: "ownApp", origin: "legacy", clientId, ownClientId: clientId,
      createdAt: createdAt ?? updatedAt, updatedAt,
    } satisfies TenantConnection)
  }

  private needsMethodRecord(createdAt: string | null): string {
    const updatedAt = this.now().toISOString()
    return JSON.stringify({
      version: 1, method: null, origin: "wizard", clientId: "", needsSignInMethod: true,
      createdAt: createdAt ?? updatedAt, updatedAt, profileCreatedAt: createdAt,
    } satisfies TenantConnection)
  }

  private rawRecord(tenantId: string): StoredConnection | null {
    const raw = this.host.store.get(PREFIX + normalizeGuid(tenantId))
    if (!raw) return null
    const record = JSON.parse(raw) as StoredConnection
    if (record?.version !== 1) throw new Error("Update TenuVault to read this tenant's connection.")
    return record
  }

  get(tenantId: string): TenantConnection | null {
    const record = this.rawRecord(tenantId)
    return record ? normalizeRecord(record) : null
  }

  needsSignInMethod(tenantId: string): boolean {
    return connectionNeedsMethod(this.get(tenantId))
  }

  /** Main-process entry point for the wizard to publish its new profile and staged sign-in together. */
  enroll(tenantId: string, target: unknown, raw: string, staged: StagedSignIn, settings?: Record<string, string>): TenantConnection {
    if (!isGuid(tenantId)) throw new Error("Choose a tenant.")
    const tenant = normalizeGuid(tenantId)
    const saved = savedTenants(this.host.store.get(TENANT_LIST_KEY))
    if (!saved) throw new Error("The saved tenant list could not be read.")
    if (this.get(tenant) || saved.some(profile => profileId(profile) === tenant)) throw new Error("This tenant is already connected.")
    const selected = targetOf(target)
    const profile = this.profile(tenant, raw)
    if (!profile) throw new Error("Save the tenant profile with its connection.")
    const at = this.now().toISOString()
    const record: TenantConnection = { version: 1, ...selected, ...(staged.graphScopes ? { graphScopes: staged.graphScopes } : {}), origin: "wizard", createdAt: at, updatedAt: at, profileCreatedAt: validTime(profile.createdAt) ? profile.createdAt : null, ...(selected.method === "ownApp" ? { ownClientId: selected.clientId } : {}) }
    this.validateAccount(tenant, record.clientId, staged.account)
    this.commit(tenant, JSON.stringify([...saved, profile]), record, staged, settings)
    return record
  }

  /** Publish a restore pack verified for the existing shared connection, together with its setting. */
  addVerifiedGraphScopes(tenant: string, original: TenantConnection, scopes: readonly string[], settings: Record<string, string>): boolean {
    const record = this.get(tenant)
    if (this.switching.has(tenant) || record?.method !== "tenuvaultApp" || JSON.stringify(record) !== JSON.stringify(original)) return false
    this.host.store.setMany({
      ...settings,
      [PREFIX + normalizeGuid(tenant)]: JSON.stringify({
        ...record, graphScopes: [...new Set([...(record.graphScopes ?? []), ...scopes])], updatedAt: this.now().toISOString(),
      }),
    })
    return true
  }

  saveProfiles(raw: string | null): void {
    const previous = savedTenants(this.host.store.get(TENANT_LIST_KEY)) ?? []
    const next = savedTenants(raw)
    // Keep the connection records if the renderer list needs recovery.
    if (!next && raw !== null) {
      this.host.store.setMany({ [TENANT_LIST_KEY]: raw })
      return
    }
    const ids = new Set((next ?? []).flatMap(profile => profileId(profile) ?? []))
    const removed = previous.flatMap(profile => {
      const id = profileId(profile)
      return id && !ids.has(id) ? [PREFIX + id, publicAccountKey(id)] : []
    })
    if (raw === null) this.host.store.setMany({}, [...removed, TENANT_LIST_KEY])
    else {
      const entries = this.legacyEntries(raw)
      this.host.store.setMany({ ...entries, [TENANT_LIST_KEY]: this.alignProfiles(raw, undefined, entries) }, removed)
    }
  }

  /** An older renderer snapshot must not replace a wizard connection's credentials. */
  private alignProfiles(raw: string, readded?: ReadonlySet<string>, pending?: Record<string, string>): string {
    return this.updateProfiles(raw, tenantId => {
      if (readded?.has(tenantId)) return undefined
      const staged = pending?.[PREFIX + tenantId]
      const connection = staged ? normalizeRecord(JSON.parse(staged) as StoredConnection) : this.get(tenantId)
      return connection?.origin === "wizard" ? legacyClientId(connection) : undefined
    })
  }

  /** Project the active client for 0.6 callers while keeping disk credentials safe for older apps. */
  activeProfiles(): string | null {
    const raw = this.host.store.get(TENANT_LIST_KEY)
    return raw === null ? null : this.updateProfiles(raw, tenant => {
      const connection = this.get(tenant)
      return connection?.origin === "wizard" ? connection.clientId : undefined
    })
  }

  async switchForIpc(tenantId: unknown, input: unknown, returnToApp: () => void): Promise<
    { result: ConnectionSwitchResult & { account: SignedInAccount } } | { error: { code: string; message: string } }
  > {
    try {
      return { result: await this.switch(tenantId, input).finally(returnToApp) }
    } catch (error) {
      const failure = error instanceof ConnectionSwitchError ? error : new ConnectionSwitchError("switch_failed")
      console.warn("[auth:switchConnection]", failure.code)
      // Electron logs rejected main-process handlers. The preload rejects with this message instead.
      return { error: { code: failure.code, message: failure.message } }
    }
  }

  async switch(tenantId: unknown, input: unknown): Promise<ConnectionSwitchResult & { account: SignedInAccount }> {
    if (!isGuid(tenantId)) throw new ConnectionSwitchError("invalid_request", "Choose a connected tenant.")
    const tenant = normalizeGuid(tenantId)
    const selected = targetOf(input)
    if (this.switching.has(tenant)) throw new ConnectionSwitchError("conflict", "A sign-in method change is already in progress for this tenant.")
    const record = this.get(tenant)
    const profile = this.profile(tenant, this.host.store.get(TENANT_LIST_KEY))
    if (!profile || record?.origin !== "wizard") throw new ConnectionSwitchError("unavailable", "Only tenants connected through the new wizard can change sign-in method.")
    if (selected.method === "ownApp" && selected.method === record.method && selected.clientId === normalizeGuid(record.clientId)) throw new ConnectionSwitchError("invalid_request", "Choose a different sign-in method or app registration.")
    const signIn = this.host.signIn[selected.method]
    if (!signIn) throw new ConnectionSwitchError("unavailable", "Sign-in with this method is unavailable in this version.")
    const accountKey = record.method === "ownApp" ? storedAccountKey(tenant) : publicAccountKey(tenant)
    const originalAccount = this.host.store.get(accountKey)
    this.switching.add(tenant)
    try {
      const staged = await signIn(tenant, selected.clientId)
      this.validateAccount(tenant, selected.clientId, staged.account)
      const raw = this.host.store.get(TENANT_LIST_KEY)
      const current = this.get(tenant)
      const latest = this.profile(tenant, raw)
      if (!raw || !latest || current?.origin !== "wizard" || normalizeGuid(current.clientId) !== normalizeGuid(record.clientId) || current.updatedAt !== record.updatedAt ||
        this.host.store.get(accountKey) !== originalAccount) {
        throw new ConnectionSwitchError("conflict", "The tenant's connection changed during sign-in. Try again.")
      }
      const missing = this.host.coverage(tenant, selected.method, staged.accessToken, staged.graphScopes, staged.grantedScopes)
      const changesOwnRegistration = record.method === "ownApp" && selected.method === "ownApp"
      if (missing.length && !changesOwnRegistration) {
        throw new ConnectionSwitchError("switch_failed", `The new sign-in is missing required permissions (${missing.join(", ")}). Grant the permissions and sign in again.`)
      }
      const { needsSignInMethod: _resolved, ...base } = record
      const connection: TenantConnection = {
        ...base, ...selected, graphScopes: staged.graphScopes, updatedAt: this.now().toISOString(),
        ...(selected.method === "ownApp" ? { ownClientId: selected.clientId } : {}),
      }
      if (record.clientId) this.host.beforeSwitch?.(tenant, record.clientId)
      this.commit(tenant, raw, connection, staged)
      const { homeAccountId: _homeAccountId, ...account } = staged.account
      return { connection, missing, account }
    } finally {
      this.switching.delete(tenant)
    }
  }

  private validateAccount(tenant: string, clientId: string, account: StoredAccount): void {
    if (normalizeGuid(account.tenantId) !== normalizeGuid(tenant)) throw new ConnectionSwitchError("wrong_tenant", "You signed in to a different tenant. Sign in with an account from this tenant.")
    if (normalizeGuid(account.clientId) !== normalizeGuid(clientId)) throw new ConnectionSwitchError("wrong_client", "Microsoft returned a sign-in for a different app registration.")
  }

  private profile(tenant: string, raw: string | null): SavedTenant | undefined {
    return savedTenants(raw)?.find(entry => profileId(entry) === tenant)
  }

  private commit(tenant: string, raw: string, record: TenantConnection, signIn: StagedSignIn, settings?: Record<string, string>): void {
    const legacyKey = storedAccountKey(tenant)
    const sharedKey = publicAccountKey(tenant)
    const ownApp = record.method === "ownApp"
    this.host.store.setMany({
      ...settings,
      ...signIn.cacheWrites?.(),
      [ownApp ? legacyKey : sharedKey]: JSON.stringify({ ...signIn.account, tenantId: tenant, clientId: record.clientId }),
      [PREFIX + tenant]: JSON.stringify(this.host.legacyCache ? { ...record, legacyCacheFingerprint: this.legacyCacheFingerprint(record) } : record),
      [TENANT_LIST_KEY]: this.updateProfiles(raw, id => id === tenant ? legacyClientId(record) : undefined),
    }, [ownApp ? sharedKey : legacyKey])
  }

  private updateProfiles(raw: string, clientFor: (tenantId: string) => string | undefined): string {
    let changed = false
    const delegatedSecret = Buffer.from(DELEGATED_CLIENT_SECRET).toString("base64")
    const tenants = (savedTenants(raw) ?? []).map(tenant => {
      const credentials = tenant?.credentials
      if (!isGuid(credentials?.tenantId)) return tenant
      const appId = clientFor(normalizeGuid(credentials.tenantId))
      if (appId === undefined) return tenant
      const clientSecret = appId ? delegatedSecret : ""
      if (credentials.appId === appId && credentials.clientSecret === clientSecret) return tenant
      changed = true
      return { ...tenant, credentials: { ...credentials, appId, clientSecret } }
    })
    return changed ? JSON.stringify(tenants) : raw
  }
}
