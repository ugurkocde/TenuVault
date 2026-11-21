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
import type { ApprovalBlobs, BlobRecord } from "./blob"

type Policy = { schema: 1; tenant: string; account: string; generation: number; enabled: boolean; minimumVersion: string; requester: string; approver?: string; requestId?: string }
type Profile = { clientId: string; storageAccountName: string }
type StorageSession = { tenant: string; account: string; actor: ApprovalActor; blobs: ApprovalBlobs }
type OpenStore = StorageSession & { policy: Policy | null; etag?: string; serverTime?: number }
type Permit = { request: WriteApproval; decision: WriteDecision; context: OpenStore }
type Execution = { tenants: Set<string>; permits: Map<string, Permit>; inactive: Map<string, string | null> }
type Store = { get(key: string): string | null; set(key: string, value: string): void }
type Event = { action: string; tenant: string; account: string; actor: ApprovalActor; generation: number; requestId?: string; requester?: string; approver?: string }

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
  now?: () => number
}

export class WriteApprovalError extends Error {
  constructor(message: string) {
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
const bindingKey = (tenant: string) => `write-approval.binding.${tenant}`
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
      || !stringList(operation.assignments) || !stringList(operation.fields) || !stringList(operation.sensitiveFields))))
    || (r.summary.reference !== undefined && typeof r.summary.reference !== "string")
    || (r.summary.assignments !== undefined && typeof r.summary.assignments !== "boolean")
    || (r.summary.fields !== undefined && (!Array.isArray(r.summary.fields) || r.summary.fields.some(value => typeof value !== "string")))
    || (r.summary.mappings !== undefined && (!Array.isArray(r.summary.mappings) || r.summary.mappings.some(value => !value || typeof value.folder !== "string" || !isGuid(value.sourceId) || !isGuid(value.targetId))))) throw invalid()
  return r
}

async function readDecision(context: StorageSession, request: WriteApproval): Promise<WriteDecision | undefined> {
  const blob = await context.blobs.get(decisionPath(context.tenant, request.id))
  if (!blob) return undefined
  const d = blob.value as WriteDecision | null
  if (!d || d.schema !== WRITE_APPROVAL_POLICY_VERSION || d.requestId !== request.id || d.generation !== request.generation
    || d.contentHash !== request.contentHash || d.targetFingerprint !== request.targetFingerprint
    || !actorValid(d.actor) || d.actor.oid === request.requester.oid
    || !Number.isSafeInteger(d.at) || d.at < request.createdAt || d.at >= request.expiresAt
    || !["approved", "rejected"].includes(d.decision)) throw invalid()
  return d
}

export class WriteApprovals {
  private readonly execution = new AsyncLocalStorage<Execution>()
  private readonly applying = new Set<string>()
  private readonly creating = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: ApprovalDependencies) {
    this.now = deps.now ?? Date.now
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

  private async open(raw: string, expectedActor?: ApprovalActor, beforePolicy?: (session: StorageSession) => Promise<void>, cached?: OpenStore): Promise<OpenStore | null> {
    if (!isGuid(raw)) throw new WriteApprovalError("A valid destination tenant is required.")
    const tenant = raw.toLowerCase()
    const profile = this.deps.profile(tenant)
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
    if (cached?.etag && blobs.match) {
      if (cached.tenant !== tenant || cached.account !== account) throw new WriteApprovalError(stateChanged)
      const match = await blobs.match(policyPath(tenant), cached.etag)
      if (match?.etag !== cached.etag) throw new WriteApprovalError(stateChanged)
      this.checkActor(tenant, actor)
      return { tenant, account, actor, blobs, policy: cached.policy, etag: match.etag, serverTime: match.serverTime }
    }
    const blob = await blobs.get(policyPath(tenant))
    if (!this.deps.current(tenant, actor)) throw new WriteApprovalError("The destination account changed while checking approvals.")
    if (!blob) {
      if (pinned || this.deps.store.get(bindingSeenKey(tenant, account))) throw new WriteApprovalError("The enrolled tenant approval policy is missing from shared storage.")
      return { tenant, account, actor, blobs, policy: null }
    }
    const policy = blob.value as Policy | null
    if (!policy || policy.schema !== WRITE_APPROVAL_POLICY_VERSION || policy.tenant !== tenant || policy.account !== account
      || !validGeneration(policy.generation) || typeof policy.enabled !== "boolean" || !isGuid(policy.requester)
      || (!policy.enabled && (!isGuid(policy.approver) || !isGuid(policy.requestId) || policy.approver === policy.requester))
      || typeof policy.minimumVersion !== "string" || !versionParts(policy.minimumVersion)) throw invalid()
    this.deps.store.set(bindingSeenKey(tenant, account), "1")
    if (policy.enabled) this.deps.store.set(bindingKey(tenant), account)
    else if (pinned) this.deps.store.set(bindingKey(tenant), "")
    if (policy.enabled && !atLeast(this.deps.version, policy.minimumVersion)) throw new WriteApprovalError(`This tenant requires TenuVault ${policy.minimumVersion} or later.`)
    return { tenant, account, actor, blobs, policy, etag: blob.etag, serverTime: blob.serverTime }
  }

  /** Verify the account being replaced while its old profile and delegated session still exist. */
  async beforeStorageChange(tenant: string, nextAccount?: string): Promise<void> {
    const previous = this.deps.profile(tenant)?.storageAccountName.toLowerCase()
    const pinned = this.deps.store.get(bindingKey(tenant))
    const next = nextAccount?.toLowerCase()
    if (next === previous && (!pinned || next === pinned)) return
    if (pinned && next === pinned) return
    const context = await this.open(tenant)
    if (context?.policy?.enabled && next) {
      throw new WriteApprovalError(`This tenant is enrolled with ${context.account}. Ask another admin to approve disabling tenant write approval before changing storage.`)
    }
    // A disconnect can drop the profile, but open() has retained any enrollment independently.
  }

  private profileKey(tenant: string): string | null {
    const profile = this.deps.profile(tenant)
    return profile ? canonicalJson([profile.clientId, profile.storageAccountName.toLowerCase()]) : null
  }

  private inactiveForRun(tenant: string): boolean {
    return !this.deps.store.get(bindingKey(tenant)) && this.execution.getStore()?.inactive.get(tenant) === this.profileKey(tenant)
  }

  async inbox(tenant: string): Promise<WriteApprovalInbox> {
    const context = await this.open(tenant)
    if (!context) return { available: false, enabled: false, requests: [] }
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
        const blob = await blobs.get(name)
        if (!blob) return
        let request: WriteApproval
        let decision: WriteDecision | undefined
        try {
          request = readRequest(blob, context.tenant, account, id)
          decision = await readDecision(context, request)
        } catch (error) {
          if (!(error instanceof WriteApprovalError)) throw error
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
        requests.push({ request, decision, expired, local: this.isOrigin(request), superseded })
      }))
    }
    return { available: true, enabled: policy?.enabled === true, minimumVersion: policy?.minimumVersion, actor, invalidRecords, requests: requests.sort((a, b) => b.request.createdAt - a.request.createdAt) }
  }

  private time(blob?: BlobRecord | null, context?: OpenStore): number {
    return Math.max(this.now(), context?.serverTime ?? 0, blob?.serverTime ?? 0, blob?.modifiedAt ?? 0)
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

  async enable(tenant: string): Promise<void> {
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
      if (!this.deps.current(c.tenant, c.actor) || !await c.blobs.put(path, { ...r, state: "cancelled" }, blob!.etag)) throw new WriteApprovalError(stateChanged)
      await this.receipt(c, "Tenant write approval cancelled", r)
      return
    }
    if (r.requester.oid === c.actor.oid) throw new WriteApprovalError("A different signed-in admin must decide this request.")
    if (!c.policy?.enabled || r.generation !== c.policy.generation || this.time(blob, c) >= r.expiresAt) throw new WriteApprovalError("This request has expired or its policy generation has changed.")
    const decision: WriteDecision = {
      schema: 1, requestId: r.id, generation: r.generation, contentHash: r.contentHash, targetFingerprint: r.targetFingerprint,
      actor: c.actor, at: this.time(blob, c), decision: action === "approve" ? "approved" : "rejected",
    }
    if (!this.deps.current(c.tenant, c.actor) || !await c.blobs.put(decisionPath(c.tenant, id), decision)) throw new WriteApprovalError(stateChanged)
    await this.receipt(c, action === "approve" ? "Tenant write approved" : "Tenant write rejected", r, decision)
  }

  async run<T>(operations: ApprovalOperation[], work: () => Promise<T>): Promise<T> {
    const execution: Execution = { tenants: new Set(), permits: new Map(), inactive: new Map() }
    const ready: { context: OpenStore; request: WriteApproval; decision: WriteDecision; etag: string; operation: ApprovalOperation }[] = []
    const blockers: string[] = []
    const { tenants } = execution
    for (const operation of operations) {
      const tenant = operation.tenant.toLowerCase()
      if (tenants.has(tenant)) throw new WriteApprovalError("Each destination must appear only once in an approval operation.")
      tenants.add(tenant)
      const profile = this.profileKey(tenant)
      const context = await this.open(tenant)
      if (!context?.policy?.enabled) {
        if (this.profileKey(tenant) === profile) execution.inactive.set(tenant, profile)
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
    if (blockers.length) throw new WriteApprovalError(blockers.join(" "))
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
    if (permit && this.now() >= permit.request.expiresAt) throw new WriteApprovalError("The tenant write approval expired before dispatch.")
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

  async active(tenant: string): Promise<boolean> {
    return !this.inactiveForRun(tenant.toLowerCase()) && (await this.open(tenant))?.policy?.enabled === true
  }

  async authorize(tenant: string, actor: ApprovalActor): Promise<void> {
    tenant = tenant.toLowerCase()
    if (this.inactiveForRun(tenant)) return
    const permit = this.execution.getStore()?.permits.get(tenant)
    if (!permit) {
      if (!(await this.open(tenant, actor))?.policy?.enabled) return
      throw new WriteApprovalError("A current tenant write approval is required from a different admin. Open Tenant approvals in Settings.")
    }
    const c = permit.context
    if (permit.request.requester.oid !== actor.oid || this.time(undefined, c) >= permit.request.expiresAt) {
      throw new WriteApprovalError("A current tenant write approval is required from a different admin. Open Tenant approvals in Settings.")
    }
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
    if (!policy?.policy?.enabled || policy.etag !== c.etag || this.time(undefined, policy) >= permit.request.expiresAt) throw new WriteApprovalError(stateChanged)
    this.checkActor(tenant, actor)
  }
}

let runtime: WriteApprovals | undefined
export function setWriteApprovals(service: WriteApprovals | undefined): void { runtime = service }
export function hasWriteApproval(tenant: string): boolean { return runtime?.claimed(tenant) ?? false }
export function approvalsEnabled(tenant: string): Promise<boolean> { return runtime?.active(tenant) ?? Promise.resolve(false) }
export function withWriteApproval<T>(operations: ApprovalOperation[], work: () => Promise<T>): Promise<T> {
  return runtime?.run(operations, work) ?? work()
}

export function verifyApprovalSource(tenant: string, account: unknown): void { runtime?.checkSource(tenant, account) }
