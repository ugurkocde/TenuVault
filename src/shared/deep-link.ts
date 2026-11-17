export interface ConnectLink {
  tenantId: string
  clientId: string
  displayName?: string
}

export const INVALID_CONNECT_LINK = "This TenuVault link is not valid."
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Validate the original spelling too: URL normalization must not hide paths or controls. */
export function parseConnectLink(raw: string): ConnectLink | null {
  if (raw.length > 512 || /[\p{C}]/u.test(raw)) return null
  // Some launchers add one harmless slash between the host and query.
  const match = /^tenuvault:\/\/connect\/?\?([^#]*)$/i.exec(raw)
  if (!match) return null
  const values = new Map<string, string>()
  try {
    for (const part of match[1]!.split("&")) {
      const equal = part.indexOf("=")
      if (equal < 0) return null
      const key = decodeURIComponent(part.slice(0, equal).replace(/\+/g, " "))
      const value = decodeURIComponent(part.slice(equal + 1).replace(/\+/g, " "))
      if (!["v", "tenant", "client", "name"].includes(key) || values.has(key)) return null
      values.set(key, value)
    }
  } catch { return null }
  const tenantId = values.get("tenant") ?? ""
  const clientId = values.get("client") ?? ""
  if (values.get("v") !== "1" || !GUID.test(tenantId) || !GUID.test(clientId)) return null
  const name = values.get("name")
  if (name !== undefined && /[\p{C}]/u.test(name)) return null
  const displayName = name?.trim() || undefined
  // Labels are plain text. Reject markup and script payloads rather than trying to sanitize them.
  if (displayName !== undefined && ([...displayName].length > 64 || /[<>]|(?:javascript|vbscript|data):/iu.test(displayName))) return null
  return { tenantId: tenantId.toLowerCase(), clientId: clientId.toLowerCase(), ...(displayName === undefined ? {} : { displayName }) }
}

export interface PendingConnectLink { id: number; details: ConnectLink }
export interface ConnectLinkState { pending: PendingConnectLink | null; rejected: boolean }
