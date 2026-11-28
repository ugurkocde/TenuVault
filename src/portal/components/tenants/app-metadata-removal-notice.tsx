import { useEffect, useRef, useState } from "react"
import { bridge } from "../../../renderer/lib/bridge"
import { appMetadataRemovalInstructions, missingPriorScopeMessages, type AppMetadataRemoval } from "../../../shared/app-metadata-removal"
import { Button } from "~/components/ui/button"

import { privilegedRestoreEnabled } from "../../../shared/intune/directory-review-folders"

export const AppMetadataRemovalNotice = privilegedRestoreEnabled ? MetadataRemovalNotice : () => null

function MetadataRemovalNotice({ tenantId, result }: { tenantId: string; result?: AppMetadataRemoval }) {
  const [removal, setRemoval] = useState(result)
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false)
  const generation = useRef(0), retrying = useRef(false)
  useEffect(() => {
    retrying.current = false
    setRemoval(result); setBusy(false); setMessage("")
    const refresh = async () => {
      if (retrying.current) return
      const version = ++generation.current
      try {
        const value = await bridge.auth?.appMetadataRemoval?.(tenantId)
        if (version === generation.current) setRemoval(current => value ?? (current?.status === "verified" ? current : undefined))
      } catch { /* Keep the saved result visible after a read error. */ }
    }
    if (!result) void refresh()
    const unsubscribe = bridge.auth?.onAppMetadataRemovalChanged?.(changed => {
      if (changed === tenantId.toLowerCase()) void refresh()
    })
    return () => { generation.current++; unsubscribe?.() }
  }, [tenantId, result])
  if (!removal) return null
  const retry = async () => {
    const version = ++generation.current
    retrying.current = true
    setBusy(true); setMessage("")
    try {
      const value = await bridge.auth?.appMetadataRemoval?.(tenantId, true)
      if (version !== generation.current) return
      if (value) setRemoval(value)
    } catch (error) {
      if (version === generation.current) setMessage(error instanceof Error ? error.message : "Permission removal could not be verified.")
    } finally {
      if (version === generation.current) { retrying.current = false; setBusy(false) }
    }
  }
  if (removal.status === "active") return <div role="status">
    {removal.removing
      ? <label className="flex items-start gap-2"><input type="checkbox" checked disabled readOnly />Removing the temporary permissions added by this restore</label>
      : <p>Temporary app metadata access is in use. TenuVault will check removal when the restore ends.</p>}
  </div>
  if (removal.status === "verified") return <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-gray-900" role="status">
    <p className="font-medium">Temporary permission removal verified</p>
    <p>{removal.scopes.length ? "Microsoft Graph confirmed that the grants recorded for this restore no longer contain its temporary scopes." : "This restore added no permission scopes."}</p>
    {missingPriorScopeMessages(removal).map(line => <p className="break-words" key={line}>{line}</p>)}
  </div>
  const instructions = appMetadataRemovalInstructions(removal)
  return <section className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-gray-900" aria-label="Temporary permission removal pending" data-no-select>
    <p className="font-medium">Temporary permission removal pending</p>
    <p>Close the Microsoft consent page before retrying. Another app metadata restore waits until the granted permissions have been checked.</p>
    <div className="space-y-1 break-words">{instructions.split("\n").map(line => <p key={line}>{line}</p>)}</div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>{busy ? "Checking removal…" : "Retry removal"}</Button>
      <Button size="sm" variant="outline" onClick={async () => {
        try { await navigator.clipboard.writeText(instructions); setMessage("Instructions copied. Share them with your administrator.") }
        catch { setMessage("Select and copy the instructions above.") }
      }}>Copy instructions for my admin</Button>
    </div>
    {message && <p role="status">{message}</p>}
  </section>
}
