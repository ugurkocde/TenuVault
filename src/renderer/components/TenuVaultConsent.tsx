import { useState } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import type { PackConsentAction, PackConsentPlan, PackConsentResult } from "../../shared/pack-consent"
import { GRAPH_CLI_UPGRADE, type ConnectionSwitchResult, type WizardSignInResult } from "../../shared/tenant-connection"
import type { PermissionChoice } from "../../shared/services/manifest"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

export function TenuVaultConsent({ tenantId, plan, active, upgrade, onChanged, wizard }: {
  tenantId: string
  plan: PackConsentPlan
  active: boolean
  upgrade?: boolean
  onChanged?: (result: ConnectionSwitchResult) => void
  wizard?: { choice: PermissionChoice; pack?: string; onSignedIn: (result: WizardSignInResult) => void }
}) {
  const [currentPlan, setCurrentPlan] = useState(plan)
  const [open, setOpen] = useState(Boolean(wizard?.pack))
  const [selected, setSelected] = useState(wizard?.pack ?? "")
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, PackConsentResult>>({})
  const [signInNeedsApproval, setSignInNeedsApproval] = useState(false)
  const [error, setError] = useState<string>()
  const pack = currentPlan.packs.find(pack => pack.id === selected) ?? currentPlan.packs[0]!
  const result = results[pack.id]
  const pending = result?.status === "waiting" || result?.status === "handoff" || result?.status === "received"
  const requestAvailable = (signInNeedsApproval && result?.status !== "verified") ||
    (result?.status === "waiting" && result.issue?.code === "AADSTS90095")

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast(`Copied ${label}.`, "success")
    } catch {
      toast(`Could not copy ${label}.`, "error")
    }
  }

  const openPlan = async () => {
    setBusy(true)
    try {
      const fresh = wizard ? plan : await bridge.auth.packConsentPlan(tenantId)
      if (!fresh) {
        toast("TenuVault app sign-in is currently unavailable.", "error")
        return
      }
      setCurrentPlan(fresh)
      setSelected("")
      setResults({})
      setSignInNeedsApproval(false)
      setError(undefined)
      setOpen(true)
    } catch {
      toast("Could not read the permission packs. Try again.", "error")
    } finally {
      setBusy(false)
    }
  }

  const consent = async (action: PackConsentAction) => {
    setBusy(true)
    setError(undefined)
    try {
      const response = wizard
        ? await bridge.auth.wizardPackConsent(tenantId, wizard.choice, pack.id, action)
        : await bridge.auth.packConsent(tenantId, pack.id, action)
      setResults(previous => ({ ...previous, [pack.id]: response }))
    } catch {
      setResults(previous => ({ ...previous, [pack.id]: { status: "error", issue: { code: "unavailable", message: "Could not open this permission request. Try again." } } }))
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError(undefined)
    setSignInNeedsApproval(false)
    try {
      const outcome = wizard
        ? await bridge.auth.wizardStage(tenantId, "tenuvaultApp", wizard.choice)
        : await bridge.auth.switchConnection(tenantId, { method: "tenuvaultApp" })
      if ("error" in outcome) {
        const needsApproval = outcome.error.code === "AADSTS90095"
        setSignInNeedsApproval(needsApproval)
        setError(needsApproval
          ? "Choose a permission pack and select Request approval. (AADSTS90095)"
          : outcome.error.code === "graph_forbidden" ? `Your role can't do this. ${outcome.error.message}`
          : outcome.error.code === "AADSTS65001" ? `Permission not granted. ${outcome.error.message}` : outcome.error.message)
        return
      }
      if ("id" in outcome.result) wizard?.onSignedIn(outcome.result)
      else onChanged?.(outcome.result)
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "TenuVault could not verify the permissions. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return <>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void openPlan()}>
      {wizard ? "Review permission packs and sign in" : active ? "Review permission packs" : upgrade ? GRAPH_CLI_UPGRADE : "Use TenuVault app"}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{wizard || active ? "TenuVault app permissions" : "Switch to the TenuVault app"}</DialogTitle>
          <DialogDescription>{wizard ? "Review the packs for your chosen services. An administrator can approve each pack in Microsoft Entra." : "Review the permission packs for the services and storage this tenant uses. An administrator can approve each pack in Microsoft Entra."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            Permission pack
            <select disabled={busy} value={pack.id} onChange={event => { setSelected(event.target.value); setError(undefined) }} className="mt-1 w-full rounded-md border bg-background px-3 py-2">
              {currentPlan.packs.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">Permissions in this pack ({pack.scopes.length})</summary>
            <p className="mt-2 max-h-32 overflow-y-auto break-words text-xs text-gray-600">{pack.scopes.join(", ")}</p>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void consent("open")}>Open admin consent</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void consent("handoff")}>Send to my admin</Button>
            {requestAvailable && <Button variant="outline" size="sm" disabled={busy} onClick={() => void consent("request")}>Request approval</Button>}
          </div>
          {(result?.status === "waiting" || result?.status === "handoff") && <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            <p className="font-medium" role="status">Waiting for approval</p>
            <p>{result.status === "waiting" && result.issue ? result.issue.message : "After your administrator approves the pack, select Check again."}</p>
            {result.status === "handoff" && <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy(result.url, "consent link")}>Copy link</Button>
              <Button variant="outline" size="sm" onClick={() => void copy(result.message, "message for your administrator")}>Copy message for admin</Button>
            </div>}
          </div>}
          {result?.status === "verified" && <p role="status" className="text-sm text-gray-600">Permissions verified for {pack.label}.</p>}
          {result?.status === "received" && <p role="status" className="text-sm text-gray-600">Microsoft returned a consent confirmation. Select Check again to verify the permissions.</p>}
          {result?.status === "error" && <p role="alert" className="text-sm text-destructive">{result.issue.message}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => {
            if (busy) void bridge.auth.cancelSignIn()
            else setOpen(false)
          }}>{busy ? "Cancel request" : "Close"}</Button>
          {pending && <Button variant="outline" disabled={busy} onClick={() => void consent("check")}>Check again</Button>}
          <Button disabled={busy} onClick={() => void signIn()}>{busy ? "Waiting for Microsoft" : "Sign in"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
