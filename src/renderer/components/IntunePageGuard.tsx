import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { NoticeCard, noticeActionClass } from "./NoticeCard"
import { bridge } from "../lib/bridge"
import { settingsHref } from "../lib/settings-section"
import { RequestedTenant } from "./RequestedTenant"

/** Do not mount an Intune workflow for a tenant that chose another service. */
export function IntunePageGuard({ children }: { children: ReactNode }) {
  return <RequestedTenant><IntuneContent>{children}</IntuneContent></RequestedTenant>
}

function IntuneContent({ children }: { children: ReactNode }) {
  const { selectedTenant } = useSelectedTenant()
  const tenantId = selectedTenant?.credentials?.tenantId
  const clientId = selectedTenant?.credentials?.appId
  const [state, setState] = useState<{ tenantId: string; enabled?: boolean; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!tenantId || !clientId) return
    let active = true
    let generation = 0
    const read = () => {
      const sent = ++generation
      void bridge.services.status(tenantId, clientId).then(result => {
        if (active && sent === generation && result.tenantId.toLowerCase() === tenantId.toLowerCase()) setState({ tenantId, enabled: result.modules.find(module => module.id === "intune")?.enabled !== false })
      }).catch(error => { if (active && sent === generation) setState({ tenantId, error: error instanceof Error ? error.message : String(error) }) })
    }
    read()
    const unsubscribe = bridge.health.onChanged(changed => { if (changed.toLowerCase() === tenantId.toLowerCase()) read() })
    return () => { active = false; generation++; unsubscribe() }
  }, [tenantId, clientId, attempt])
  if (!tenantId) return children
  if (state?.tenantId !== tenantId) return <p role="status" className="p-6 text-sm text-gray-600">Checking this tenant's services...</p>
  if (state.error) return <NoticeCard className="m-6" tone="error" summary="Services could not be checked."
    details={state.error} action={<button className={noticeActionClass} type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>} />
  if (state.enabled) return children
  return <section className="mx-auto mt-8 max-w-2xl p-6" data-intune-required>
    <NoticeCard summary="This page needs Intune."
      details={`Intune is off for ${selectedTenant?.name}. Your other chosen services and existing backups stay available.`}
      action={<Link to={settingsHref("services")} className={noticeActionClass}>Turn on Intune in Settings</Link>} />
  </section>
}
