import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { ListChecks } from "lucide-react"
import { CIS_BENCHMARKS_ROUTE, isCisBenchmarksPath } from "../../shared/frameworks/cis-internal"
import { allows, upgradeMessage } from "../../shared/plans"
import { useInternalCisBenchmarks } from "../lib/internal-cis"
import { useLicense, useTenantPlan } from "../lib/license"
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
 * navigating. When no tenant is selected it falls back to the machine plan. While the
 * license status is loading nothing renders, matching the license badge and banner,
 * which also render nothing until the status is known.
 */
export function CisBenchmarksNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const enabled = useInternalCisBenchmarks()
  const { pathname } = useLocation()
  const { status } = useLicense()
  const { selectedTenant } = useSelectedTenant()
  const tenantPlan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  const [explaining, setExplaining] = useState(false)
  if (!enabled) return null
  if (!status) return null
  const plan = selectedTenant ? tenantPlan : status.plan
  if (plan !== null && allows(plan, "baselineAllPlatforms")) {
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
        className={cn(linkClass(false), "w-full cursor-pointer opacity-70")}
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
