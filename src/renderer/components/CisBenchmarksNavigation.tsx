import { Link, useLocation } from "react-router-dom"
import { ListChecks } from "lucide-react"
import { CIS_BENCHMARKS_ROUTE, isCisBenchmarksPath } from "../../shared/frameworks/cis-internal"
import { allows } from "../../shared/plans"
import { tenantLicense, tenantPlan, useLicense } from "../lib/license"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { PlanBadge } from "./UpgradeNote"

/**
 * Top-level CIS Benchmarks entry. It always opens the CIS page; the page shows a plan without CIS
 * Benchmarks what Pro and MSP add. It follows the plan of the currently selected tenant, the same
 * tenant whose plan the CIS page and the main process use: plans that do not include CIS
 * Benchmarks (Pro or MSP) see the plan badge next to the entry. When no signed-in tenant is
 * selected it falls back to the machine plan. Until the plan is known, while the license status
 * loads or before it lists the selected tenant, no badge shows, so an entitled tenant never
 * flashes it. The page and the main process check the plan.
 */
export function CisBenchmarksNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const { pathname } = useLocation()
  const { status } = useLicense()
  const { selectedTenant } = useSelectedTenant()
  const tenantId = selectedTenant?.credentials?.tenantId
  const license = tenantLicense(status, tenantId)
  // A selected tenant that is not signed in has no license entry to wait for: the account plan applies.
  const unresolved = !status || (!!tenantId && !license)
  const plan = !status ? null : tenantId ? tenantPlan(license) : status.plan
  const badge = !unresolved && (plan === null || !allows(plan, "baselineAllPlatforms"))
  const active = isCisBenchmarksPath(pathname)
  return (
    <Link to={CIS_BENCHMARKS_ROUTE} aria-current={active ? "page" : undefined} className={linkClass(active)}>
      <ListChecks className="h-[18px] w-[18px]" aria-hidden="true" />
      <span className="truncate">CIS Benchmarks</span>
      {badge && <PlanBadge feature="baselineAllPlatforms" className="ml-auto" />}
    </Link>
  )
}
