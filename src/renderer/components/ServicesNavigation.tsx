import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { Fingerprint, Monitor } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import type { ServicesStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { BACKUP_SERVICES, parseBackupService } from "../lib/backup-service"
import { settingsHref } from "../lib/settings-section"

const ICONS = { intune: Monitor, entra: Fingerprint }

export function ServicesNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const { selectedTenant } = useSelectedTenant()
  const tenantId = selectedTenant?.credentials?.tenantId
  const clientId = selectedTenant?.credentials?.appId
  const [state, setState] = useState<{ tenantId: string; clientId: string; status: ServicesStatus } | null>(null)
  const { pathname, search } = useLocation()
  const filter = parseBackupService(new URLSearchParams(search).get("service"))
  useEffect(() => {
    setState(null)
    if (!tenantId || !clientId || !bridge.services?.status) return
    let active = true
    let generation = 0
    const read = () => {
      const sent = ++generation
      void bridge.services.status(tenantId, clientId).then(status => {
        if (active && sent === generation && status.tenantId.toLowerCase() === tenantId.toLowerCase()) setState({ tenantId, clientId, status })
      }).catch(() => { if (active && sent === generation) setState(null) })
    }
    read()
    const unsubscribe = bridge.health?.onChanged?.(changed => { if (changed.toLowerCase() === tenantId.toLowerCase()) read() })
    return () => { active = false; generation++; unsubscribe?.() }
  }, [tenantId, clientId])
  const status = state && state.tenantId === tenantId && state.clientId === clientId ? state.status : null
  return <section aria-label="Services" className="py-2">
    <h2 className="px-4 pb-1 text-xs font-medium text-muted-foreground">Services</h2>
    <div className="space-y-0.5">
      {BACKUP_SERVICES.map(service => {
        const enabled = service.id === "entra" && status?.modules.some(module => module.id === "conditionalAccess" && module.enabled)
          ? true
          : status?.modules.find(module => module.id === service.id)?.enabled
        const off = enabled === false
        const needsAccess = enabled === true && status?.needsAccess?.includes(service.id)
        const active = !needsAccess && enabled === true && pathname === "/portal/backup" && filter === service.id
        const Icon = ICONS[service.id]
        return <Link key={service.id} to={needsAccess || off ? `${settingsHref("services")}&tenant=${encodeURIComponent(tenantId!)}#service-${service.id}` : `/portal/backup?service=${service.id}`} aria-current={active ? "page" : undefined} data-nav-row="" title={off || needsAccess ? `Open ${service.label} in Services and permissions` : `View ${service.label} backup contents`} className={cn(linkClass(active), "gap-2")}>
          <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <span className="shrink-0 whitespace-nowrap">{service.label}</span>
          {(off || needsAccess) && <span className="ml-auto inline-flex shrink-0 items-center rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-medium leading-4 text-gray-700">{needsAccess ? "Needs access" : "Off"}</span>}
        </Link>
      })}
    </div>
  </section>
}
