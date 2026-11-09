import type { KeyValueStore } from "./secure-store"
import type { Item, Step } from "../../shared/intune/registry"

export interface ApprovalStep { method: Step["method"]; path: string; body?: string; kind: Step["kind"] }
export interface RestoreApproval {
  id: string
  tenantId: string
  requesterId: string
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
  return JSON.parse(store.get(KEY) ?? "[]") as RestoreApproval[]
}
export function saveRestoreApproval(record: RestoreApproval): void {
  const entries = all()
  const index = entries.findIndex(entry => entry.id === record.id && entry.tenantId.toLowerCase() === record.tenantId.toLowerCase())
  if (index < 0) entries.push(record)
  else entries[index] = record
  store!.set(KEY, JSON.stringify(entries))
}
export function dismissRestoreApproval(tenantId: string, id: string): void {
  const record = restoreApprovals(tenantId).find(entry => entry.id === id)
  if (!record || !["rejected", "cancelled", "expired", "completed"].includes(record.status)) throw new Error("Only finished requests can be dismissed")
  store!.set(KEY, JSON.stringify(all().filter(entry => entry !== record && !(entry.id === id && entry.tenantId.toLowerCase() === tenantId.toLowerCase()))))
}
