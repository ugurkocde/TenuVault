import { isGuid } from "../../shared/security"

export const WRITE_APPROVAL_NOTICE = "tenuvault-write-approval"

export type ApprovalNotice = { message: string; tenant?: string; ids: string[] }

export function isApprovalBlocker(message: string): boolean {
  return /tenant (?:write )?approval|approval policy|after request [a-f0-9-]{36}|uncertain apply outcome/i.test(message)
}

export function reportWriteApproval(message: string, tenant: unknown): void {
  if (!isApprovalBlocker(message)) return
  const ids = [...new Set((message.match(/[a-f0-9-]{36}/gi) ?? []).filter(isGuid))]
  window.dispatchEvent(new CustomEvent<ApprovalNotice>(WRITE_APPROVAL_NOTICE, { detail: { message, tenant: isGuid(tenant) ? tenant : undefined, ids } }))
}
