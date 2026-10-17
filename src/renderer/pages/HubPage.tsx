import { Suspense, useEffect } from "react"
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { HUBS } from "../features/hubs"
import { canUse, LockedPreview } from "../components/PlanGate"
import { PlanBadge } from "../components/UpgradeNote"
import { useLicense, useTenantPlan } from "../lib/license"

/**
 * One hub of roadmap workflows (Governance, Changes, Recovery, Operations) for the selected
 * tenant. Each tab is a screen; a tab the plan does not include shows its locked preview and,
 * below it, whatever that screen stored on an earlier plan.
 */
export default function HubPage({ hubId }: { hubId: string }) {
  const { tabId } = useParams()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const tenants = useTenants()
  // Links from background task notifications name the tenant the work ran for.
  const [params, setParams] = useSearchParams()
  const requestedTenant = params.get("tenant")?.toLowerCase()
  useEffect(() => {
    if (!requestedTenant || !tenants.length) return
    const match = tenants.find((tenant) => tenant.credentials?.tenantId.toLowerCase() === requestedTenant)
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
    setParams({}, { replace: true })
  }, [requestedTenant, tenants])
  const plan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  // Once the license status is known, a tenant without a usable plan (not signed in or not
  // covered) sees what each screen does instead of an empty page.
  const { status } = useLicense()
  const known = status !== null
  const hub = HUBS.find((candidate) => candidate.id === hubId)
  if (!hub) return <Navigate to="/portal/dashboard" replace />
  const tab = hub.tabs.find((candidate) => candidate.id === tabId) ?? hub.tabs[0]!
  const allowed = canUse(plan, tab.feature)

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-4xl font-light tracking-tight text-gray-900">{hub.title}</h1>
        <p className="mt-2 text-sm text-gray-600">
          {hub.description}
          {selectedTenant ? ` Tenant: ${selectedTenant.name}.` : ""}
        </p>
      </div>

      <nav aria-label={`${hub.title} sections`} className="flex flex-wrap gap-2">
        {hub.tabs.map((candidate) => (
          <Link
            key={candidate.id}
            to={`/portal/${hub.id}/${candidate.id}`}
            aria-current={candidate.id === tab.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
              candidate.id === tab.id ? "bg-primary text-primary-foreground" : "bg-card text-gray-700 hover:bg-secondary",
            )}
          >
            {candidate.label}
            {known && !canUse(plan, candidate.feature) && <PlanBadge feature={candidate.feature} />}
          </Link>
        ))}
      </nav>

      {!selectedTenant ? (
        <p className="rounded-3xl bg-card p-6 text-sm text-gray-600">Connect or select a tenant to use {hub.title.toLowerCase()}.</p>
      ) : (
        <>
          {known && !allowed && <LockedPreview feature={tab.feature} summary={tab.summary} points={tab.points} />}
          <Suspense fallback={<div className="h-24 animate-pulse rounded-3xl bg-card" />}>
            <tab.Component key={`${tab.id}:${selectedTenant.id}`} tenant={selectedTenant} plan={plan} allowed={allowed} />
          </Suspense>
        </>
      )}
    </div>
  )
}
