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

const OFF = { enabled: false, scripts: false, generation: "default" }
const key = (tenant: string) => `backup.omission.${tenant}`
const prefix = (tenant: string) => `.tenuvault-control/${tenant}/secret-omission`
const policyPath = (tenant: string) => `${prefix(tenant)}.json`
const enrollmentPath = (tenant: string) => `${prefix(tenant)}-enrolled.json`

function invalid(): never {
  throw new Error("The tenant's backup omission policy could not be verified. Check its storage and try again.")
}

function parse(value: unknown, tenantId: string): Policy {
  const policy = value as Partial<Policy> | null
  if (!policy || policy.version !== 1 || policy.tenantId !== tenantId ||
      typeof policy.enabled !== "boolean" || typeof policy.scripts !== "boolean" ||
      typeof policy.generation !== "string" || !/^[a-f0-9-]{36}$/.test(policy.generation) ||
      (!policy.enabled && policy.scripts)) invalid()
  return policy as Policy
}

export class OmissionPolicyStore {
  private readonly changing = new Set<string>()

  constructor(private readonly store: KeyValueStore, private readonly fetchImpl: typeof fetch) {}

  private location(tenant: string, destination: string, cloudAccount?: string): string | undefined {
    const bound = this.store.get(`${key(tenant)}.account`)
    const azure = isLocalAccount(destination) ? undefined : destination.toLowerCase()
    if (azure && cloudAccount && azure !== cloudAccount) invalid()
    const account = cloudAccount ?? azure ?? bound ?? undefined
    if (bound && bound !== account) invalid()
    if (account) assertStorageAccountName(account)
    return account
  }

  async read(tenantId: string, destination: string, cloud: string | undefined, token: () => Promise<string>, allowMigration = false) {
    const tenant = tenantId.toLowerCase()
    if (this.changing.has(tenant)) throw new Error("Wait for the backup omission policy change to finish.")
    const account = this.location(tenant, destination, cloud)
    const local = this.store.get(key(tenant))
    if (!account) return local ? parse(JSON.parse(local), tenant) : OFF
    try {
      const blobs = new BlobWriter(this.fetchImpl, account, token, undefined, true)
      const policy = await blobs.readJson(policyPath(tenant))
      if (policy) {
        const checked = parse(policy, tenant)
        this.store.set(`${key(tenant)}.account`, account)
        return checked
      }
      if (this.store.get(`${key(tenant)}.account`) || await blobs.readJson(enrollmentPath(tenant))) invalid()
      if (local) {
        if (allowMigration) return { ...parse(JSON.parse(local), tenant), migrationRequired: true as const }
        invalid()
      }
      return OFF
    } catch {
      return invalid()
    }
  }

  async save(tenantId: string, destination: string, cloud: string | undefined, token: () => Promise<string>, options: OmissionOptions): Promise<void> {
    const tenant = tenantId.toLowerCase()
    if (this.changing.has(tenant)) throw new Error("The backup omission policy is already changing.")
    this.changing.add(tenant)
    try {
      const account = this.location(tenant, destination, cloud)
      const policy: Policy = { version: 1, tenantId: tenant, generation: randomUUID(), enabled: options.enabled, scripts: options.enabled && options.scripts }
      if (!account) {
        this.store.set(key(tenant), JSON.stringify(policy))
        return
      }
      const blobs = new BlobWriter(this.fetchImpl, account, token, undefined, true)
      const current = await blobs.readJsonWithETag(policyPath(tenant))
      if (current) {
        parse(current.value, tenant)
        if (!current.etag) invalid()
      }
      // Once enrolled, absence of the policy is a failure for producers on other machines as well.
      try {
        await blobs.put(enrollmentPath(tenant), JSON.stringify({ version: 1, tenantId: tenant }), undefined, true)
      } catch (error) {
        if (!(error instanceof BlobClaimError)) throw error
      }
      this.store.set(`${key(tenant)}.account`, account)
      await blobs.put(policyPath(tenant), JSON.stringify(policy), undefined, !current, undefined, current?.etag ?? undefined)
    } finally {
      this.changing.delete(tenant)
    }
  }
}
