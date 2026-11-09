import type { KeyValueStore } from "./secure-store"
import type { Item, Step } from "../../shared/intune/registry"

export interface ApprovalStep { method: Step["method"]; path: string; body?: string; kind: Step["kind"] }
export interface RestoreApproval {
  id: string
  tenantId: string
  requesterId: string
  requesterName?: string
  continuationPending?: boolean
  origin: "restore"
  backupPath: string
  snapshotId?: string
  repairScope?: string
  label: string
  folder: string
  operation: "create" | "update" | "assign" | "delete"
  step: ApprovalStep
  remaining: ApprovalStep[]
  objectId?: string
  fingerprint?: string
  submittedAt: string
  expiresAt?: string
  status: string
  approverNote?: string
  justification: string
  stepNumber: number
  totalSteps: number
  action: "created" | "updated"
  source: Item
  assignments: boolean
  mode: "copy" | "replace"
}

let store: KeyValueStore | undefined
const KEY = "restore.approvals"
export function setRestoreApprovalStore(value: KeyValueStore): void { store = value }
export function restoreApprovals(tenantId: string): RestoreApproval[] {
  return all().filter(entry => entry.tenantId.toLowerCase() === tenantId.toLowerCase())
}
function all(): RestoreApproval[] {
  if (!store) throw new Error("Approval storage is unavailable")
  const raw = store.get(KEY)
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (Array.isArray(parsed)) return parsed as RestoreApproval[]
  store.set(`${KEY}.unreadable.${Date.now()}`, raw)
  store.delete(KEY)
  return []
}
export function saveRestoreApproval(record: RestoreApproval): void {
  const original = all()
  let entries = original.filter(entry => !terminal(entry) || Date.parse(entry.submittedAt) >= Date.now() - 30 * 86400000)
  const index = entries.findIndex(entry => entry.tenantId.toLowerCase() === record.tenantId.toLowerCase() && (entry.id === record.id || (entry.status === "justification-required" && record.status === "justification-required" && entry.step.method === record.step.method && entry.step.path === record.step.path && entry.step.body === record.step.body)))
  if (index < 0) entries.push(record)
  else entries[index] = record
  // A finished request is never sent again, so it keeps only what the list shows, not request bodies that may hold secrets.
  entries = entries.map(entry => terminal(entry) && (entry.step.body !== undefined || entry.remaining.length || Object.keys(entry.source).length) ? { ...entry, source: {}, step: { ...entry.step, body: undefined }, remaining: [] } : entry)
  while (entries.length > 200) {
    const oldest = entries.filter(terminal).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0]
    if (!oldest) throw new Error("Approval storage is full. Dismiss finished requests before submitting more.")
    entries = entries.filter(entry => entry !== oldest)
  }
  if (JSON.stringify(original) !== JSON.stringify(entries)) store!.set(KEY, JSON.stringify(entries))
}
function terminal(record: RestoreApproval): boolean { return !record.continuationPending && ["completed", "rejected", "cancelled", "expired"].includes(record.status) }
export function removeRestoreApproval(tenantId: string, id: string): void {
  store!.set(KEY, JSON.stringify(all().filter(entry => !(entry.id === id && entry.tenantId.toLowerCase() === tenantId.toLowerCase()))))
}
export function dismissRestoreApproval(tenantId: string, id: string): void {
  const record = restoreApprovals(tenantId).find(entry => entry.id === id)
  if (!record || !["justification-required", "stale", "rejected", "cancelled", "expired", "completed"].includes(record.status)) throw new Error("Only finished requests can be dismissed")
  store!.set(KEY, JSON.stringify(all().filter(entry => entry !== record && !(entry.id === id && entry.tenantId.toLowerCase() === tenantId.toLowerCase()))))
}
