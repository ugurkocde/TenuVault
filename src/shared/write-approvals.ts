export const WRITE_APPROVAL_POLICY_VERSION = 1
export const WRITE_APPROVAL_LIFETIME = 7 * 24 * 60 * 60 * 1000

export type ApprovalActor = { oid: string; label: string }
export type WriteApprovalTarget = {
  name: string
  id?: string
  assignments: string[]
  fields: string[]
  sensitiveFields: string[]
}

export type WriteApprovalSummary = {
  kind: string
  count: number
  targets: string[]
  operations?: WriteApprovalTarget[]
  assignments?: boolean
  reference?: string
  fields?: string[]
  mappings?: { folder: string; sourceId: string; targetId: string }[]
}

export type WriteApprovalState = "pending" | "stale" | "cancelled" | "claimed" | "finished" | "interrupted"
export interface WriteApproval {
  schema: 1
  id: string
  tenant: string
  account: string
  generation: number
  requester: ApprovalActor
  summary: WriteApprovalSummary
  contentHash: string
  targetFingerprint: string
  createdAt: number
  expiresAt: number
  state: WriteApprovalState
}

export interface WriteDecision {
  schema: 1
  requestId: string
  generation: number
  contentHash: string
  targetFingerprint: string
  actor: ApprovalActor
  at: number
  decision: "approved" | "rejected"
}

export interface WriteApprovalInbox {
  available: boolean
  enabled: boolean
  minimumVersion?: string
  actor?: ApprovalActor
  invalidRecords?: number
  requests: Array<{ request: WriteApproval; decision?: WriteDecision; expired: boolean; local: boolean; superseded: boolean }>
}
