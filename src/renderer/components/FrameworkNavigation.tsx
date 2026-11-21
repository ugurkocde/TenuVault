import { useEffect, useState } from "react"
import { Link, NavLink, useLocation, useMatch } from "react-router-dom"
import { ChevronDown, LoaderCircle, ShieldCheck } from "lucide-react"
import { isCisBenchmarksPath, navigationFrameworks } from "../../shared/frameworks/cis-internal"
import { useFrameworkJobs } from "../lib/framework-jobs"
import { NavPlanBadge } from "./NavPlanBadge"
import { Fold } from "./SidebarNavigation"

/**
 * Frameworks opens the catalog overview and lists every framework by name beneath it.
 * The chevron only folds the list away.
 */
export function FrameworkNavigation() {
  const catalog = navigationFrameworks()
  const { pathname } = useLocation()
  const active = !isCisBenchmarksPath(pathname) && (pathname.startsWith("/portal/frameworks") || pathname.startsWith("/portal/baselines"))
  const [open, setOpen] = useState(active)
  useEffect(() => { if (active) setOpen(true) }, [active])
  const running = new Map(useFrameworkJobs().filter(job => job.status === "running").map(job => [job.frameworkId, job]))
  // One filled entry at a time, like the rest of the sidebar: the catalog itself, or the framework beneath it.
  // An exact route match, so /portal/frameworks/ counts as the catalog too.
  const overview = useMatch({ path: "/portal/frameworks", end: true }) !== null
  const tone = overview ? "bg-primary text-primary-foreground" : active ? "text-foreground hover:bg-secondary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
  const entry = (selected: boolean) => `flex min-h-8 flex-col justify-center rounded-full px-3 py-1.5 text-sm font-medium leading-5 ${selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`
  return <div>
    <div data-nav-row="" className={`flex items-center rounded-full ${tone}`}>
      <Link to="/portal/frameworks" aria-current={overview ? "page" : undefined} className="flex min-h-8 min-w-0 flex-1 items-center gap-3 rounded-full py-1.5 pl-4 text-sm font-medium">
        <ShieldCheck className="h-[18px] w-[18px] shrink-0" aria-hidden="true" /><span className="flex-1 text-left">Frameworks</span>
        {/* The open page is inside the folded list: mark it the way a folded sidebar group is marked. */}
        {!open && active && !overview && <><span aria-hidden="true" className="size-1.5 rounded-full bg-coral-500" /><span className="sr-only">, holds the open page</span></>}
        {running.size > 0 && <LoaderCircle className="h-4 w-4 animate-spin" aria-label={`${running.size} comparison${running.size === 1 ? "" : "s"} running`} />}
      </Link>
      <button type="button" aria-expanded={open} aria-controls="framework-navigation" aria-label={open ? "Collapse framework list" : "Expand framework list"} onClick={() => setOpen(!open)} className="mr-1 flex size-7 min-h-7 shrink-0 items-center justify-center rounded-full">
        <ChevronDown className={`h-4 w-4 motion-safe:transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
    </div>
    <Fold id="framework-navigation" open={open}><div className="ml-6 mt-1 space-y-0.5 border-l border-gray-200 pl-2" aria-label="Framework list">
      <NavLink to="/portal/baselines" data-nav-row="" className={({ isActive }) => entry(isActive || pathname.startsWith("/portal/baselines/"))}><span className="flex items-center gap-2">My baselines<NavPlanBadge features={["customBaselines"]} /></span></NavLink>
      {[...catalog.filter(f => !f.disabledReason), ...catalog.filter(f => f.disabledReason)].map(f => f.disabledReason
        ? <span key={f.id} aria-disabled="true" data-nav-row="" title={f.disabledReason} className="flex min-h-8 cursor-not-allowed flex-col justify-center rounded-full px-3 py-1.5 text-sm font-medium leading-5 text-muted-foreground opacity-70">{f.name}<span className="block text-xs font-normal">Coming soon</span></span>
        : <NavLink key={f.id} to={`/portal/frameworks/${f.id}`} data-nav-row="" className={({ isActive }) => entry(isActive)}>
            {({ isActive }) => <>
              {f.name}
              {running.has(f.id) && <span className={`mt-0.5 flex items-center gap-1.5 text-xs font-normal ${isActive ? "text-primary-foreground/80" : "text-muted-foreground"}`}><LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />Comparing · {running.get(f.id)!.percent}%</span>}
            </>}
          </NavLink>)}
    </div></Fold>
  </div>
}
