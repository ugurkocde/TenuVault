import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { executionMetadata, type ExecutionMetadata } from "../api/execution-metadata"
import { accessTokenDigest } from "../auth/token-identity"
import { isGuid, normalizeGuid } from "../../shared/security"
import { APPLICATION_METADATA_RESTORE_PACK, GRANT_REMOVAL_SCOPE } from "../../shared/services/permission-packs"
import { GRAPH_APP_ID } from "../../shared/services/manifest"
import { TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import type { AppMetadataRemoval, TemporaryGrantScope } from "../../shared/app-metadata-removal"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import type { KeyValueStore } from "../storage/secure-store"
import { directoryContinuation } from "./directory-read-shape"
import { requireRestoreActor, restorePermissions } from "./restore-actor"
import { restoreTenantKey } from "./restore-tenant-key"
import type { RestoreConnection } from "./service"
import type { PackConsentResult } from "../../shared/pack-consent"

const root = "https://graph.microsoft.com/beta/"
const pack = APPLICATION_METADATA_RESTORE_PACK
type Grant = Omit<TemporaryGrantScope, "scope"> & { id: string; scopes: string[] }
type Addition = TemporaryGrantScope & { id: string }
type Endpoint = { clientId: string; resourceId: string }
interface Record {
  id: string
  runId: string
  owner: string
  endpoint: Endpoint
  before: Grant[]
  added?: Addition[]
  remaining?: Addition[]
  askedForConsent: boolean
  consentObserved?: true
  verified?: true
}
interface Host {
  available(tenant: string): Promise<boolean>
  consent(tenant: string, signal: AbortSignal): Promise<PackConsentResult>
  token(tenant: string, scopes: readonly string[], forRestore: boolean): Promise<RestoreConnection>
  verifyOwner(connection: RestoreConnection): Promise<void>
  changed?(tenant: string): void
}

const fail = (message: string): never => { throw new RestoreSafetyError(message) }
const key = (tenant: string) => `restore.directory.temporary-app-access.${restoreTenantKey(tenant)}`
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const slot = (grant: Grant | Addition) => grant.principalId ?? "AllPrincipals"
const has = (scopes: readonly string[], scope: string) => scopes.some(value => same(value, scope))

export function addedAppMetadataScopes(before: Grant[], after: Grant[]): Addition[] {
  return after.flatMap(grant => pack.scopes
    .filter(scope => has(grant.scopes, scope) && !has(before.find(row => slot(row) === slot(grant))?.scopes ?? [], scope))
    .map(scope => ({ id: grant.id, consentType: grant.consentType, principalId: grant.principalId, scope })))
}

export function withTemporaryDirectoryWrite<T>(connection: RestoreConnection, path: string, method: "PATCH" | "DELETE", kind: NonNullable<ExecutionMetadata["directoryTemporaryWrite"]>["kind"], work: () => T): T {
  return executionMetadata.run({
    ...executionMetadata.getStore(),
    directoryTemporaryWrite: { tenantId: normalizeGuid(connection.tenantId), tokenDigest: accessTokenDigest(connection.token), path, method, kind },
  }, work)
}

export class AppMetadataAccess {
  private readonly active = new Map<string, "restoring" | "removing">()

  constructor(private readonly store: KeyValueStore, private readonly host: Host, private readonly fetchImpl: typeof fetch) {}

  private load(tenant: string): Record | null {
    const id = this.store.get(key(tenant))
    if (id === null) return null
    if (!isGuid(id)) return fail("The temporary permission journal could not be verified.")
    const raw = this.store.get(`${key(tenant)}.${id}`)
    if (raw === null) return fail("The temporary permission journal is incomplete.")
    return JSON.parse(raw) as Record
  }
  private save(tenant: string, record: Record) { this.store.set(`${key(tenant)}.${record.id}`, JSON.stringify(record)) }
  private publicStatus(tenant: string, record: Record): AppMetadataRemoval {
    const candidates = pack.scopes.flatMap(scope =>
      ([{ consentType: "AllPrincipals", principalId: null }, { consentType: "Principal", principalId: record.owner }] as const)
        .filter(grant => !has(record.before.find(row => (row.principalId ?? "AllPrincipals") === (grant.principalId ?? "AllPrincipals"))?.scopes ?? [], scope))
        .map(grant => ({ ...grant, scope })))
    const scopes = record.verified ? record.added ?? [] : record.consentObserved ? record.remaining ?? record.added ?? [] : candidates
    return {
      runId: record.runId,
      status: record.verified ? "verified" : this.active.has(restoreTenantKey(tenant)) ? "active" : "pending",
      scopes: scopes.map(({ consentType, principalId, scope, ...grant }) => ({ consentType, principalId, scope, ...("id" in grant ? { grantId: String(grant.id) } : {}) })),
      ...(this.active.get(restoreTenantKey(tenant)) === "removing" ? { removing: true } : {}),
      ...(!record.consentObserved && !record.verified ? { uncertain: true } : {}),
    }
  }

  status(tenant: string, runId?: string): AppMetadataRemoval | undefined {
    const record = this.load(tenant)
    if (record && (runId ? runId === record.runId : !record.verified)) return this.publicStatus(tenant, record)
  }

  private async request(connection: RestoreConnection, url: string, method = "GET", body?: { scope: string }) {
    return this.fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  private async endpoint(connection: RestoreConnection) {
    const resolve = async (appId: string): Promise<string> => {
      const response = await this.request(connection, `${root}servicePrincipals(appId='${appId}')?$select=id,appId`)
      if (response.status !== 200) fail(`Could not verify the enterprise app in this tenant (Microsoft Graph HTTP ${response.status}).`)
      const row = await response.json()
      if (!isGuid(row?.id) || typeof row.appId !== "string" || !same(row.appId, appId)) fail("Microsoft Graph returned an unexpected enterprise app.")
      return normalizeGuid(row.id)
    }
    const [clientId, resourceId] = await Promise.all([resolve(TENUVAULT_CLIENT_ID), resolve(GRAPH_APP_ID)])
    return { clientId, resourceId }
  }

  private async grants(connection: RestoreConnection, endpoint: Endpoint, owner: string) {
    const start = root + "oauth2PermissionGrants?" + new URLSearchParams({ $filter: `clientId eq '${endpoint.clientId}'` })
    const seen = new Set<string>(), slots = new Set<string>(), grants: Grant[] = []
    let next: string | undefined = start
    while (next) {
      const answer = await this.request(connection, directoryContinuation(start, next, seen))
      if (answer.status !== 200) fail(`Could not read the TenuVault app's delegated grants (Microsoft Graph HTTP ${answer.status}).`)
      const page = await answer.json()
      if (!Array.isArray(page?.value) || (page["@odata.nextLink"] !== undefined && typeof page["@odata.nextLink"] !== "string")) fail("Microsoft Graph returned an incomplete permission grant list.")
      for (const row of page.value) {
        if (typeof row?.clientId !== "string" || !same(row.clientId, endpoint.clientId) || !isGuid(row.resourceId)) fail("Microsoft Graph returned a grant for an unexpected app.")
        if (!same(row.resourceId, endpoint.resourceId)) continue
        if (!(row.consentType === "AllPrincipals" && row.principalId === null || row.consentType === "Principal" && isGuid(row.principalId)) ||
          typeof row.scope !== "string" || typeof row.id !== "string" || !/^[\w-]{1,200}$/.test(row.id)) fail("Microsoft Graph returned an invalid permission grant.")
        const principalId = row.principalId === null ? null : normalizeGuid(row.principalId)
        if (principalId !== null && principalId !== owner) continue
        const grant = { id: row.id, consentType: row.consentType, principalId, scopes: row.scope.trim().split(/\s+/).filter(Boolean) } as Grant
        if (slots.has(slot(grant))) fail("The TenuVault app has ambiguous delegated grants.")
        slots.add(slot(grant))
        grants.push(grant)
      }
      next = page["@odata.nextLink"]
    }
    return grants
  }

  private requirePack(connection: RestoreConnection, expected: RestoreConnection, scopes: readonly string[]) {
    requireRestoreActor(connection.token, expected, connection.authorization)
    if (!isGuid(expected.userId) || !same(expected.clientId, TENUVAULT_CLIENT_ID) ||
      !same(connection.tenantId, expected.tenantId) || !same(connection.clientId, expected.clientId) || !same(connection.userId, expected.userId) ||
      scopes.some(scope => !restorePermissions(connection.token, connection.authorization?.scopes)?.permissions.has(scope))) fail("Microsoft has not issued the required permissions to the admin who reviewed this restore.")
  }

  async run<T>(normal: RestoreConnection, runId: string, signal: AbortSignal, restore: (connection: RestoreConnection) => Promise<T>) {
    const tenant = restoreTenantKey(normal.tenantId)
    if (this.active.has(tenant) || this.status(tenant)) fail("Resolve the pending permission removal before starting another app metadata restore.")
    this.active.set(tenant, "restoring")
    let record: Record | undefined, elevated: RestoreConnection | undefined
    try {
      if (!await this.host.available(tenant)) fail("Entra app metadata restore is unavailable until temporary access and permission removal can be verified.")
      this.requirePack(normal, normal, ["Directory.Read.All"])
      const owner = normalizeGuid(normal.userId), endpoint = await this.endpoint(normal)
      const before = await this.grants(normal, endpoint, owner)
      await this.host.verifyOwner(normal)
      signal.throwIfAborted()
      const askedForConsent = !pack.scopes.every(scope => before.some(row => has(row.scopes, scope)))
      const initial = { id: randomUUID(), runId, owner, endpoint, before, askedForConsent }
      this.save(tenant, initial)
      this.store.set(key(tenant), initial.id)
      record = initial
      this.host.changed?.(tenant)
      if (!askedForConsent) {
        record.added = []
        record.consentObserved = true
        this.save(tenant, record)
      } else {
        const consent = await this.host.consent(tenant, signal)
        if (consent.status !== "received") fail("Temporary permission consent could not be confirmed. Check the permission removal status before retrying.")
      }
      signal.throwIfAborted()
      let after = await this.grants(normal, endpoint, owner)
      const granted = () => pack.scopes.every(scope => after.some(row => has(row.scopes, scope)))
      // Grant lists can lag behind the consent callback.
      for (const wait of [500, 1_000, 2_000]) {
        if (granted()) break
        await delay(wait, undefined, { signal })
        after = await this.grants(normal, endpoint, owner)
      }
      if (!granted()) fail("Microsoft Graph has not confirmed both permissions in the TenuVault app's grants.")
      record.added = askedForConsent ? addedAppMetadataScopes(before, after) : []
      record.consentObserved = true
      this.save(tenant, record)
      this.requirePriorScopes(before, after)
      elevated = await this.host.token(tenant, pack.scopes, true)
      this.requirePack(elevated, normal, pack.scopes)
      await this.host.verifyOwner(normal)
      signal.throwIfAborted()
      return await restore(elevated)
    } finally {
      try {
        if (record?.askedForConsent) {
          this.active.set(tenant, "removing")
          this.host.changed?.(tenant)
          await this.clean(normal, record, elevated)
        } else if (record) {
          record.verified = true
          this.save(tenant, record)
        }
      } finally { this.active.delete(tenant); this.host.changed?.(tenant) }
    }
  }

  async retry(normal: RestoreConnection) {
    const tenant = restoreTenantKey(normal.tenantId)
    if (this.active.has(tenant)) fail("Wait for the running restore to finish before retrying permission removal.")
    const record = this.load(tenant)
    if (!record || record.verified) return record ? this.publicStatus(tenant, record) : undefined
    this.requirePack(normal, normal, ["Directory.Read.All"])
    this.active.set(tenant, "removing")
    this.host.changed?.(tenant)
    try {
      if (record.askedForConsent) await this.clean(normal, record, undefined, true)
      else { record.verified = true; this.save(tenant, record) }
    } finally { this.active.delete(tenant); this.host.changed?.(tenant) }
    return this.status(tenant, record.runId)
  }

  private requirePriorScopes(before: Grant[], after: Grant[]) {
    if (before.some(grant => grant.scopes.some(scope => !has(after.find(row => slot(row) === slot(grant))?.scopes ?? [], scope)))) {
      fail("Microsoft Graph has not confirmed preservation of the existing permissions.")
    }
  }

  private async clean(normal: RestoreConnection, record: Record, elevated?: RestoreConnection, retry = false) {
    const tenant = restoreTenantKey(normal.tenantId)
    let current: Grant[] | undefined
    const remaining = () => record.added?.filter(addition => current?.some(row => slot(row) === slot(addition) && has(row.scopes, addition.scope)))
    try {
      await this.host.verifyOwner(normal)
      current = await this.grants(normal, record.endpoint, record.owner)
      if (!record.consentObserved) {
        const observed = addedAppMetadataScopes(record.before, current)
        record.added = [...record.added ?? [], ...observed.filter(entry => !record.added?.some(prior => prior.id === entry.id && prior.scope === entry.scope))]
        this.save(tenant, record)
      }
      if (remaining()?.length) {
        const writer = elevated ?? await this.host.token(tenant, [GRANT_REMOVAL_SCOPE], false)
        this.requirePack(writer, normal, [GRANT_REMOVAL_SCOPE])
        // Finish the metadata permission removal on every grant before removing the scope that authorizes cleanup.
        for (const scope of pack.scopes) {
          for (const addition of (record.added ?? []).filter(entry => entry.scope === scope)) {
            current = await this.grants(normal, record.endpoint, record.owner)
            const grant = current.find(row => slot(row) === slot(addition))
            if (!grant || !has(grant.scopes, scope)) continue
            if (grant.id !== addition.id) fail("The permission grant changed identity. Review the permission in Microsoft Entra.")
            const keep = grant.scopes.filter(value => !same(value, scope))
            const path = `/beta/oauth2PermissionGrants/${grant.id}`, method = keep.length ? "PATCH" : "DELETE"
            await this.host.verifyOwner(normal)
            const response = await withTemporaryDirectoryWrite(writer, path, method, "removal", () =>
              this.request(writer, "https://graph.microsoft.com" + path, method, keep.length ? { scope: keep.join(" ") } : undefined))
            if (response.status !== 204) fail(`Microsoft Graph returned HTTP ${response.status} while removing temporary permissions.`)
            current = await this.grants(normal, record.endpoint, record.owner)
            const updated = current.find(row => slot(row) === slot(addition))
            if (updated?.scopes.some(value => same(value, scope)) || keep.some(value => !has(updated?.scopes ?? [], value))) {
              fail("Microsoft Graph has not confirmed the permission removal.")
            }
          }
        }
      }
      current = await this.grants(normal, record.endpoint, record.owner)
      if (remaining()?.length || addedAppMetadataScopes(record.before, current).some(entry => !record.added?.some(prior => prior.id === entry.id && prior.scope === entry.scope))) {
        fail("Microsoft Graph has not confirmed the removal of the temporary permissions.")
      }
      this.requirePriorScopes(record.before, current)
      if (!record.consentObserved && !retry) return
      record.remaining = []
      record.verified = true
      this.save(tenant, record)
    } catch {
      // Re-read before describing a failed or ambiguous response; the write may have succeeded.
      try { current = await this.grants(normal, record.endpoint, record.owner) } catch { current = undefined }
      record.remaining = current ? remaining() : undefined
      delete record.verified
      this.save(tenant, record)
    }
  }
}
