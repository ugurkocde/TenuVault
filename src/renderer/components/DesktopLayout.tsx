import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  GitPullRequest,
  ArrowRight,
  Building2,
  ChevronDown,
  Database,
  GitCompare,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  LifeBuoy,
  Settings,
  Shield,
  Sparkles,
} from "lucide-react"
import { FloatingProgress } from "~/components/backup/floating-progress"
import { useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { BrandMark } from "./BrandMark"
import { ErrorBoundary } from "./ErrorBoundary"
import { communityBannerVisible, earliestExpiringTenant, formatDate, formatDateTime, isUnlicensed, licenseChipState, licenseExpiryWarning, offlineDeadline, unlicensedTenants, useLicense } from "../lib/license"
import { toast, Toaster } from "../lib/toast"
import { bridge } from "../lib/bridge"
import { FrameworkJobNotifier } from "../lib/framework-jobs"
import { CisJobNotifier } from "../lib/cis-jobs"
import { BackgroundTasksPanel } from "./BackgroundTasksPanel"
import { useScoreInvalidation } from "../features/scores/invalidate"
import { DriftScanIndicator, DriftScanNotifier } from "../lib/drift-jobs"
import { SignInBanner } from "./SignInBanner"
import { SupportDialog } from "./SupportDialog"
import { TenantSwitcher } from "./TenantSwitcher"
import { UpdateSidebarLabel } from "./UpdateSidebarLabel"
import { WhatsNewAnnouncement, WhatsNewDialog } from "./WhatsNewDialog"
import { useWhatsNew } from "../lib/whats-new"
import { TenantAccessNotice } from "./TenantAccessNotice"
import { CisBenchmarksNavigation } from "./CisBenchmarksNavigation"
import { FrameworkNavigation } from "./FrameworkNavigation"
import { OibJobIndicator } from "./oib/JobIndicator"

interface NavItem {
  name: string
  href?: string
  icon?: ComponentType<{ className?: string }>
  children?: NavItem[]
}

const allNavigation: NavItem[] = [
  { name: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
  { name: "Tenants", href: "/portal/tenants", icon: Building2 },
  { name: "Backup & Restore", href: "/portal/backup", icon: Database },
  { name: "Drift Detection", href: "/portal/drift", icon: GitCompare },
  { name: "OpenIntuneBaseline", href: "/portal/oib", icon: Layers },
  { name: "Audit Log", href: "/portal/audit", icon: Shield },
  { name: "Governance", href: "/portal/governance", icon: ClipboardCheck },
  { name: "Changes", href: "/portal/changes", icon: GitPullRequest },
  { name: "Operations", href: "/portal/operations", icon: Activity },
]

/** A calm pill inside the content padding: tinted surface, round icon, round arrow action. */
function BannerLink({ tone, icon, children, onDismiss, dismissing }: { tone: "coral" | "amber" | "neutral"; icon: ReactNode; children: ReactNode; onDismiss?: () => void; dismissing?: boolean }) {
  return (
    <div className="px-6 pt-5 lg:px-8">
      <div className={cn("flex items-center rounded-3xl", tone === "neutral" && "bg-gray-100 text-gray-700")}>
        <Link
          to="/license"
          className={cn(
            "group flex min-w-0 flex-1 items-center gap-3 rounded-3xl py-2 pl-2 pr-2 text-sm font-medium transition-shadow hover:shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
            tone === "neutral" ? "bg-gray-100 text-gray-700" : tone === "coral" ? "bg-blue-50 text-gray-900" : "bg-amber-50 text-amber-900",
          )}
        >
          <span
            className={cn(
              "flex size-9 flex-shrink-0 items-center justify-center rounded-full",
              tone === "neutral" ? "bg-white text-gray-600" : tone === "coral" ? "bg-coral-500 text-white" : "bg-card text-amber-700",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1">{children}</span>
          <span
            className={cn("flex size-9 flex-shrink-0 items-center justify-center rounded-full transition-transform motion-safe:group-hover:translate-x-0.5", tone === "neutral" ? "bg-white text-gray-600" : "bg-primary text-primary-foreground")}
            aria-hidden="true"
          >
            <ArrowRight className="h-4 w-4" />
          </span>
        </Link>
        {onDismiss && <button type="button" onClick={onDismiss} disabled={dismissing} className="mr-2 shrink-0 rounded-full px-3 py-2 text-sm font-medium hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Dismiss</button>}
      </div>
    </div>
  )
}

function LicenseBanner() {
  const { status } = useLicense()
  const { pathname } = useLocation()
  const [dismissedAt, setDismissedAt] = useState<string>()
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.preferences.get().then((preferences) => {
      if (active) setDismissedAt(preferences.communityBannerDismissedAt)
    }).catch((error: unknown) => {
      if (active) toast(error instanceof Error ? error.message : "Could not load preferences.", "error")
    }).finally(() => {
      if (active) setPreferencesLoaded(true)
    })
    return () => { active = false }
  }, [])
  const dismiss = async () => {
    setDismissing(true)
    try {
      const preferences = await bridge.preferences.set({ communityBannerDismissedAt: new Date().toISOString() })
      setDismissedAt(preferences.communityBannerDismissedAt)
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not dismiss the Community notice.", "error")
    } finally {
      setDismissing(false)
    }
  }
  if (!status) return null
  if (isUnlicensed(status) && unlicensedTenants(status).length === 0) {
    // The start pages only: the all-tenants overview, or the dashboard for a single tenant.
    const startPage = pathname === "/portal/overview" || pathname === "/portal/dashboard"
    if (!startPage || !preferencesLoaded || !communityBannerVisible(dismissedAt)) return null
    return (
      <BannerLink tone="neutral" icon={<Sparkles className="h-4 w-4" />} onDismiss={() => void dismiss()} dismissing={dismissing}>
        You are on Community, the free plan. Try Pro or MSP free for 30 days, or add your license key.
      </BannerLink>
    )
  }
  const inactive = unlicensedTenants(status)
  if (inactive.length > 0) {
    return (
      <BannerLink tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
        {inactive.length === 1 ? "A signed-in tenant is" : `${inactive.length} signed-in tenants are`} not covered by your
        license. Open License for details.
      </BannerLink>
    )
  }
  const keyExpiry = licenseExpiryWarning(status)
  // Offline, tokens run out: warn two days ahead so the admin can reconnect in time.
  // Whichever deadline comes first is shown when both apply.
  const offline = offlineDeadline(status)
  if (offline && (!keyExpiry || !status.validUntil || Date.parse(offline) < Date.parse(status.validUntil))) {
    return (
      <BannerLink tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
        TenuVault could not reach the licensing service. Connect to the internet before{" "}
        {formatDateTime(offline)} to keep using your tenants.
      </BannerLink>
    )
  }
  if (keyExpiry && status.validUntil) {
    const owner = earliestExpiringTenant(status)?.source === "tenant" ? "The license shared by your organization" : "Your license key"
    return (
      <BannerLink tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
        {owner} {keyExpiry === "expired" ? "expired on" : "expires on"} {formatDate(status.validUntil)}. {status.plan === "msp" ? "MSP" : "Pro"} features stop unless it is renewed.
      </BannerLink>
    )
  }
  return null
}

/** Sidebar entry for the release notes, with a dot while an installed build is unseen. */
function WhatsNewNav({ linkClass }: { linkClass: (active: boolean) => string }) {
  const { state } = useWhatsNew()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn(linkClass(false), "w-full")}>
        <Sparkles className="h-[18px] w-[18px]" />
        What&apos;s new
        {state?.hasUnseen && <span aria-label="New changes since you last looked" className="ml-auto size-2 rounded-full bg-blue-600" />}
      </button>
      <WhatsNewDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function LicenseNavBadge() {
  const { status } = useLicense()
  if (!status) return null
  const chip = "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium leading-4"
  const state = licenseChipState(status)
  return <span className={cn(chip, state.tone === "inactive" ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-700")}>{state.label}</span>
}

export function DesktopLayout() {
  const { pathname } = useLocation()
  const tenants = useTenants()
  useScoreInvalidation()
  // MSPs with several tenants get the all-tenants overview at the top.
  const navigation =
    tenants.length > 1 ? [{ name: "All tenants", href: "/portal/overview", icon: LayoutGrid }, ...allNavigation] : allNavigation
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [supportOpen, setSupportOpen] = useState(false)

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const linkClass = (active: boolean, nested = false) =>
    cn(
      // 40px rows instead of the 44px touch minimum, so every entry fits a 900px tall window.
      "flex min-h-10 items-center gap-3 rounded-full px-4 py-2.5 text-sm font-medium transition-colors",
      active
        ? "bg-primary text-primary-foreground"
        : nested
          ? "text-muted-foreground hover:bg-secondary hover:text-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
    )

  const renderItem = (item: NavItem, depth = 0) => {
    const active = item.href
      ? pathname.startsWith(item.href)
      : Boolean(item.children?.some((child) => child.href && pathname.startsWith(child.href)))

    if (item.children) {
      const open = expanded.has(item.name)
      return (
        <div key={item.name}>
          <button type="button" onClick={() => toggle(item.name)} className={cn(linkClass(active), "w-full")}>
            {item.icon && <item.icon className="h-[18px] w-[18px]" />}
            <span className="flex-1 text-left">{item.name}</span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
          </button>
          {open && <div className="mt-1 space-y-1">{item.children.map((child) => renderItem(child, depth + 1))}</div>}
        </div>
      )
    }

    return (
      <Link key={item.name} to={item.href!} className={cn(linkClass(active, depth > 0), depth > 0 && "ml-4")}>
        {item.icon ? (
          <item.icon className="h-[18px] w-[18px]" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center">
            <span className={cn("h-2 w-2 rounded-full", active ? "bg-coral-500" : "bg-gray-400")} />
          </span>
        )}
        <span className="truncate">{item.name}</span>
        {item.href === "/portal/drift" && <DriftScanIndicator />}
      </Link>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Floating white panel on the warm canvas, 12px from the window edge; the content column starts at 16rem. */}
      <aside className="fixed bottom-3 left-3 top-3 z-40 flex w-[15.25rem] flex-col rounded-3xl bg-card shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <BrandMark className="size-10" />
          <div className="leading-tight">
            <div className="text-lg font-semibold tracking-tight text-foreground">TenuVault</div>
            <div className="text-xs text-muted-foreground">Desktop</div>
          </div>
        </div>

        <div className="px-3 pb-2">
          <TenantSwitcher />
        </div>

        {/* min-h-0 lets the list shrink and scroll inside the panel instead of pushing past it. */}
        <nav aria-label="Main navigation" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-3 py-2">{navigation.map((item) => renderItem(item))}<CisBenchmarksNavigation linkClass={(active) => linkClass(active)} /><FrameworkNavigation /></nav>

        <OibJobIndicator />
        <div className="space-y-1 p-3">
          <UpdateSidebarLabel />
          <WhatsNewNav linkClass={linkClass} />
          <Link to="/portal/settings" className={linkClass(pathname.startsWith("/portal/settings"))}>
            <Settings className="h-[18px] w-[18px]" />
            Settings
          </Link>
          <Link to="/license" className={linkClass(pathname.startsWith("/license"))}>
            <KeyRound className="h-[18px] w-[18px]" />
            License
            <LicenseNavBadge />
          </Link>
          <button type="button" onClick={() => setSupportOpen(true)} className={cn(linkClass(false), "w-full")}>
            <LifeBuoy className="h-[18px] w-[18px]" />
            Support
          </button>
        </div>
      </aside>

      <div className="pl-64">
        <LicenseBanner />
        <SignInBanner />
        {[/portal\/backup/, /portal\/drift/, /portal\/audit/, /portal\/(governance|changes|operations)/].some(pattern => pattern.test(pathname)) && <TenantAccessNotice />}
        {/* Room to scroll the end of a page clear of the floating backup and activity panels while they show. */}
        <main className="pb-[calc(var(--floating-progress-offset,0px)+var(--background-tasks-offset,0px))]">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <FloatingProgress />
      <BackgroundTasksPanel />
      <Toaster />
      <FrameworkJobNotifier />
      <CisJobNotifier />
      <DriftScanNotifier />
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
      <WhatsNewAnnouncement />
    </div>
  )
}
