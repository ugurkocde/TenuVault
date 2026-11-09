import type { Item } from "./registry"

export type ApprovalSignal = { kind: "justification-required" } | { kind: "pending"; code: string } | { kind: "locked-by-other" }
const CODE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** Intune embeds its headers in JSON strings as well as HTTP response headers. */
export function approvalSignal(status: number, body: Item, headers?: Headers): ApprovalSignal | undefined {
  if (status < 400 || status >= 500) return undefined
  const header = headers?.get("x-msft-approval-code")
  if (header && new RegExp(`^${CODE}$`, "i").test(header)) return { kind: "pending", code: header.toLowerCase() }
  if (status < 300) return undefined
  const strings: string[] = []
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 8) return
    if (typeof value === "string") {
      strings.push(value)
      try { walk(JSON.parse(value), depth + 1) } catch { /* plain text */ }
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key.toLowerCase() === "x-msft-approval-code" && typeof child === "string") strings.push(`x-msft-approval-code: ${child}`)
        walk(child, depth + 1)
      }
    }
  }
  walk(body)
  const text = strings.join("\n")
  const code = new RegExp(`x-msft-approval-code[\\s"':=]+(${CODE})`, "i").exec(text)?.[1]
  if (code) return { kind: "pending", code: code.toLowerCase() }
  if (status === 409 && /active Approval Request already exists/i.test(text)) return { kind: "locked-by-other" }
  if (/x-msft-approval-justification|ApprovalRequired/i.test(text)) return { kind: "justification-required" }
  return undefined
}

export function approvalMessage(signal: ApprovalSignal, label: string, written?: string): string {
  const reason = signal.kind === "locked-by-other" ? "Another admin already has a pending request for this object in Intune." : `Multi Admin Approval protects ${label} in this tenant.`
  return written ? `${written} ${reason} This step needs approval.` : `${reason} Nothing was changed.`
}
