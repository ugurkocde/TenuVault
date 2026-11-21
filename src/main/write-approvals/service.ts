import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { isGuid } from "../../shared/security"
import { assertStorageAccountName } from "../../shared/storage-account"
import {
  WRITE_APPROVAL_LIFETIME, WRITE_APPROVAL_POLICY_VERSION, type ApprovalActor, type WriteApproval,
  type WriteApprovalInbox, type WriteApprovalSummary, type WriteDecision,
} from "../../shared/write-approvals"
import { canonicalJson } from "../features/change-sets/model"
import { isLocalAccount } from "../storage/blob-emulator"
import { ApprovalAccountNotFound, type ApprovalBlobs, type BlobRecord } from "./blob"

type Policy = { schema: 1; tenant: string; account: string; generation: number; enabled: boolean; minimumVersion: string; requester: string; approver?: string; requestId?: string }
type Profile = { clientId: string; storageAccountName: string }
type StorageSession = { tenant: string; account: string; actor: ApprovalActor; blobs: ApprovalBlobs }
type OpenStore = StorageSession & { policy: Policy | null; etag?: string; serverTime?: number }
type Permit = { request: WriteApproval; decision: WriteDecision; context: OpenStore }
type Execution = { tenants: Set<string>; permits: Map<string, Permit>; inactive: Map<string, { profile: string | null; context: OpenStore | null }> }
type Store = { get(key: string): string | null; set(key: string, value: string): void }
type Event = { action: string; tenant: string; account: string; actor: ApprovalActor; generation: number; requestId?: string; requester?: string; approver?: string; receipt?: { id: string; at: number } }
type DecisionReceipt = { event: Event & { receipt: NonNullable<Event["receipt"]> }; path: string; record: WriteApproval | WriteDecision; committed: boolean }

export interface ApprovalOperation {
  tenant: string
  /** Stable origin reference for finding the request when the administrator returns to the operation. */
  reference: unknown
  summary: WriteApprovalSummary
  /** Derived only from verified sources or trusted main records. */
  observe(): Promise<{ content: unknown; target: unknown }>
}

export interface ApprovalDependencies {
  version: string
  store: Store
  profile(tenant: string): Profile | null
  open(tenant: string, clientId: string, account: string): Promise<{ actor: ApprovalActor; blobs: ApprovalBlobs }>
  current(tenant: string, actor: ApprovalActor): boolean
  audit(event: Event): Promise<void>
}

export class WriteApprovalError extends Error {
  constructor(message: string, readonly reason?: "review" | "stale") {
    super(message)
    this.name = "WriteApprovalError"
  }
}

const unavailable = "Use shared Azure storage to request approval from another admin."
const stateChanged = "The tenant approval policy or request changed. Refresh Tenant approvals and try again."
const invalid = () => new WriteApprovalError("The tenant approval record is invalid or uses an unsupported format.")
const namespace = (tenant: string) => `.tenuvault-controls/${tenant}/write-approval/`
const policyPath = (tenant: string) => `${namespace(tenant)}policy.json`
const requestPath = (tenant: string, id: string) => `${namespace(tenant)}requests/${id}.json`
const decisionPath = (tenant: string, id: string) => `${namespace(tenant)}decisions/${id}.json`
const expiredReceiptsKey = (tenant: string) => `write-approval.expired-receipts.${tenant}`
const bindingKey = (tenant: string) => `write-approval.binding.${tenant}`
const previousAccountsKey = (tenant: string) => `write-approval.unverified.${tenant}`
const bindingSeenKey = (tenant: string, account: string) => `write-approval.seen.${tenant}.${account}`
const digestPattern = /^[a-f0-9]{64}$/
const versionParts = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
const actorValid = (actor: ApprovalActor | undefined) => actor && isGuid(actor.oid) && actor.oid === actor.oid.toLowerCase() && typeof actor.label === "string" && actor.label.length <= 200
const retention = 30 * 24 * 60 * 60 * 1000
const stringList = (value: unknown) => Array.isArray(value) && value.every(entry => typeof entry === "string")
const validGeneration = (generation: number) => Number.isSafeInteger(generation) && generation > 0

function atLeast(version: string, minimum: string): boolean {
  if (version === minimum) return Boolean(versionParts(version))
  const current = versionParts(version), required = versionParts(minimum)
  if (!current || !required) return false
  for (const index of [1, 2, 3]) {
    if (Number(current[index]) !== Number(required[index])) return Number(current[index]) > Number(required[index])
  }
  if (!current[4]) return true
  if (!required[4]) return false
  const a = current[4].split("."), b = required[4].split(".")
  for (const [index, part] of a.entries()) {
    const other = b[index]
    if (other === undefined) return true
    if (part === other) continue
    const numeric = /^\d+$/.test(part), otherNumeric = /^\d+$/.test(other)
    if (numeric !== otherNumeric) return otherNumeric
    return numeric ? Number(part) > Number(other) : part > other
  }
  return a.length === b.length
}

function readRequest(blob: BlobRecord | null, tenant: string, account: string, id: string): WriteApproval {
  const r = blob?.value as WriteApproval | null | undefined
  if (!r || r.schema !== WRITE_APPROVAL_POLICY_VERSION || r.id !== id || r.tenant !== tenant || r.account !== account || !validGeneration(r.generation)
    || !actorValid(r.requester) || !digestPattern.test(r.contentHash) || !digestPattern.test(r.targetFingerprint)
    || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt - r.createdAt !== WRITE_APPROVAL_LIFETIME
    || !["pending", "stale", "cancelled", "claimed", "finished", "interrupted"].includes(r.state)
    || typeof r.summary?.kind !== "string" || !Number.isSafeInteger(r.summary.count) || !Array.isArray(r.summary.targets)
    || r.summary.targets.some(value => typeof value !== "string")
    || (r.summary.operations !== undefined && (!Array.isArray(r.summary.operations) || r.summary.operations.some(operation =>
      !operation || typeof operation.name !== "string" || (operation.id !== undefined && typeof operation.id !== "string")
      || (operation.verb !== undefined && typeof operation.verb !== "string") || !stringList(operation.assignments) || !stringList(operation.fields) || !stringList(operation.sensitiveFields))))
    || (r.summary.reference !== undefined && typeof r.summary.reference !== "string")
    || (r.summary.assignments !== undefined && typeof r.summary.assignments !== "boolean")
    || (r.summary.fields !== undefined && (!Array.isArray(r.summary.fields) || r.summary.fields.some(value => typeof value !== "string")))
    || (r.summary.mappings !== undefined && (!Array.isArray(r.summary.mappings) || r.summary.mappings.some(value => !value || typeof value.folder !== "string" || !isGuid(value.sourceId) || !isGuid(value.targetId))))) throw invalid()
  return r
}

async function readDecision(context: StorageSession, request: WriteApproval, allowInvalidTime = false): Promise<WriteDecision | undefined> {
  const blob = await context.blobs.get(decisionPath(context.tenant, request.id))
  if (!blob) return undefined
  const d = blob.value as WriteDecision | null
  if (!d || d.schema !== WRITE_APPROVAL_POLICY_VERSION || d.requestId !== request.id || d.generation !== request.generation
    || d.contentHash !== request.contentHash || d.targetFingerprint !== request.targetFingerprint
    || !actorValid(d.actor) || d.actor.oid === request.requester.oid
    || !Number.isSafeInteger(d.at) || (!allowInvalidTime && d.at < request.createdAt) || d.at >= request.expiresAt
    || !["approved", "rejected"].includes(d.decision)) throw invalid()
  return d
}

export class WriteApprovals {
  private readonly execution = new AsyncLocalStorage<Execution>()
  private readonly applying = new Set<string>()
  private readonly creating = new Set<string>()
  private readonly auditFlushes = new Map<string, Promise<void>>()
  private profileWork: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ApprovalDependencies) {}

  withStorageProfiles<T>(work: () => Promise<T>): Promise<T> {
    const result = this.profileWork.then(work)
    this.profileWork = result.catch(() => undefined)
    return result
  }

  private digest(value: unknown): string {
    const keyName = "write-approval.installation-key"
    let key = this.deps.store.get(keyName)
    if (!key) {
      key = randomBytes(32).toString("hex")
      this.deps.store.set(keyName, key)
    }
    return createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(value)).digest("hex")
  }

  private async open(raw: string, expectedActor?: ApprovalActor, beforePolicy?: (session: StorageSession) => Promise<void>, cached?: OpenStore, storageChange = false): Promise<OpenStore | null> {
    if (!isGuid(raw)) throw new WriteApprovalError("A valid destination tenant is required.")
    const tenant = raw.toLowerCase()
    const profile = this.deps.profile(tenant)
    if (!storageChange) await this.verifyPreviousAccounts(tenant, profile)
    const pinned = this.deps.store.get(bindingKey(tenant)) || null
    if (!profile) {
      if (pinned) throw new WriteApprovalError("Reconnect the destination tenant to verify its write approval policy.")
      return null
    }
    if (pinned && pinned !== profile.storageAccountName.toLowerCase()) throw new WriteApprovalError(`This tenant is enrolled with ${pinned}. Reconnect that shared storage account before writing or changing its approval policy.`)
    const account = pinned ?? profile.storageAccountName.toLowerCase()
    if (isLocalAccount(account)) return null
    assertStorageAccountName(account)
    const { actor, blobs } = await this.deps.open(tenant, profile.clientId, account)
    if (!actorValid(actor) || (expectedActor && actor.oid !== expectedActor.oid)) throw new WriteApprovalError("The signed-in destination account changed. Sign in again and review the request.")
    await beforePolicy?.({ tenant, account, actor, blobs })
    if (cached?.policy?.enabled && cached.etag && blobs.match) {
      if (cached.tenant !== tenant || cached.account !== account) throw new WriteApprovalError(stateChanged)
      const match = await blobs.match(policyPath(tenant), cached.etag)
      if (match?.etag !== cached.etag) throw new WriteApprovalError(stateChanged)
      this.checkActor(tenant, actor)
      return { tenant, account, actor, blobs, policy: cached.policy, etag: match.etag, serverTime: match.serverTime }
    }
    if (cached && (cached.tenant !== tenant || cached.account !== account)) throw new WriteApprovalError(stateChanged)
    const blob = cached?.etag && blobs.revalidate
      ? await blobs.revalidate(policyPath(tenant), cached.etag)
      : await blobs.get(policyPath(tenant))
    if (!this.deps.current(tenant, actor)) throw new WriteApprovalError("The destination account changed while checking approvals.")
    if (!blob) {
      const seen = this.deps.store.get(bindingSeenKey(tenant, account))
      if (pinned || (seen && !(storageChange && seen === "disabled"))) throw new WriteApprovalError("The enrolled tenant approval policy is missing from shared storage.")
      return { tenant, account, actor, blobs, policy: null }
    }
    const policy = (blob.value === undefined && cached?.etag === blob.etag ? cached.policy : blob.value) as Policy | null
    if (!policy || policy.schema !== WRITE_APPROVAL_POLICY_VERSION || policy.tenant !== tenant || policy.account !== account
      || !validGeneration(policy.generation) || typeof policy.enabled !== "boolean" || !isGuid(policy.requester)
      || (!policy.enabled && (!isGuid(policy.approver) || !isGuid(policy.requestId) || policy.approver === policy.requester))
      || typeof policy.minimumVersion !== "string" || !versionParts(policy.minimumVersion)) throw invalid()
    this.deps.store.set(bindingSeenKey(tenant, account), policy.enabled ? "1" : "disabled")
    if (policy.enabled) this.deps.store.set(bindingKey(tenant), account)
    else if (pinned) this.deps.store.set(bindingKey(tenant), "")
    if (policy.enabled && !atLeast(this.deps.version, policy.minimumVersion)) throw new WriteApprovalError(`This tenant requires TenuVault ${policy.minimumVersion} or later.`)
    return { tenant, account, actor, blobs, policy, etag: blob.etag, serverTime: blob.serverTime }
  }

  private previousAccounts(tenant: string): Profile[] {
    return JSON.parse(this.deps.store.get(previousAccountsKey(tenant)) ?? "[]") as Profile[]
  }

  private async verifyPreviousAccounts(tenant: string, profile: Profile | null): Promise<void> {
    const previous = this.previousAccounts(tenant)
    for (const old of previous) {
      const account = old.storageAccountName
      if (this.deps.store.get(bindingKey(tenant))) break
      const seen = this.deps.store.get(bindingSeenKey(tenant, account))
      if (seen && profile?.storageAccountName.toLowerCase() !== account) {
        const { actor, blobs } = await this.deps.open(tenant, profile?.clientId ?? old.clientId, account)
        if (!actorValid(actor)) throw new WriteApprovalError("Sign in to check the tenant's prior approval policy.")
        const blob = await blobs.get(policyPath(tenant)).catch(error => {
          if (seen === "disabled" && error instanceof ApprovalAccountNotFound) return null
          throw error
        })
        this.checkActor(tenant, actor)
        const policy = blob?.value as Policy | undefined
        if (blob && (!policy || policy.schema !== 1 || policy.tenant !== tenant || policy.account !== account
          || !validGeneration(policy.generation) || typeof policy.enabled !== "boolean" || !isGuid(policy.requester)
          || !versionParts(policy.minimumVersion ?? "") || (!policy.enabled && (!isGuid(policy.approver) || !isGuid(policy.requestId) || policy.approver === policy.requester)))) throw invalid()
        if (policy?.enabled) this.deps.store.set(bindingKey(tenant), account)
        if (!blob && seen !== "disabled") throw new WriteApprovalError("The enrolled tenant approval policy is missing from shared storage.")
      }
      this.deps.store.set(previousAccountsKey(tenant), JSON.stringify(this.previousAccounts(tenant).filter(entry => entry.storageAccountName !== account)))
    }
  }

  private tracksStorage(tenant: string): boolean {
    const account = this.deps.profile(tenant)?.storageAccountName.toLowerCase()
    return Boolean(this.deps.store.get(bindingKey(tenant)) || account && this.deps.store.get(bindingSeenKey(tenant, account)))
  }

  /** Verify the account before replacing its profile. Keep enrollment independent of that profile. */
  async beforeStorageChange(tenant: string, nextAccount?: string, confirm?: (account: string, recheck: boolean) => Promise<boolean>, signedIn = true): Promise<void> {
    const profile = this.deps.profile(tenant)
    const previous = profile?.storageAccountName.toLowerCase()
    const pinned = this.deps.store.get(bindingKey(tenant))
    const next = nextAccount?.toLowerCase()
    if (next === previous && (!pinned || next === pinned)) return
    if (pinned && (!next || next === pinned)) return
    if (!signedIn && !next && !this.tracksStorage(tenant)) return
    let context: OpenStore | null
    try {
      context = await this.open(tenant, undefined, undefined, undefined, true)
    } catch (error) {
      if (!pinned && previous && this.deps.store.get(bindingSeenKey(tenant, previous)) === "disabled" && error instanceof ApprovalAccountNotFound) return
      if (pinned || !profile || !previous || error instanceof WriteApprovalError || !confirm) throw error
      const recheck = this.tracksStorage(tenant)
      if (!await confirm(previous, recheck)) throw new WriteApprovalError("The storage change was cancelled.")
      if (recheck) {
        const accounts = this.previousAccounts(tenant)
        if (!accounts.some(entry => entry.storageAccountName === previous)) {
          this.deps.store.set(previousAccountsKey(tenant), JSON.stringify([...accounts, { ...profile, storageAccountName: previous }]))
        }
      }
      return
    }
    if (context?.policy?.enabled && next) {
      throw new WriteApprovalError(`This tenant is enrolled with ${context.account}. Ask another admin to approve disabling tenant write approval before changing storage.`)
    }
  }

  private profileKey(tenant: string): string | null {
    const profile = this.deps.profile(tenant)
    return profile ? canonicalJson([profile.clientId, profile.storageAccountName.toLowerCase()]) : null
  }

  async inbox(tenant: string): Promise<WriteApprovalInbox> {
    const context = await this.open(tenant)
    if (!context) return { available: false, enabled: false, requests: [] }
    await this.flushDecisionReceipts(context)
    const { account, actor, policy, blobs } = context
    const prefix = `${namespace(context.tenant)}requests/`
    const names = await blobs.list(prefix)
    const requests: WriteApprovalInbox["requests"] = []
    let invalidRecords = 0
    // Bound fan-out so a large shared inbox cannot exhaust Chromium's request queue.
    for (let start = 0; start < names.length; start += 16) {
      await Promise.all(names.slice(start, start + 16).map(async name => {
        const id = name.slice(prefix.length).replace(/\.json$/, "")
        if (!isGuid(id) || name !== requestPath(context.tenant, id)) { invalidRecords++; return }
        let blob: BlobRecord | null
        let request: WriteApproval
        let decision: WriteDecision | undefined
        try {
          blob = await blobs.get(name)
          if (!blob) { invalidRecords++; return }
          request = readRequest(blob, context.tenant, account, id)
          decision = await readDecision(context, request, true)
        } catch {
          invalidRecords++
          return
        }
        const superseded = request.generation !== policy?.generation
        const expired = this.time(blob, context) >= request.expiresAt
        const terminal = request.state !== "claimed" && (request.state !== "pending" || expired || superseded || decision?.decision === "rejected")
        if (blobs.delete && terminal && this.time(blob, context) >= Math.max(request.expiresAt, blob.modifiedAt ?? 0, decision?.at ?? 0) + retention) {
          try {
            if (await blobs.delete(name, blob.etag)) {
              const path = decisionPath(context.tenant, id)
              const decisionBlob = await blobs.get(path)
              if (decisionBlob) await blobs.delete(path, decisionBlob.etag)
            }
            return
          } catch (error) {
            console.warn("[write approvals] Could not prune a finished approval request", error)
          }
        }
        requests.push({ request, decision, invalidDecisionTime: decision !== undefined && decision.at < request.createdAt, expired, local: this.isOrigin(request), superseded })
      }))
    }
    return { available: true, enabled: policy?.enabled === true, minimumVersion: policy?.minimumVersion, actor, invalidRecords, expiredAuditReceipts: Number(this.deps.store.get(expiredReceiptsKey(context.tenant)) ?? 0), requests: requests.sort((a, b) => b.request.createdAt - a.request.createdAt) }
  }

  private time(blob?: BlobRecord | null, context?: OpenStore): number {
    const time = blob?.serverTime ?? context?.serverTime
    if (time === undefined) throw new WriteApprovalError("Azure did not return a server timestamp for the approval store.")
    return time
  }

  private isOrigin(request: WriteApproval): boolean {
    return this.deps.store.get(`write-approval.origin.${request.id}`) === request.requester.oid
  }

  private async receipt(context: OpenStore, action: string, request?: WriteApproval, decision?: WriteDecision): Promise<void> {
    await this.deps.audit({
      action, tenant: context.tenant, account: context.account, actor: context.actor,
      generation: request?.generation ?? context.policy?.generation ?? 1, requestId: request?.id,
      requester: request?.requester.oid, approver: decision?.actor.oid,
    })
  }

  private decisionReceipts(tenant: string): DecisionReceipt[] {
    return JSON.parse(this.deps.store.get(`write-approval.decision-receipts.${tenant}`) ?? "[]") as DecisionReceipt[]
  }

  private updateDecisionReceipt(tenant: string, id: string, receipt?: DecisionReceipt): void {
    const pending = this.decisionReceipts(tenant).filter(entry => entry.event.receipt.id !== id)
    if (receipt) pending.push(receipt)
    this.deps.store.set(`write-approval.decision-receipts.${tenant}`, JSON.stringify(pending))
  }

  private flushDecisionReceipts(c: OpenStore): Promise<void> {
    const existing = this.auditFlushes.get(c.tenant)
    const flush = (existing ?? Promise.resolve()).catch(() => undefined).then(async () => {
      for (const entry of this.decisionReceipts(c.tenant)) {
        const { id } = entry.event.receipt
        try {
          if (!entry.committed) {
            const expired = (c.serverTime ?? Date.now()) >= entry.event.receipt.at + retention
            const blob = c.account === entry.event.account ? await c.blobs.get(entry.path).catch(error => {
              if (expired) return null
              throw error
            }) : null
            if (!blob || canonicalJson(blob.value) !== canonicalJson(entry.record)) {
              if (expired) {
                const key = expiredReceiptsKey(c.tenant)
                this.deps.store.set(key, String(Number(this.deps.store.get(key) ?? 0) + 1))
                this.updateDecisionReceipt(c.tenant, id)
              }
              continue
            }
            this.updateDecisionReceipt(c.tenant, id, { ...entry, committed: true })
          }
          await this.deps.audit(entry.event)
          this.updateDecisionReceipt(c.tenant, id)
        } catch (error) {
          console.warn("[write approvals] Decision audit receipt remains queued", error)
        }
      }
    }).finally(() => {
      if (this.auditFlushes.get(c.tenant) === flush) this.auditFlushes.delete(c.tenant)
    })
    this.auditFlushes.set(c.tenant, flush)
    return flush
  }

  private async commitDecision(c: OpenStore, request: WriteApproval, path: string, record: WriteDecision | WriteApproval,
    action: string, at: number, etag?: string): Promise<void> {
    this.checkActor(c.tenant, c.actor)
    const id = randomUUID()
    const entry: DecisionReceipt = {
      event: { action, tenant: c.tenant, account: c.account, actor: c.actor, generation: request.generation, requestId: request.id,
        requester: request.requester.oid, approver: "decision" in record ? record.actor.oid : undefined, receipt: { id, at } },
      path, record, committed: false,
    }
    this.updateDecisionReceipt(c.tenant, id, entry)
    const committed = await c.blobs.put(path, record, etag).catch(async error => {
      const current = await c.blobs.get(path).catch(() => null)
      if (current && canonicalJson(current.value) === canonicalJson(record)) return true
      throw error
    })
    if (!committed) {
      this.updateDecisionReceipt(c.tenant, id)
      throw new WriteApprovalError(stateChanged)
    }
    try {
      if (this.decisionReceipts(c.tenant).some(pending => pending.event.receipt.id === id)) {
        this.updateDecisionReceipt(c.tenant, id, { ...entry, committed: true })
      }
      await this.flushDecisionReceipts(c)
    } catch (error) {
      console.warn("[write approvals] Could not flush the committed decision audit receipt", error)
    }
  }

  async enable(tenant: string): Promise<void> {
    return this.withStorageProfiles(() => this.enablePolicy(tenant))
  }

  private async enablePolicy(tenant: string): Promise<void> {
    const c = await this.open(tenant)
    if (!c) throw new WriteApprovalError(unavailable)
    if (c.policy?.enabled) return
    const policy: Policy = { schema: 1, tenant: c.tenant, account: c.account, generation: (c.policy?.generation ?? 0) + 1, enabled: true, minimumVersion: this.deps.version, requester: c.actor.oid }
    if (!versionParts(policy.minimumVersion)) throw invalid()
    const event = { tenant: c.tenant, account: c.account, actor: c.actor, generation: policy.generation, requester: c.actor.oid }
    await this.deps.audit({ ...event, action: "Tenant write approval enable requested" })
    this.checkActor(c.tenant, c.actor)
    if (!await c.blobs.put(policyPath(c.tenant), policy, c.etag)) throw new WriteApprovalError(stateChanged)
    this.deps.store.set(bindingKey(c.tenant), c.account)
    await this.deps.audit({ ...event, action: "Tenant write approval enabled" })
  }

  async disable(tenant: string): Promise<void> {
    await this.run([{ tenant, reference: "disable", summary: { kind: "Disable tenant write approval", count: 1, targets: [] }, observe: async () => ({ content: "disable", target: null }) }], async () => {
      const c = await this.open(tenant)
      if (!c?.policy?.enabled) return
      const permit = this.execution.getStore()?.permits.get(c.tenant)
      if (this.execution.getStore()?.permits.size !== 1 || !permit || permit.request.generation !== c.policy.generation || c.actor.oid !== permit.request.requester.oid) throw new WriteApprovalError(stateChanged)
      await this.receipt(c, "Tenant write approval disable requested", permit.request, permit.decision)
      await this.authorize(c.tenant, c.actor)
      this.checkDeadline(c.tenant)
      const policy: Policy = { ...c.policy, enabled: false, generation: c.policy.generation + 1, requester: c.actor.oid, approver: permit.decision.actor.oid, requestId: permit.request.id }
      if (!this.deps.current(c.tenant, c.actor) || !await c.blobs.put(policyPath(c.tenant), policy, c.etag)) throw new WriteApprovalError(stateChanged)
      this.deps.store.set(bindingSeenKey(c.tenant, c.account), "disabled")
      this.deps.store.set(bindingKey(c.tenant), "")
      await this.receipt(c, "Tenant write approval disabled", permit.request, permit.decision)
    })
  }

  async decide(tenant: string, id: string, action: "approve" | "reject" | "cancel"): Promise<void> {
    if (!isGuid(id)) throw invalid()
    const c = await this.open(tenant)
    if (!c) throw new WriteApprovalError(unavailable)
    const path = requestPath(c.tenant, id)
    const blob = await c.blobs.get(path)
    const r = readRequest(blob, c.tenant, c.account, id)
    if (r.state !== "pending") throw new WriteApprovalError(stateChanged)
    if (action === "cancel") {
      if (r.requester.oid !== c.actor.oid) throw new WriteApprovalError("Only the requester can cancel this request.")
      await this.commitDecision(c, r, path, { ...r, state: "cancelled" }, "Tenant write approval cancelled", this.time(blob, c), blob!.etag)
      return
    }
    if (r.requester.oid === c.actor.oid) throw new WriteApprovalError("A different signed-in admin must decide this request.")
    const at = this.time(blob, c)
    if (at < r.createdAt) throw new WriteApprovalError("The request creation time is ahead of Azure. Cancel it and request approval again.")
    if (!c.policy?.enabled || r.generation !== c.policy.generation || at >= r.expiresAt) throw new WriteApprovalError("This request has expired or its policy generation has changed.")
    const decision: WriteDecision = {
      schema: 1, requestId: r.id, generation: r.generation, contentHash: r.contentHash, targetFingerprint: r.targetFingerprint,
      actor: c.actor, at, decision: action === "approve" ? "approved" : "rejected",
    }
    await this.commitDecision(c, r, decisionPath(c.tenant, id), decision, action === "approve" ? "Tenant write approved" : "Tenant write rejected", at)
  }

  async run<T>(operations: ApprovalOperation[], work: () => Promise<T>): Promise<T> {
    const execution: Execution = { tenants: new Set(), permits: new Map(), inactive: new Map() }
    const ready: { context: OpenStore; request: WriteApproval; decision: WriteDecision; etag: string; operation: ApprovalOperation }[] = []
    const blockers: string[] = []
    let stale = false
    const { tenants } = execution
    for (const operation of operations) {
      const tenant = operation.tenant.toLowerCase()
      if (tenants.has(tenant)) throw new WriteApprovalError("Each destination must appear only once in an approval operation.")
      tenants.add(tenant)
      const profile = this.profileKey(tenant)
      const context = await this.open(tenant)
      if (!context?.policy?.enabled) {
        if (this.profileKey(tenant) !== profile) throw new WriteApprovalError(stateChanged)
        execution.inactive.set(tenant, { profile, context })
        continue
      }
      const { account, actor, policy, blobs } = context
      const slot = `write-approval.slot.${this.digest([tenant, account, actor.oid, operation.reference])}`
      const observed = await operation.observe()
      this.checkActor(tenant, actor)
      const contentHash = this.digest([operation.summary, observed.content])
      const targetFingerprint = this.digest(observed.target)
      const slotValue = this.deps.store.get(slot)
      const [id, storedExpiry] = slotValue?.split(":") ?? []
      const current = id ? await blobs.get(requestPath(tenant, id)) : null
      const prior = id && current ? readRequest(current, tenant, account, id) : null
      if (id && (prior ? prior.requester.oid !== actor.oid || !this.isOrigin(prior)
        : !storedExpiry || this.time(current, context) < Number(storedExpiry) + retention)) throw invalid()
      if (prior && prior.generation === policy.generation && prior.state === "claimed") {
        blockers.push(`Request ${prior.id} has an uncertain apply outcome. Reconcile the operation in Intune before starting a fresh request.`)
        continue
      }
      if (prior && prior.generation === policy.generation && prior.state === "pending" && this.time(current, context) < prior.expiresAt) {
        const decision = await readDecision(context, prior)
        if (prior.contentHash !== contentHash || prior.targetFingerprint !== targetFingerprint || canonicalJson(prior.summary) !== canonicalJson(operation.summary)) {
          if (!await blobs.put(requestPath(tenant, prior.id), { ...prior, state: "stale" }, current!.etag)) throw new WriteApprovalError(stateChanged)
          await this.receipt(context, "Tenant write approval invalidated", prior)
          stale = true
          blockers.push(`The source, options or destination changed after request ${prior.id}. Review the operation and request approval again.`)
        } else if (decision?.decision === "approved") {
          ready.push({ context, request: prior, decision, etag: current!.etag, operation })
        } else {
          blockers.push(`Tenant approval ${prior.id} is ${decision ? "rejected" : "pending"}. Open Tenant approvals in Settings.`)
        }
        continue
      }
      const createdAt = this.time(undefined, context)
      const request: WriteApproval = {
        schema: 1, tenant, account, id: randomUUID(), generation: policy.generation, requester: actor,
        summary: operation.summary, contentHash, targetFingerprint, createdAt, expiresAt: createdAt + WRITE_APPROVAL_LIFETIME, state: "pending",
      }
      if (this.creating.has(slot) || this.deps.store.get(slot) !== slotValue) throw new WriteApprovalError(stateChanged)
      this.creating.add(slot)
      try {
        this.checkActor(tenant, actor)
        if (!await blobs.put(requestPath(tenant, request.id), request)) throw new WriteApprovalError(stateChanged)
        this.deps.store.set(`write-approval.origin.${request.id}`, actor.oid)
        this.deps.store.set(slot, `${request.id}:${request.expiresAt}`)
      } finally {
        this.creating.delete(slot)
      }
      await this.receipt(context, "Tenant write approval requested", request)
      blockers.push(`Tenant approval ${request.id} is pending. Open Tenant approvals in Settings.`)
    }
    if (blockers.length) throw new WriteApprovalError(blockers.join(" "), stale ? "stale" : "review")
    const claimed: typeof ready = []
    let finished = false
    try {
      // Every destination has a decision and has been observed before any claim or Graph write.
      for (const entry of ready) {
        const { context: c, request: r, decision, etag } = entry
        const observed = await entry.operation.observe()
        if (r.contentHash !== this.digest([entry.operation.summary, observed.content]) || r.targetFingerprint !== this.digest(observed.target)) throw new WriteApprovalError(stateChanged)
        const live = await this.open(c.tenant, c.actor, undefined, c)
        if (!live?.policy?.enabled || live.policy.generation !== r.generation || this.time(undefined, live) >= r.expiresAt || this.applying.has(r.id)) throw new WriteApprovalError(stateChanged)
        this.applying.add(r.id)
        try {
          if (!await live.blobs.put(requestPath(c.tenant, r.id), { ...r, state: "claimed" }, etag)) throw new WriteApprovalError(stateChanged)
        } catch (error) {
          this.applying.delete(r.id)
          throw error
        }
        claimed.push(entry)
        execution.permits.set(c.tenant, { request: r, decision, context: live })
        await this.receipt(c, "Tenant write approval claimed", r, decision)
      }
      const result = await this.execution.run(execution, work)
      finished = true
      return result
    } finally {
      execution.permits.clear()
      for (const { context: c, request: r, decision } of claimed) {
        try {
          const path = requestPath(c.tenant, r.id)
          const blob = await c.blobs.get(path)
          if (blob && readRequest(blob, c.tenant, c.account, r.id).state === "claimed"
            && await c.blobs.put(path, { ...r, state: finished ? "finished" : "interrupted" }, blob.etag)) {
            await this.receipt(c, finished ? "Tenant approval apply finished" : "Tenant approval apply interrupted", r, decision)
          }
        } catch (error) {
          console.error("[write approvals] Could not record the apply outcome", error)
        } finally { this.applying.delete(r.id) }
      }
    }
  }

  async releaseInterrupted(tenant: string, id: string): Promise<void> {
    if (!isGuid(id)) throw invalid()
    const c = await this.open(tenant)
    if (!c) throw new WriteApprovalError(unavailable)
    const path = requestPath(c.tenant, id)
    const blob = await c.blobs.get(path)
    const request = readRequest(blob, c.tenant, c.account, id)
    if (request.state !== "claimed" || request.requester.oid !== c.actor.oid || !this.isOrigin(request) || this.applying.has(id)) {
      throw new WriteApprovalError("Only the original installation can close an interrupted apply after it has stopped running.")
    }
    this.checkActor(c.tenant, c.actor)
    if (!await c.blobs.put(path, { ...request, state: "interrupted" }, blob!.etag)) throw new WriteApprovalError(stateChanged)
    await this.receipt(c, "Tenant approval interrupted apply closed", request, await readDecision(c, request))
  }

  checkDestination(tenant: string): void {
    const execution = this.execution.getStore()
    if (execution && !execution.tenants.has(tenant)) throw new WriteApprovalError("This destination was not included in the tenant write review.")
  }

  checkDeadline(tenant: string): void {
    const permit = this.execution.getStore()?.permits.get(tenant)
    if (permit && this.time(undefined, permit.context) >= permit.request.expiresAt) throw new WriteApprovalError("The tenant write approval expired before dispatch.")
  }

  checkSource(tenant: string, account: unknown): void {
    const profile = this.deps.profile(tenant.toLowerCase())
    if (!profile || typeof account !== "string" || profile.storageAccountName.toLowerCase() !== account.toLowerCase()) {
      throw new WriteApprovalError("The operation names a backup account that is different from the connected profile.")
    }
  }

  private checkActor(tenant: string, actor: ApprovalActor): void {
    if (!this.deps.current(tenant, actor)) throw new WriteApprovalError("The destination account changed while checking approvals.")
  }

  claimed(tenant: string): boolean { return this.execution.getStore()?.permits.has(tenant.toLowerCase()) === true }
  hasClaimedDestination(): boolean { return (this.execution.getStore()?.permits.size ?? 0) > 0 }

  hasBinding(tenant: string): boolean {
    return Boolean(this.deps.store.get(bindingKey(tenant.toLowerCase())))
  }

  async active(tenant: string): Promise<boolean> {
    return (await this.open(tenant))?.policy?.enabled === true
  }

  async authorize(tenant: string, actor: ApprovalActor): Promise<void> {
    tenant = tenant.toLowerCase()
    const inactive = this.execution.getStore()?.inactive.get(tenant)
    if (inactive && inactive.profile !== this.profileKey(tenant)) throw new WriteApprovalError(stateChanged)
    const permit = this.execution.getStore()?.permits.get(tenant)
    if (!permit) {
      const profile = this.profileKey(tenant)
      const live = await this.open(tenant, actor, undefined, inactive?.context ?? undefined)
      if (profile !== this.profileKey(tenant)) throw new WriteApprovalError(stateChanged)
      if (!live?.policy?.enabled) {
        if (inactive) inactive.context = live
        return
      }
      throw new WriteApprovalError("A current tenant write approval is required from a different admin. Open Tenant approvals in Settings.")
    }
    const c = permit.context
    if (permit.request.requester.oid !== actor.oid || this.time(undefined, c) >= permit.request.expiresAt) {
      throw new WriteApprovalError("A current tenant write approval is required from a different admin. Open Tenant approvals in Settings.")
    }
    const profile = this.profileKey(tenant)
    const policy = await this.open(tenant, actor, async session => {
      if (session.account !== c.account) throw new WriteApprovalError(stateChanged)
      const blob = await session.blobs.get(requestPath(tenant, permit.request.id))
      const live = readRequest(blob, tenant, session.account, permit.request.id)
      const decision = await readDecision(session, live)
      if (live.state !== "claimed" || live.contentHash !== permit.request.contentHash || live.targetFingerprint !== permit.request.targetFingerprint
        || live.requester.oid !== actor.oid || live.generation !== permit.request.generation || live.expiresAt !== permit.request.expiresAt
        || this.time(blob, c) >= live.expiresAt || decision?.decision !== "approved" || decision.actor.oid !== permit.decision.actor.oid) {
        throw new WriteApprovalError(stateChanged)
      }
    }, c)
    if (profile !== this.profileKey(tenant) || !policy?.policy?.enabled || policy.etag !== c.etag || this.time(undefined, policy) >= permit.request.expiresAt) throw new WriteApprovalError(stateChanged)
    permit.context = policy
    this.checkActor(tenant, actor)
  }
}

let runtime: WriteApprovals | undefined
export function setWriteApprovals(service: WriteApprovals | undefined): void { runtime = service }
export function hasWriteApproval(tenant: string): boolean { return runtime?.claimed(tenant) ?? false }
export function hasClaimedDestination(): boolean { return runtime?.hasClaimedDestination() ?? false }
export function approvalsEnabled(tenant: string): Promise<boolean> { return runtime?.active(tenant) ?? Promise.resolve(false) }
/** Only an enrolled destination makes unreadable peers a batch-level refusal. */
export async function enrolledBatchDestinations(tenants: string[]): Promise<Set<string>> {
  const checks = await Promise.allSettled(tenants.map(approvalsEnabled))
  const enrolled = new Set(tenants.filter((_, index) => {
    const result = checks[index]
    return result?.status === "fulfilled" ? result.value : runtime?.hasBinding(tenants[index]!)
  }))
  if (enrolled.size) {
    for (const result of checks) if (result.status === "rejected") throw result.reason
  }
  return enrolled
}
export function withWriteApproval<T>(operations: ApprovalOperation[], work: () => Promise<T>): Promise<T> {
  return runtime?.run(operations, work) ?? work()
}

export function verifyApprovalSource(tenant: string, account: unknown): void { runtime?.checkSource(tenant, account) }
