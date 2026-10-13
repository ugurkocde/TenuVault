import { useEffect, useState } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { ChevronDown, LoaderCircle, ShieldCheck } from "lucide-react"
import { effectiveFrameworks } from "../../shared/frameworks/cis-internal"
import { useFrameworkJobs } from "../lib/framework-jobs"
import { useInternalCisBenchmarks } from "../lib/internal-cis"

/**
 * Frameworks opens the catalog overview and lists every framework by name beneath it.
 * The chevron only folds the list away.
 */
export function FrameworkNavigation() {
  const catalog = effectiveFrameworks(useInternalCisBenchmarks())
  const { pathname } = useLocation()
  const active = pathname.startsWith("/portal/frameworks") || pathname.startsWith("/portal/baselines")
  const [open, setOpen] = useState(active)
  useEffect(() => { if (active) setOpen(true) }, [active])
  const running = new Map(useFrameworkJobs().filter(job => job.status === "running").map(job => [job.frameworkId, job]))
  const tone = active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
  return <div className="pt-2">
    <div className={`flex items-center rounded-full transition-colors ${tone}`}>
      <Link to="/portal/frameworks" aria-current={pathname === "/portal/frameworks" ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-full py-2.5 pl-4 text-sm font-medium">
        <ShieldCheck className="h-[18px] w-[18px] shrink-0" aria-hidden="true" /><span className="flex-1 text-left">Frameworks</span>
        {running.size > 0 && <LoaderCircle className="h-4 w-4 animate-spin" aria-label={`${running.size} comparison${running.size === 1 ? "" : "s"} running`} />}
      </Link>
      <button type="button" aria-expanded={open} aria-controls="framework-navigation" aria-label={open ? "Collapse framework list" : "Expand framework list"} onClick={() => setOpen(!open)} className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-full">
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
    </div>
    {open && <div id="framework-navigation" className="ml-6 mt-2 space-y-0.5 border-l border-gray-200 pl-2" aria-label="Framework list">
      <NavLink to="/portal/baselines" className={({ isActive }) => `block rounded-2xl px-3 py-2 text-sm font-medium leading-5 transition-colors ${isActive || pathname.startsWith("/portal/baselines/") ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>My baselines</NavLink>
      {[...catalog.filter(f => !f.disabledReason), ...catalog.filter(f => f.disabledReason)].map(f => f.disabledReason
        ? <span key={f.id} aria-disabled="true" title={f.disabledReason} className="block cursor-not-allowed rounded-2xl px-3 py-2 text-sm leading-5 text-muted-foreground opacity-70">{f.name}<span className="block text-xs">Coming soon</span></span>
        : <NavLink key={f.id} to={`/portal/frameworks/${f.id}`} className={({ isActive }) => `block rounded-2xl px-3 py-2 text-sm leading-5 transition-colors ${isActive ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
            {f.name}
            {running.has(f.id) && <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />Comparing · {running.get(f.id)!.percent}%</span>}
          </NavLink>)}
    </div>}
  </div>
}
