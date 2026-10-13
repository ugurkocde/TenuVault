import { Link, useLocation } from "react-router-dom"
import { ListChecks } from "lucide-react"
import { CIS_BENCHMARKS_ROUTE, isCisBenchmarksPath } from "../../shared/frameworks/cis-internal"
import { useInternalCisBenchmarks } from "../lib/internal-cis"

/**
 * Top-level CIS Benchmarks entry. It renders only while the internal CIS flag is on,
 * so customer builds show nothing for CIS before certification.
 */
export function CisBenchmarksNavigation({ linkClass }: { linkClass: (active: boolean) => string }) {
  const enabled = useInternalCisBenchmarks()
  const { pathname } = useLocation()
  if (!enabled) return null
  const active = isCisBenchmarksPath(pathname)
  return (
    <Link to={CIS_BENCHMARKS_ROUTE} aria-current={active ? "page" : undefined} className={linkClass(active)}>
      <ListChecks className="h-[18px] w-[18px]" aria-hidden="true" />
      <span className="truncate">CIS Benchmarks</span>
    </Link>
  )
}
