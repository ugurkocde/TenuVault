import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { ListChecks } from "lucide-react"
import { CIS_BENCHMARKS_ROUTE, isCisBenchmarksPath } from "../../shared/frameworks/cis-internal"
import { allows, upgradeMessage } from "../../shared/plans"
import { useInternalCisBenchmarks } from "../lib/internal-cis"
import { tenantLicense, tenantPlan, useLicense } from "../lib/license"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { UpgradeDialog } from "./PlanGate"
import { PlanBadge } from "./UpgradeNote"

/**
 * Top-level CIS Benchmarks entry. It renders only while the internal CIS flag is on,
 * so customer builds show nothing for CIS before certification. With the flag on, the
 * entry follows the plan of the currently selected tenant, the same tenant whose plan
 * the CIS page and the main process use: plans that include CIS Benchmarks (Pro or MSP)
 * get the normal link, other plans get a muted entry that explains the plan instead of
 * navigating. When no signed-in tenant is selected it falls back to the machine plan. Until the
 * plan is known, while the license status loads or before it lists the selected tenant,
 * the normal link shows, so the entry is there as soon as the flag is on and an entitled
 * tenant never flashes the upgrade state. The page and the main process check the plan.
 */
export function CisBenchmarksNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const enabled = useInternalCisBenchmarks()
  const { pathname } = useLocation()
  const { status } = useLicense()
  const { selectedTenant } = useSelectedTenant()
  const tenantId = selectedTenant?.credentials?.tenantId
  const license = tenantLicense(status, tenantId)
  const [explaining, setExplaining] = useState(false)
  if (!enabled) return null
  // A selected tenant that is not signed in has no license entry to wait for: the account plan applies.
  const unresolved = !status || (!!tenantId && !license)
  const plan = !status ? null : tenantId ? tenantPlan(license) : status.plan
  if (unresolved || (plan !== null && allows(plan, "baselineAllPlatforms"))) {
    const active = isCisBenchmarksPath(pathname)
    return (
      <Link to={CIS_BENCHMARKS_ROUTE} aria-current={active ? "page" : undefined} className={linkClass(active)}>
        <ListChecks className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="truncate">CIS Benchmarks</span>
      </Link>
    )
  }
  return (
    <>
      <button
        type="button"
        aria-disabled="true"
        title={upgradeMessage("baselineAllPlatforms")}
        className={cn(linkClass(false), "w-full cursor-not-allowed opacity-60")}
        onClick={() => setExplaining(true)}
      >
        <ListChecks className="h-[18px] w-[18px]" aria-hidden="true" />
        <span className="truncate">CIS Benchmarks</span>
        <PlanBadge feature="baselineAllPlatforms" className="ml-auto" />
      </button>
      <UpgradeDialog feature="baselineAllPlatforms" open={explaining} onOpenChange={setExplaining} />
    </>
  )
}
