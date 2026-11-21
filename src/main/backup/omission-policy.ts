import { randomUUID } from "node:crypto"
import { isLocalAccount } from "../storage/blob-emulator"
import { assertStorageAccountName } from "../../shared/storage-account"
import type { OmissionOptions } from "../../shared/intune/secret-omission"
import type { KeyValueStore } from "../storage/secure-store"
import { BlobWriter } from "./blob-writer"
import { BlobClaimError } from "./request"

interface Policy extends OmissionOptions {
  version: 1
  tenantId: string
  generation: string
}

interface Control extends Policy {
  pending?: Policy
  publishing?: { id: string; until: number }
}

export interface BackupOmissionPolicy extends OmissionOptions {
  generation: string
  beginPublication?: (id: string, deadline: number, signal: AbortSignal) => Promise<() => Promise<void>>
}

const OFF = { enabled: false, scripts: false, generation: "default" }
const key = (tenant: string) => `backup.omission.${tenant}`
const prefix = (tenant: string) => `.tenuvault-control/${tenant}/secret-omission`
const policyPath = (tenant: string) => `${prefix(tenant)}.json`
const enrollmentPath = (tenant: string) => `${prefix(tenant)}-enrolled.json`
const verificationError = () => new Error("The tenant's backup omission policy could not be verified. Check its storage and try again.")
const changed = () => new Error("The backup omission policy changed during this run. Run the backup again.")
const defaultPolicy = (tenantId: string): Control => ({ version: 1, tenantId, ...OFF })

export function configuredCloudPolicyAccount(raw: string | undefined | null, tenantId: string): string | undefined {
  try {
    const config = JSON.parse(raw ?? "null") as { tenantId?: string; storageAccount?: string } | null
    return config?.tenantId === tenantId.toLowerCase() && typeof config.storageAccount === "string" &&
      /^[a-z0-9]{3,24}$/.test(config.storageAccount) ? config.storageAccount : undefined
  } catch {
    return undefined
  }
}

function parse(value: unknown, tenantId: string, control = false): Control {
  const policy = value as Partial<Control> | null
  if (!policy || policy.version !== 1 || policy.tenantId !== tenantId ||
      typeof policy.enabled !== "boolean" || typeof policy.scripts !== "boolean" ||
      typeof policy.generation !== "string" ||
      (!/^[a-f0-9-]{36}$/.test(policy.generation) && !(control && policy.generation === "default" && !policy.enabled)) ||
      (!policy.enabled && policy.scripts)) throw verificationError()
  if (policy.pending !== undefined) {
    if (!control || policy.publishing !== undefined) throw verificationError()
    parse(policy.pending, tenantId)
  }
  if (policy.publishing !== undefined && (!control || !policy.publishing ||
      typeof policy.publishing.id !== "string" || !Number.isSafeInteger(policy.publishing.until))) throw verificationError()
  return policy as Control
}

export class OmissionPolicyStore {
  private readonly changing = new Set<string>()

  constructor(private readonly store: KeyValueStore, private readonly fetchImpl: typeof fetch) {}

  private locations(tenant: string, destination: string, cloudAccount?: string): string[] {
    const bound = this.store.get(`${key(tenant)}.account`)
    const azure = isLocalAccount(destination) ? undefined : destination.toLowerCase()
    const accounts = [...new Set([azure, cloudAccount].filter((account): account is string => !!account))].sort()
    if (bound && accounts.length && (accounts.length !== 1 || accounts[0] !== bound)) throw verificationError()
    if (bound && !accounts.length) accounts.push(bound)
    for (const account of accounts) assertStorageAccountName(account)
    return accounts
  }

  private writer(account: string, token: () => Promise<string>, signal?: AbortSignal) {
    return new BlobWriter(this.fetchImpl, account, token, undefined, true, signal)
  }

  private async control(blobs: BlobWriter, tenant: string) {
    const current = await blobs.readJsonWithETag(policyPath(tenant))
    const policy = current ? parse(current.value, tenant, true) : defaultPolicy(tenant)
    if (policy.generation === OFF.generation && !policy.pending && await blobs.readJson(enrollmentPath(tenant))) throw verificationError()
    return { policy, etag: current?.etag ?? null }
  }

  readForBackup(tenantId: string, requested: string, configured: string | undefined, cloud: string | undefined, token: () => Promise<string>, signal: AbortSignal) {
    if (!configured) throw new Error("Choose where to store backups for this tenant first.")
    if (configured.toLowerCase() !== requested.toLowerCase()) throw new Error("The requested backup destination does not match the tenant's saved storage.")
    return this.read(tenantId, configured, cloud, token, false, signal)
  }

  async read(tenantId: string, destination: string, cloud: string | undefined, token: () => Promise<string>, allowMigration = false, signal?: AbortSignal): Promise<BackupOmissionPolicy & { migrationRequired?: true; pending?: OmissionOptions }> {
    const tenant = tenantId.toLowerCase()
    if (this.changing.has(tenant)) throw new Error("Wait for the backup omission policy change to finish.")
    const accounts = this.locations(tenant, destination, cloud)
    const local = this.store.get(key(tenant))
    if (!accounts.length) return local ? parse(JSON.parse(local), tenant) : OFF
    try {
      const states = await Promise.all(accounts.map(async (account) => (await this.control(this.writer(account, token, signal), tenant)).policy))
      const starting = states.find((state) => state.pending)
      if (starting?.pending) {
        if (allowMigration && accounts.length === 1) {
          return { enabled: starting.enabled, scripts: starting.scripts, generation: starting.generation,
            pending: { enabled: starting.pending.enabled, scripts: starting.pending.scripts } }
        }
        throw verificationError()
      }
      const active = states.find((state) => state.generation !== OFF.generation)
      if (this.store.get(`${key(tenant)}.account`) && !active) throw verificationError()
      if (active) {
        if (accounts.length !== 1) throw verificationError()
        this.store.set(`${key(tenant)}.account`, accounts[0]!)
      } else if (local) {
        if (allowMigration && accounts.length === 1) return { ...parse(JSON.parse(local), tenant), migrationRequired: true }
        throw verificationError()
      }
      const effective = active ?? OFF
      return {
        enabled: effective.enabled, scripts: effective.scripts, generation: effective.generation,
        beginPublication: async (id, deadline, runSignal) => {
          const releases: Array<() => Promise<void>> = []
          const release = async () => { await Promise.allSettled(releases.map((end) => end())) }
          try {
            for (const account of accounts) releases.push(await this.beginPublication(account, tenant, effective.generation, token, id, deadline, runSignal))
            return release
          } catch (error) {
            await release()
            throw error
          }
        },
      }
    } catch {
      signal?.throwIfAborted()
      throw verificationError()
    }
  }

  // The pending transition and the publication claim compete on the same ETag. Snapshot files
  // are still in memory at this point. A writer that wins may finish before a switch begins.
  private async beginPublication(account: string, tenant: string, generation: string, token: () => Promise<string>, id: string, deadline: number, signal: AbortSignal) {
    const blobs = this.writer(account, token, signal)
    const { policy, etag } = await this.control(blobs, tenant)
    if (policy.pending || policy.generation !== generation) throw changed()
    if (policy.publishing && policy.publishing.until > Date.now()) throw new Error("Another backup is publishing for this tenant. Try again when it finishes.")
    // Keep the claim beyond the producer's final dispatch deadline to cover an in-flight PUT.
    const publishing = { id, until: deadline + 120_000 }
    const claimed = { ...policy, publishing }
    await blobs.put(policyPath(tenant), JSON.stringify(claimed), undefined, !etag, undefined, etag ?? undefined)
    return async () => {
      const cleanup = this.writer(account, token, AbortSignal.timeout(5_000))
      const current = await this.control(cleanup, tenant)
      if (current.policy.publishing?.id !== id || !current.etag) return
      const { publishing: _publishing, ...released } = current.policy
      await cleanup.put(policyPath(tenant), JSON.stringify(released), undefined, false, undefined, current.etag)
    }
  }

  async save(tenantId: string, destination: string, cloud: string | undefined, token: () => Promise<string>, options: OmissionOptions): Promise<void> {
    const tenant = tenantId.toLowerCase()
    if (this.changing.has(tenant)) throw new Error("The backup omission policy is already changing.")
    this.changing.add(tenant)
    try {
      const accounts = this.locations(tenant, destination, cloud)
      if (accounts.length > 1) throw new Error("Use the same Azure storage account for desktop and cloud backup before changing omission.")
      const policy: Policy = { version: 1, tenantId: tenant, generation: randomUUID(), enabled: options.enabled, scripts: options.enabled && options.scripts }
      const account = accounts[0]
      if (!account) {
        this.store.set(key(tenant), JSON.stringify(policy))
        return
      }
      const blobs = this.writer(account, token, AbortSignal.timeout(30_000))
      const current = await this.control(blobs, tenant)
      if (current.policy.publishing && current.policy.publishing.until > Date.now()) {
        throw new Error("Another backup is publishing for this tenant. Wait for it to finish, then save again.")
      }
      const { publishing: _publishing, pending: _pending, ...active } = current.policy
      // No old generation can acquire a publication claim after this conditional write.
      const pending = { ...active, pending: policy }
      await blobs.put(policyPath(tenant), JSON.stringify(pending), undefined, !current.etag, undefined, current.etag ?? undefined)
      try {
        await blobs.put(enrollmentPath(tenant), JSON.stringify({ version: 1, tenantId: tenant }), undefined, true)
      } catch (error) {
        if (!(error instanceof BlobClaimError)) throw error
      }
      const staged = await this.control(blobs, tenant)
      if (staged.policy.pending?.generation !== policy.generation || !staged.etag) throw verificationError()
      await blobs.put(policyPath(tenant), JSON.stringify(policy), undefined, false, undefined, staged.etag)
      this.store.set(`${key(tenant)}.account`, account)
    } finally {
      this.changing.delete(tenant)
    }
  }
}
