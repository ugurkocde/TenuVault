import type { SignedInAccount } from "../../shared/ipc"
import { isGuid } from "../../shared/security"
import { GRAPH_CLI_CLIENT_ID, TENUVAULT_CLIENT_ID, type ConnectionSwitchResult, type SignInMethod, type TenantConnection } from "../../shared/tenant-connection"
import { DELEGATED_CLIENT_SECRET, LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import type { SecureStore } from "../storage/secure-store"
import { storedAccountEntry, storedAccountKey, type StoredAccount } from "./stores"

const PREFIX = "auth.connection."
export const TENANT_LIST_KEY = "renderer.tenuvault_tenants"

interface SavedTenant {
  credentials?: { tenantId?: string; appId?: string; clientSecret?: string }
  resources?: { storageAccountName?: string }
  createdAt?: string
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
  return isGuid(id) ? id.toLowerCase() : undefined
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function targetOf(input: unknown): { method: SignInMethod; clientId: string } {
  if (!input || typeof input !== "object" || !("method" in input)) throw new Error("Choose a sign-in method.")
  if (input.method === "graphCli" || input.method === "tenuvaultApp") {
    if ("clientId" in input) throw new Error("This sign-in method has a fixed client ID.")
    return { method: input.method, clientId: input.method === "graphCli" ? GRAPH_CLI_CLIENT_ID : TENUVAULT_CLIENT_ID }
  }
  if (input.method !== "ownApp" || !("clientId" in input) || !isGuid(input.clientId)) throw new Error("Enter the application (client) ID of your app registration.")
  const clientId = input.clientId.toLowerCase()
  if (clientId === GRAPH_CLI_CLIENT_ID || clientId === TENUVAULT_CLIENT_ID) throw new Error("Choose the sign-in method that uses this client ID.")
  return { method: "ownApp", clientId }
}

export interface StagedSignIn {
  account: StoredAccount
  accessToken: string
  /** The staged cache is committed with the account, only if its original cache is still current. */
  cacheWrites?: () => Record<string, string>
}

interface ConnectionHost {
  store: Pick<SecureStore, "get" | "setMany">
  signIn: Partial<Record<SignInMethod, (tenantId: string, clientId: string) => Promise<StagedSignIn>>>
  coverage: (tenantId: string, method: SignInMethod, accessToken: string) => string[]
  now?: () => Date
}

export class TenantConnections {
  private readonly switching = new Set<string>()
  private readonly now: () => Date

  constructor(private readonly host: ConnectionHost) {
    this.now = host.now ?? (() => new Date())
  }

  /** Add the record to the existing encrypted settings, without rewriting tenant or service settings. */
  migrate(raw = this.host.store.get(TENANT_LIST_KEY)): void {
    this.host.store.setMany(this.legacyEntries(raw))
  }

  private legacyEntries(raw: string | null): Record<string, string> {
    const entries: Record<string, string> = {}
    for (const tenant of savedTenants(raw) ?? []) {
      const credentials = tenant?.credentials
      if (!isGuid(credentials?.tenantId) || !isGuid(credentials.appId)) continue
      const key = PREFIX + credentials.tenantId.toLowerCase()
      if (this.host.store.get(key) !== null || Object.hasOwn(entries, key)) continue
      const updatedAt = this.now().toISOString()
      entries[key] = JSON.stringify({
        version: 1, method: "ownApp", origin: "legacy", clientId: credentials.appId,
        ownClientId: credentials.appId, createdAt: validTime(tenant.createdAt) ? tenant.createdAt : updatedAt, updatedAt,
      } satisfies TenantConnection)
    }
    return entries
  }

  get(tenantId: string): TenantConnection | null {
    const raw = this.host.store.get(PREFIX + tenantId.toLowerCase())
    if (!raw) return null
    const record = JSON.parse(raw) as TenantConnection
    if (record?.version !== 1) throw new Error("Update TenuVault to read this tenant's connection.")
    return record
  }

  /** Main-process entry point for the wizard to publish its new profile and staged sign-in together. */
  enroll(tenantId: string, target: unknown, raw: string, staged: StagedSignIn): TenantConnection {
    if (!isGuid(tenantId)) throw new Error("Choose a tenant.")
    const tenant = tenantId.toLowerCase()
    const saved = savedTenants(this.host.store.get(TENANT_LIST_KEY))
    if (!saved) throw new Error("The saved tenant list could not be read.")
    if (this.get(tenant) || saved.some(profile => profileId(profile) === tenant)) throw new Error("This tenant is already connected.")
    const selected = targetOf(target)
    const profile = this.profile(tenant, raw)
    if (!profile) throw new Error("Save the tenant profile with its connection.")
    const at = this.now().toISOString()
    const record: TenantConnection = { version: 1, ...selected, origin: "wizard", createdAt: at, updatedAt: at, ...(selected.method === "ownApp" ? { ownClientId: selected.clientId } : {}) }
    this.validateAccount(tenant, record.clientId, staged.account)
    this.validateStorage(profile, record.method)
    this.commit(tenant, JSON.stringify([...saved, profile]), record, staged)
    return record
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
      return id && !ids.has(id) ? [PREFIX + id] : []
    })
    if (raw === null) this.host.store.setMany({}, [...removed, TENANT_LIST_KEY])
    else this.host.store.setMany({ ...this.legacyEntries(raw), [TENANT_LIST_KEY]: this.alignProfiles(raw) }, removed)
  }

  /** An older renderer snapshot must not replace a wizard connection's credentials. */
  private alignProfiles(raw: string): string {
    return this.updateProfiles(raw, tenantId => {
      const connection = this.get(tenantId)
      return connection?.origin === "wizard" ? connection.clientId : undefined
    })
  }

  async switch(tenantId: unknown, input: unknown): Promise<ConnectionSwitchResult & { account: SignedInAccount }> {
    if (!isGuid(tenantId)) throw new Error("Choose a connected tenant.")
    const tenant = tenantId.toLowerCase()
    const selected = targetOf(input)
    if (this.switching.has(tenant)) throw new Error("A sign-in method change is already in progress for this tenant.")
    const record = this.get(tenant)
    const profile = this.profile(tenant, this.host.store.get(TENANT_LIST_KEY))
    if (!profile || record?.origin !== "wizard") throw new Error("Only tenants connected through the new wizard can change sign-in method.")
    if (selected.method === record.method && selected.clientId === record.clientId) throw new Error("Choose a different sign-in method or app registration.")
    const signIn = this.host.signIn[selected.method]
    if (!signIn) throw new Error("Sign-in with this method is unavailable in this version.")
    this.validateStorage(profile, selected.method)
    const originalAccount = this.host.store.get(storedAccountKey(tenant))
    this.switching.add(tenant)
    try {
      const staged = await signIn(tenant, selected.clientId)
      this.validateAccount(tenant, selected.clientId, staged.account)
      const raw = this.host.store.get(TENANT_LIST_KEY)
      const current = this.get(tenant)
      const latest = this.profile(tenant, raw)
      if (!raw || !latest || current?.origin !== "wizard" || current.clientId !== record.clientId || current.updatedAt !== record.updatedAt ||
        this.host.store.get(storedAccountKey(tenant)) !== originalAccount) {
        throw new Error("The tenant's connection changed during sign-in. Try again.")
      }
      this.validateStorage(latest, selected.method)
      const missing = this.host.coverage(tenant, selected.method, staged.accessToken)
      const connection = {
        ...record, ...selected, updatedAt: this.now().toISOString(),
        ...(selected.method === "ownApp" ? { ownClientId: selected.clientId } : {}),
      }
      this.commit(tenant, raw, connection, staged)
      const { homeAccountId: _homeAccountId, ...account } = staged.account
      return { connection, missing, account }
    } finally {
      this.switching.delete(tenant)
    }
  }

  private validateAccount(tenant: string, clientId: string, account: StoredAccount): void {
    if (account.tenantId.toLowerCase() !== tenant) throw new Error("You signed in to a different tenant. Sign in with an account from this tenant.")
    if (account.clientId.toLowerCase() !== clientId) throw new Error("Microsoft returned a sign-in for a different app registration.")
  }

  private validateStorage(profile: SavedTenant, method: SignInMethod): void {
    if (method === "graphCli" && !profile.resources?.storageAccountName?.startsWith(LOCAL_STORAGE_PREFIX)) {
      throw new Error("Start now uses backups on this device. Choose local storage before switching.")
    }
  }

  private profile(tenant: string, raw: string | null): SavedTenant | undefined {
    return savedTenants(raw)?.find(entry => profileId(entry) === tenant)
  }

  private commit(tenant: string, raw: string, record: TenantConnection, signIn: StagedSignIn): void {
    this.host.store.setMany({
      ...signIn.cacheWrites?.(),
      ...storedAccountEntry({ ...signIn.account, tenantId: tenant, clientId: record.clientId }),
      [PREFIX + tenant]: JSON.stringify(record),
      [TENANT_LIST_KEY]: this.updateProfiles(raw, id => id === tenant ? record.clientId : undefined),
    })
  }

  private updateProfiles(raw: string, clientFor: (tenantId: string) => string | undefined): string {
    let changed = false
    const clientSecret = Buffer.from(DELEGATED_CLIENT_SECRET).toString("base64")
    const tenants = (savedTenants(raw) ?? []).map(tenant => {
      const credentials = tenant?.credentials
      if (!isGuid(credentials?.tenantId)) return tenant
      const appId = clientFor(credentials.tenantId.toLowerCase())
      if (!appId || (credentials.appId === appId && credentials.clientSecret === clientSecret)) return tenant
      changed = true
      return { ...tenant, credentials: { ...credentials, appId, clientSecret } }
    })
    return changed ? JSON.stringify(tenants) : raw
  }
}
