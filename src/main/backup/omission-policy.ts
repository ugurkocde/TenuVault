import { randomUUID } from "node:crypto"
import { isLocalAccount } from "../storage/blob-emulator"
import { omissionPolicyPath, type OmissionOptions } from "../../shared/intune/secret-omission"
import type { KeyValueStore } from "../storage/secure-store"
import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { resolveBackupOwnership } from "../../shared/backup-ownership"
import { parseBackupName } from "../../shared/intune/backup-names"
import { mapLimit } from "../../shared/map-limit"
import { ProtectedBlobError, TokenError } from "./request"
import { BlobWriter } from "./blob-writer"

export interface BackupOmissionPolicy extends OmissionOptions {
  generation: string
  enabledAt?: string
}

interface Policy extends BackupOmissionPolicy {
  version: 1
  tenantId: string
}

const OFF: BackupOmissionPolicy = { enabled: false, scripts: false, generation: "default" }
export const UNVERIFIED_OMISSION_GENERATION = "unverified"
const UNVERIFIED: BackupOmissionPolicy = { enabled: true, scripts: true, generation: UNVERIFIED_OMISSION_GENERATION }
const key = (tenant: string) => `backup.omission.${tenant}`
const verificationError = (cause?: unknown) => new Error(
  "The tenant's backup omission policy could not be verified. Check that the policy is valid and that the storage identity can read it, then try again.",
  { cause },
)

export function configuredCloudPolicyAccount(raw: string | undefined | null, tenantId: string): string | undefined {
  try {
    const config = JSON.parse(raw ?? "null") as { tenantId?: string; storageAccount?: string } | null
    return config?.tenantId === tenantId.toLowerCase() && typeof config.storageAccount === "string" &&
      /^[a-z0-9]{3,24}$/.test(config.storageAccount) ? config.storageAccount : undefined
  } catch {
    return undefined
  }
}

function parse(value: unknown, tenantId: string): BackupOmissionPolicy {
  const policy = value as Partial<Policy> | null
  if (!policy || policy.version !== 1 || policy.tenantId !== tenantId ||
      typeof policy.enabled !== "boolean" || typeof policy.scripts !== "boolean" ||
      typeof policy.generation !== "string" ||
      (!/^[a-f0-9-]{36}$/.test(policy.generation) && !(policy.generation === "default" && !policy.enabled)) ||
      (!policy.enabled && policy.scripts)) throw verificationError()
  const { enabled, scripts, generation, enabledAt } = policy as Policy
  return { enabled, scripts, generation, enabledAt }
}

export class OmissionPolicyStore {
  private readonly warningHistory = new Map<string, { activation: number; folders: Map<string, string | null> }>()

  constructor(private readonly store: KeyValueStore, private readonly fetchImpl: typeof fetch) {}

  private bindingKey(tenant: string, account: string) {
    return `${key(tenant)}.enrolled.${account}`
  }

  private writer(account: string, token: () => Promise<string>, signal?: AbortSignal) {
    return new BlobWriter(this.fetchImpl, account, token, undefined, true, signal)
  }

  async read(tenantId: string, destination: string, token: () => Promise<string>, signal?: AbortSignal): Promise<BackupOmissionPolicy> {
    return this.readForBackup(tenantId, destination, this.writer(destination.toLowerCase(), token, signal), signal)
  }

  async readForBackup(tenantId: string, destination: string, storage: BlobWriter, signal?: AbortSignal): Promise<BackupOmissionPolicy> {
    return this.readPolicy(tenantId, destination, storage, signal)
  }

  /** The OIB backup-choice notice can use previously observed enrollment without probing a new account. */
  hasRollbackPolicy(tenantId: string, destination: string): boolean {
    const account = destination.toLowerCase()
    return isLocalAccount(account) || this.isEnrolled(tenantId.toLowerCase(), account)
  }

  async readForRollback(tenantId: string, destination: string, silentToken: () => Promise<string>): Promise<BackupOmissionPolicy> {
    const account = destination.toLowerCase()
    const signal = AbortSignal.timeout(10_000)
    const storage = this.writer(account, async () => {
      try { return await silentToken() } catch (cause) { throw new TokenError("A silent storage token is unavailable.", { cause }) }
    }, signal)
    try {
      return await this.readPolicy(tenantId, destination, storage, signal)
    } catch {
      return UNVERIFIED
    }
  }

  private isEnrolled(tenant: string, account: string) {
    return Boolean(this.store.get(this.bindingKey(tenant, account)) || this.store.get(`${key(tenant)}.account`) === account)
  }

  hasStorageEnrollment(tenantId: string, destination: string): boolean {
    const tenant = tenantId.toLowerCase()
    const account = destination.toLowerCase()
    if (!isLocalAccount(account)) return this.isEnrolled(tenant, account)
    const local = this.store.get(key(tenant))
    return !!local && parse(JSON.parse(local), tenant).enabled
  }

  private async readPolicy(tenantId: string, destination: string, storage: BlobWriter,
    signal: AbortSignal | undefined): Promise<BackupOmissionPolicy> {
    const tenant = tenantId.toLowerCase()
    const account = destination.toLowerCase()
    signal?.throwIfAborted()
    if (isLocalAccount(account)) {
      const local = this.store.get(key(tenant))
      return local ? parse(JSON.parse(local), tenant) : OFF
    }

    const binding = this.bindingKey(tenant, account)
    const enrolled = this.isEnrolled(tenant, account)
    let value: Record<string, unknown> | null
    try {
      value = await storage.readJson(omissionPolicyPath(tenant), true)
    } catch (error) {
      signal?.throwIfAborted()
      throw verificationError(error)
    }
    if (!value) {
      if (enrolled) throw verificationError()
      return OFF
    }
    const policy = parse(value, tenant)
    if (policy.enabled) this.store.set(binding, "true")
    if (enrolled && policy.generation === "default") throw verificationError()
    return policy
  }

  async warnings(tenant: string, account: string, policy: BackupOmissionPolicy, token: () => Promise<string>) {
    if (!policy.enabled || !policy.enabledAt) return []
    const blobs = this.writer(account, isLocalAccount(account) ? async () => "" : token)
    const { prefixes } = await blobs.list("backup-", "/")
    const activation = Date.parse(policy.enabledAt)
    // Each request has its own timeout. Reuse completed manifest results across Settings visits.
    const cacheKey = `${tenant}/${account}`
    const saved = this.warningHistory.get(cacheKey)
    const history = saved?.activation === activation ? saved.folders : new Map<string, string | null>()
    this.warningHistory.set(cacheKey, { activation, folders: history })
    const folders = prefixes.map((prefix) => prefix.replace(/\/$/, "")).filter((folder) =>
      Date.parse(parseBackupName(folder)?.timestamp ?? "") >= Math.floor(activation / 1000) * 1000)
    const current = new Set(folders)
    for (const folder of history.keys()) if (!current.has(folder)) history.delete(folder)
    const results = await mapLimit(folders, 6, async (folder) => {
      const known = history.get(folder)
      if (known !== undefined) return known === null ? null : { folder, account, producer: known }
      const manifest = await blobs.readJson(`${folder}/metadata.json`)
      if (!manifest) return null // Running backups may publish their manifest after this scan.
      if (manifest.OmissionEnabled === true ||
          (typeof manifest.StartedAt === "string" && Date.parse(manifest.StartedAt) < activation)) {
        history.set(folder, null)
        return null
      }
      let source = manifest.Source
      const owner = await resolveBackupOwnership(async (file) => {
        if (file === "metadata.json") return { kind: "found", value: manifest }
        const marker = await blobs.readJson(`${folder}/${BACKUP_OWNER_FILE}`)
        source ??= marker?.Source
        return marker ? { kind: "found", value: marker } : { kind: "missing" }
      }, tenant)
      if (owner.owner.kind !== "owned") return null
      const producer = source === "TenuVault Cloud Backup"
        ? `Cloud runbook${typeof manifest.RunbookVersion === "string" ? ` ${manifest.RunbookVersion}` : ""}`
        : manifest.AuthMode === "app-only" ? "Backup Reader" : "TenuVault Desktop"
      history.set(folder, producer)
      return { folder, account, producer }
    })
    return results.filter((warning) => warning !== null)
  }

  async save(tenantId: string, destination: string, token: () => Promise<string>, options: OmissionOptions): Promise<void> {
    const tenant = tenantId.toLowerCase()
    const account = destination.toLowerCase()
    const local = isLocalAccount(account)
    const blobs = local ? undefined : this.writer(account, token, AbortSignal.timeout(30_000))
    const current = await blobs?.readJsonWithETag(omissionPolicyPath(tenant))
    if (current && !current.etag) throw verificationError()
    const previous = current ? parse(current.value, tenant) : local ? await this.read(tenant, account, token) : OFF
    const policy: Policy = {
      version: 1, tenantId: tenant, generation: randomUUID(), enabled: options.enabled, scripts: options.enabled && options.scripts,
      ...(options.enabled ? { enabledAt: previous.enabledAt ?? new Date().toISOString() } : {}),
    }
    if (!blobs) {
      this.store.set(key(tenant), JSON.stringify(policy))
      return
    }
    try {
      await blobs.put(omissionPolicyPath(tenant), JSON.stringify(policy), undefined, !current, undefined, current?.etag ?? undefined)
    } catch (error) {
      if (!(error instanceof ProtectedBlobError)) throw error
      throw new Error("The storage account's immutability policy or legal hold prevents updating the backup omission policy. Ask your Azure administrator to configure a destination where this policy blob can be updated.", { cause: error })
    }
    if (policy.enabled) this.store.set(this.bindingKey(tenant, account), "true")
  }
}
