import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { DOCS_HOME_URL } from "../../shared/constants"
import { entraApiPermissionsUrl } from "../../shared/services/modules"
import { bridge } from "../lib/bridge"
import { servicesStatusKey, useOptionalPermission, type PermissionTenant } from "../features/notifications/optional-permissions"

type GroupTenant = PermissionTenant & { name: string }

export const ASSIGNMENT_ACCESS_CONTEXT = "Assignments cannot be changed until TenuVault can read groups."

export const groupAccessMissing = (readable: boolean | null, granted: boolean | null | undefined) => readable === false || granted === false

export function useGroupAccessMissing(tenant: PermissionTenant | null, readable: boolean | null) {
  return groupAccessMissing(readable, useOptionalPermission(tenant, "groupRead")?.granted)
}

export function GroupAccessCard({ tenant, context, onRecheck }: { tenant: GroupTenant; context?: string; onRecheck?: () => void }) {
  const client = useQueryClient()
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState("")
  const check = async () => {
    setChecking(true)
    setStatus("Checking the permission…")
    const key = servicesStatusKey(tenant.tenantId, tenant.appId)
    try {
      await client.cancelQueries({ queryKey: key, exact: true })
      const result = await bridge.services.status(tenant.tenantId, tenant.appId, true)
      client.setQueryData(key, result)
      setStatus(result.optional?.find(entry => entry.id === "groupRead")?.granted === false
        ? "Still not granted. Admin consent can take a few minutes to reach TenuVault. Try again shortly."
        : result.error ? "The permission could not be checked. Try again shortly." : "")
    } catch {
      setStatus("The permission could not be checked. Try again shortly.")
    } finally {
      onRecheck?.()
      setChecking(false)
    }
  }
  return <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
    <h4 className="font-semibold">Group access is needed to choose groups</h4>
    <p>TenuVault cannot read groups in {tenant.name}, so it cannot show group names or check that a group exists. Intune accepts an assignment to a group that does not exist, so TenuVault only assigns groups it can check. Add the delegated GroupMember.Read.All permission to this app registration in Entra and grant admin consent, then select Check again. You do not need to sign in again.</p>
    {context && <p>{context}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <a className="underline underline-offset-2" href={entraApiPermissionsUrl(tenant.appId)} target="_blank" rel="noreferrer">Open in Entra</a>
      <button type="button" className="rounded-full border border-current px-3 py-1 disabled:opacity-60" disabled={checking} onClick={() => void check()}>Check again</button>
      <a className="underline underline-offset-2" href={`${DOCS_HOME_URL}security/permissions/#group-read-groupmemberreadall`} target="_blank" rel="noreferrer">How to add it</a>
    </div>
    <div role="status">{status}</div>
  </div>
}
