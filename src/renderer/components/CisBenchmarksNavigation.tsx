import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { ListChecks } from "lucide-react"
import { CIS_BENCHMARKS_ROUTE, isCisBenchmarksPath } from "../../shared/frameworks/cis-internal"
import { allows, upgradeMessage, type Plan } from "../../shared/plans"
import { useInternalCisBenchmarks } from "../lib/internal-cis"
import { useLicense } from "../lib/license"
import { cn } from "~/lib/utils"
import { UpgradeDialog } from "./PlanGate"
import { PlanBadge } from "./UpgradeNote"

/** The best plan covering this machine: its key plan, or the best entitled tenant plan. */
function bestPlan(status: ReturnType<typeof useLicense>["status"]): Plan | null {
  if (!status) return null
  if (status.plan) return status.plan
  const tenantPlans = status.tenants.filter((tenant) => tenant.entitled && tenant.plan).map((tenant) => tenant.plan)
  if (tenantPlans.includes("msp")) return "msp"
  if (tenantPlans.includes("pro")) return "pro"
  return null
}

/**
 * Top-level CIS Benchmarks entry. It renders only while the internal CIS flag is on,
 * so customer builds show nothing for CIS before certification. With the flag on, the
 * entry follows the license plan: plans that include CIS Benchmarks (Pro or MSP) get
 * the normal link, other plans get a muted entry that explains the plan instead of
 * navigating. While the license status is loading nothing renders, matching the
 * license badge and banner, which also render nothing until the status is known.
 */
export function CisBenchmarksNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const enabled = useInternalCisBenchmarks()
  const { pathname } = useLocation()
  const { status } = useLicense()
  const [explaining, setExplaining] = useState(false)
  if (!enabled) return null
  if (!status) return null
  const plan = bestPlan(status)
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
