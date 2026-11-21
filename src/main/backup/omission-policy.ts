import { randomUUID } from "node:crypto"
import { isLocalAccount } from "../storage/blob-emulator"
import { omissionPolicyPath, type OmissionOptions } from "../../shared/intune/secret-omission"
import type { KeyValueStore } from "../storage/secure-store"
import { BACKUP_OWNER_FILE } from "../../shared/constants"
import { resolveBackupOwnership } from "../../shared/backup-ownership"
import { parseBackupName } from "../../shared/intune/backup-names"
import { mapLimit } from "../../shared/map-limit"
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
const key = (tenant: string) => `backup.omission.${tenant}`
const verificationError = () => new Error("The tenant's backup omission policy could not be verified. Check its storage and try again.")

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
  constructor(private readonly store: KeyValueStore, private readonly fetchImpl: typeof fetch) {}

  private bindingKey(tenant: string, account: string) {
    return `${key(tenant)}.enrolled.${account}`
  }

  private writer(account: string, token: () => Promise<string>, signal?: AbortSignal) {
    return new BlobWriter(this.fetchImpl, account, token, undefined, true, signal)
  }

  async read(tenantId: string, destination: string, token: () => Promise<string>, signal?: AbortSignal): Promise<BackupOmissionPolicy> {
    const tenant = tenantId.toLowerCase()
    const account = destination.toLowerCase()
    signal?.throwIfAborted()
    if (isLocalAccount(account)) {
      const local = this.store.get(key(tenant))
      return local ? parse(JSON.parse(local), tenant) : OFF
    }

    const binding = this.bindingKey(tenant, account)
    const enrolled = this.store.get(binding) || this.store.get(`${key(tenant)}.account`) === account
    const timeout = AbortSignal.timeout(10_000)
    const value = await this.writer(account, token, signal ? AbortSignal.any([signal, timeout]) : timeout).readJson(omissionPolicyPath(tenant)).catch(() => null)
    signal?.throwIfAborted()
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
    const blobs = this.writer(account, isLocalAccount(account) ? async () => "" : token, AbortSignal.timeout(20_000))
    const { prefixes } = await blobs.list("backup-", "/")
    const activation = Date.parse(policy.enabledAt)
    const folders = prefixes.map((prefix) => prefix.replace(/\/$/, "")).filter((folder) =>
      Date.parse(parseBackupName(folder)?.timestamp ?? "") >= Math.floor(activation / 1000) * 1000)
    const results = await mapLimit(folders, 6, async (folder) => {
      const manifest = await blobs.readJson(`${folder}/metadata.json`)
      if (!manifest || manifest.OmissionEnabled === true ||
          (typeof manifest.StartedAt === "string" && Date.parse(manifest.StartedAt) < activation)) return null
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
    await blobs.put(omissionPolicyPath(tenant), JSON.stringify(policy), undefined, !current, undefined, current?.etag ?? undefined)
    if (policy.enabled) this.store.set(this.bindingKey(tenant, account), "true")
  }
}
