import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { GRAPH_CLI_CLIENT_ID, GRAPH_CLI_UPGRADE, OWN_APP_UPGRADE } from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"

export function StartNowNotice() {
  const { selectedTenant } = useSelectedTenant()
  const credentials = selectedTenant?.credentials
  const tenantId = credentials?.appId.toLowerCase() === GRAPH_CLI_CLIENT_ID ? credentials.tenantId.toLowerCase() : null
  if (!tenantId) return null
  return <StartNowUpgradeLinks tenantId={tenantId} />
}

export function StartNowUpgradeLinks({ tenantId }: { tenantId: string }) {
  const [upgradeTenant, setUpgradeTenant] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setUpgradeTenant(null)
    void bridge.auth.packConsentPlan(tenantId).then(plan => {
      if (current && plan) setUpgradeTenant(tenantId)
    }).catch(() => undefined)
    return () => { current = false }
  }, [tenantId])

  const target = settingsHref("signin", `sign-in-${tenantId}`)
  return (
    <aside aria-label="Start now sign-in" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-blue-200 bg-blue-50 px-6 py-2 text-sm text-blue-800">
      <span>Start now provides read-only backups on this device.</span>
      {upgradeTenant === tenantId && <Link className="font-medium underline" to={target}>{GRAPH_CLI_UPGRADE}</Link>}
      <Link className="font-medium underline" to={target}>{OWN_APP_UPGRADE}</Link>
    </aside>
  )
}
