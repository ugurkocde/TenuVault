import { useEffect, useRef, useState } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { ADD_PERMISSION_ROLES, type PermissionAdditionPreview, type PermissionAdditionResult } from "../../shared/registration-additions"
import { bridge } from "../lib/bridge"

function Names({ title, names }: { title: string; names: string[] }) {
  return <div><h4 className="font-medium">{title}</h4><p className="mt-1 break-words text-xs">{names.join(", ") || "None"}</p></div>
}

/** This dialog owns a single tenant's preview, and discards late answers when it is closed. */
export function AddPermissions({ tenantId, clientId, missing }: { tenantId: string; clientId: string; missing: readonly string[] }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<"signingIn" | "applying" | null>(null)
  const [preview, setPreview] = useState<PermissionAdditionPreview | null>(null)
  const [result, setResult] = useState<PermissionAdditionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++; void bridge.services.cancelAddition?.(tenantId).catch(() => {}) }, [tenantId, clientId])
  const close = () => {
    if (busy === "applying") return
    generation.current++
    setOpen(false); setBusy(null); setPreview(null); setResult(null); setError(null)
    void bridge.services.cancelAddition(tenantId).catch(() => {})
  }
  const run = async (apply: boolean) => {
    const sent = ++generation.current
    setBusy(apply ? "applying" : "signingIn"); setError(null)
    try {
      if (apply && preview) {
        const next = await bridge.services.confirmAddition(tenantId, preview.id)
        if (sent === generation.current) { setResult(next); setPreview(next.preview) }
      } else {
        const next = await bridge.services.previewAddition(tenantId, missing)
        if (sent === generation.current && next.tenantId.toLowerCase() === tenantId.toLowerCase() && next.clientId.toLowerCase() === clientId.toLowerCase()) setPreview(next)
      }
    } catch (failure) { if (sent === generation.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (sent === generation.current) setBusy(null) }
  }
  return <div data-no-select className="space-y-2 border-t border-blue-200 pt-3">
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Add in the app</Button>
    <p className="text-xs">Sign in to review the exact changes before approving them.</p>
    <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" hideClose={busy === "applying"} onEscapeKeyDown={event => { if (busy === "applying") event.preventDefault() }} onInteractOutside={event => event.preventDefault()}>
        <DialogHeader><DialogTitle>{result?.state === "changed" ? "Changed since the preview" : result?.state === "partial" ? "Permissions partly added" : result ? "Permission result" : preview ? "Review permission additions" : "Add permissions in the app"}</DialogTitle>
          <DialogDescription>Change only the app registration this tenant is connected with. Adds only the permissions you approve. The Backup Reader has its own permissions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm text-gray-700">
          {!preview && <>
            <p>Use an {ADD_PERMISSION_ROLES}. Activate an eligible role before continuing. Microsoft may require a higher role under your tenant's consent policy.</p>
            <p>This sign-in uses Microsoft Graph Command Line Tools with Application.ReadWrite.All and DelegatedPermissionGrant.ReadWrite.All, the same broader, setup-only access as quick setup. It must be the same tenant and account you connected. This access is held only for this flow.</p>
            <Names title="Permissions to review" names={[...missing]} />
            <p className="break-all text-xs">Client ID: {clientId}<br />Tenant: {tenantId}</p>
            {!busy && !error && <Button onClick={() => void run(false)}>Sign in to preview</Button>}
          </>}
          {preview && <>
            <div className="rounded-xl bg-blue-50 p-3 text-blue-900"><p className="font-medium">{preview.displayName}</p><p className="break-all text-xs">Client ID: {preview.clientId}<br />Tenant: {preview.tenantId}</p></div>
            <Names title="Permissions to declare" names={preview.declare} />
            <Names title="Scopes to add to tenant-wide consent" names={preview.consent} />
            <p className="text-xs">Only these additions are approved. Other pending permissions will not be consented. The registration and consent are read again before writing.</p>
            <p className="text-xs">Microsoft Graph replaces these values as a whole and offers no documented conditional update. A change by someone else in the same second can be lost. TenuVault reads again right before writing to make this unlikely.</p>
            {!result && !error && <Button disabled={!!busy} onClick={() => void run(true)}>Add approved permissions</Button>}
          </>}
          {busy && <p role="status">{busy === "signingIn" ? "Finish the Microsoft sign-in in your browser. Reading the registration for your preview..." : "Checking for changes, adding approved permissions and verifying access..."}</p>}
          {result && <section role="status" className="space-y-3 rounded-xl bg-muted p-3">
            <p>{result.message}</p>
            {result.state === "changed" ? <><Names title="Verified declaration additions" names={result.declared} /><details open><summary>Current registration and consent</summary><Names title="Current declarations (API / type / permission ID)" names={result.preview.declared} /><Names title="Current tenant-wide Graph consent" names={result.preview.consented} /></details></> : <>
              <Names title="Verified declaration additions" names={result.declared} />
              <Names title="Verified consent additions" names={result.consented} />
              <Names title="Declarations still missing or unverified" names={result.missingDeclarations} />
              <Names title="Consent still missing or unverified" names={result.missingConsent} />
            </>}
          </section>}
          {error && <p role="alert" className="rounded-xl bg-muted p-3">{error}</p>}
          {(error || result) && <p>Close this result to use Azure CLI commands, open the registration in Entra or copy the text for your administrator. Select Check again to see current access. Start Add in the app again for a fresh preview.</p>}
          <Button variant="outline" disabled={busy === "applying"} onClick={close}>{busy === "signingIn" ? "Cancel" : "Close"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
