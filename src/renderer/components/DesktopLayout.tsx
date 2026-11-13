import { Package } from "lucide-react"
import { trialEndWhen, organizationLicenseRefusal } from "../../shared/trial-notices"
import { Button } from "~/components/ui/button"
import { openCheckout } from "../lib/purchase"
import { TenantTrialNotices, TrialActions, TrialUsage, TrialChanges, trialEndVisible } from "./TenantTrial"
import { CommunityChoiceBanner } from "./CommunityTenantPicker"
import { isAppBackupPath, desktopRouteBoundaryKey } from "../lib/app-backup-route"
import { useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  GitPullRequest,
  ArrowRight,
  Building2,
  ChevronDown,
  Clock,
  Database,
  ExternalLink,
  FileText,
  GitCompare,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  LifeBuoy,
  MessageSquareHeart,
  RefreshCw,
  Settings,
  Shield,
  Siren,
  Sparkles,
} from "lucide-react"
import { FloatingProgress } from "~/components/backup/floating-progress"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { BrandMark } from "./BrandMark"
import { ErrorBoundary } from "./ErrorBoundary"
import { communityBannerVisible, earliestExpiringTenant, formatDate, formatDateTime, hasPaidLicense, inactiveTenantNotice, isUnlicensed, licenseChipState, licenseExpiryWarning, offlineDeadline, statusForTenant, trialEndedNotice, trialReminder, unlicensedTenants, useLicense } from "../lib/license"
import { PlanPromptButton } from "./PlanPromptButton"
import { trialOfferEligible, useTrialOfferHidden } from "../lib/trial-offer"
import { PurchaseKeyWatcher } from "./PurchaseKeyWatcher"
import { toast, Toaster } from "../lib/toast"
import { bridge } from "../lib/bridge"
import { FrameworkJobNotifier } from "../lib/framework-jobs"
import { CisJobNotifier } from "../lib/cis-jobs"
import { BackgroundTasksPanel } from "./BackgroundTasksPanel"
import { useScoreInvalidation } from "../features/scores/invalidate"
import { DriftScanIndicator, DriftScanNotifier } from "../lib/drift-jobs"
import { SignInBanner } from "./SignInBanner"
import { SupportDialog } from "./SupportDialog"
import { FeedbackProvider, useOpenFeedback } from "./FeedbackProvider"
import { TenantSwitcher } from "./TenantSwitcher"
import { UpdateSidebarLabel } from "./UpdateSidebarLabel"
import { WhatsNewAnnouncement, WhatsNewDialog } from "./WhatsNewDialog"
import { useWhatsNew } from "../lib/whats-new"
import { TenantAccessNotice } from "./TenantAccessNotice"
import { CisBenchmarksNavigation } from "./CisBenchmarksNavigation"
import { NAV_PLAN_FEATURES, NavPlanBadge } from "./NavPlanBadge"
import { FrameworkNavigation } from "./FrameworkNavigation"
import { OibJobIndicator } from "./oib/JobIndicator"

interface NavItem {
  name: string
  href?: string
  /** One-line job of the screen, shown as the link title where names alone blur together. */
  hint?: string
  icon?: ComponentType<{ className?: string }>
  children?: NavItem[]
}

const allNavigation: NavItem[] = [
  { name: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
  { name: "Tenants", href: "/portal/tenants", icon: Building2 },
  { name: "Backup & Restore", href: "/portal/backup", icon: Database },
  { name: "App Backup", href: "/portal/app-backup", icon: Package, hint: "Keep original Win32 installers in an encrypted source store" },
  { name: "Drift Detection", href: "/portal/drift", icon: GitCompare },
  { name: "Sync", href: "/portal/sync", icon: RefreshCw, hint: "Copy settings from one tenant to others" },
  { name: "Alerts", href: "/portal/alerts", icon: Siren, hint: "Teams, email and webhook alerts for backups and policy changes" },
  { name: "OpenIntuneBaseline", href: "/portal/oib", icon: Layers },
  { name: "Reports", href: "/portal/reports", icon: FileText, hint: "What changed, setting by setting, and who changed it" },
  { name: "Audit Log", href: "/portal/audit", icon: Shield, hint: "What TenuVault did, when, and did it work" },
  { name: "Governance", href: "/portal/governance", icon: ClipboardCheck, hint: "Posture, accepted deviations and standards" },
  { name: "Changes", href: "/portal/changes", icon: GitPullRequest, hint: "Reviewed and approved tenant writes" },
  { name: "Operations", href: "/portal/operations", icon: Activity },
]

/** A calm pill inside the content padding: tinted surface, round icon, round arrow action. */
function BannerLink({ tone, icon, children, action, onDismiss, dismissing }: { tone: "coral" | "amber" | "neutral"; icon: ReactNode; children: ReactNode; action?: ReactNode; onDismiss?: () => void; dismissing?: boolean }) {
  return (
    <div className="px-6 pt-5 lg:px-8">
      <div className={cn("flex items-center gap-2 rounded-3xl", action && "flex-wrap", tone === "neutral" ? "bg-gray-100 text-gray-700" : tone === "amber" ? "bg-amber-50" : "bg-blue-50")}>
        <Link
          to="/license"
          className={cn(
            "group flex min-w-0 flex-1 items-center gap-3 rounded-3xl py-2 pl-2 pr-2 text-sm font-medium transition-shadow hover:shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
            action && "basis-72",
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
        {action && <span className={cn("min-w-0 max-w-full", !onDismiss && "mr-2")}>{action}</span>}
        {onDismiss && <button type="button" onClick={onDismiss} disabled={dismissing} className="mr-2 shrink-0 rounded-full px-3 py-2 text-sm font-medium hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Dismiss</button>}
      </div>
    </div>
  )
}

/** A trial notice: what it says, Buy Pro, Details and Dismiss. */
function TrialBanner({ urgent, source, onDismiss, dismissing, children, endsAt, tenantId }: {
  tenantId?: string
  endsAt?: string
  urgent: boolean
  source: string
  onDismiss: () => void
  dismissing: boolean
  children: ReactNode
}) {
  const { status } = useLicense()
  const tenant = status?.tenants.find(t => (!tenantId || t.tenantId === tenantId) && t.trialEndsAt === endsAt && (t.source === "trial" || !t.entitled))
  return (
    <div className="px-6 pt-5 lg:px-8">
      <div role="status" className={cn("flex flex-wrap items-start gap-3 rounded-3xl p-3 text-sm font-medium", urgent ? "bg-amber-50 text-amber-900" : "bg-blue-50 text-gray-900")}>
        <span className={cn("flex size-9 flex-shrink-0 items-center justify-center rounded-full", urgent ? "bg-card text-amber-700" : "bg-coral-500 text-white")} aria-hidden="true">
          <Clock className="h-4 w-4" />
        </span>
        <div className="min-w-0 basis-full sm:basis-72 flex-1">{children}</div>
        {status?.tenantTrialsEnabled ? <div className="min-w-0 basis-full"><TrialActions key={tenant?.tenantId ?? source} tenant={tenant} source={source} /></div> : <Button className="bg-coral-500 text-white hover:bg-coral-600" type="button" size="sm" onClick={() => void openCheckout(source)}>
          <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />Buy Pro
        </Button>}
        <Link to="/license" className="rounded-full px-3 py-2 text-sm font-medium hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          Details
        </Link>
        <button type="button" onClick={onDismiss} disabled={dismissing} className="shrink-0 rounded-full px-3 py-2 text-sm font-medium hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">Dismiss</button>
      </div>
    </div>
  )
}

/** Day 20 and day 27 of the no-card trial: when it ends, and the checkout that keeps Pro. */
export function TrialReminderBanner({ reminder, onDismiss, dismissing }: {
  reminder: NonNullable<ReturnType<typeof trialReminder>>
  onDismiss: () => void
  dismissing: boolean
}) {
  const { status } = useLicense()
  const tenant = status?.tenants.find(t => t.source === "trial" && t.tenantId === reminder.tenantId)
  const final = reminder.stage === "day-27"
  const when = reminder.daysLeft === 1 ? trialEndWhen(Date.parse(reminder.endsAt)) : `in ${reminder.daysLeft} days`
  return (
    <TrialBanner tenantId={reminder.tenantId} endsAt={reminder.endsAt} urgent={final} source={`trial-${reminder.stage}`} onDismiss={onDismiss} dismissing={dismissing}>
      <p>Your Pro trial ends {when}{when.startsWith("on ") ? "" : `, on ${formatDate(reminder.endsAt)}`}.</p>
      {tenant && status?.tenantTrialsEnabled && <TrialUsage tenant={tenant} />}
      {reminder.tenantTrial ? <TrialChanges tenantId={tenant?.tenantId} /> : final
        ? "Buy Pro now to keep daily backups, full restore and drift revert for both tenants."
        : "Buy Pro to keep daily backups, full restore and drift revert after the trial."}
    </TrialBanner>
  )
}

/** After the no-card trial: what continues, and the checkout that brings Pro back. */
function TrialEndedBanner({ endedAt, onDismiss, dismissing }: {
  endedAt: string
  onDismiss: () => void
  dismissing: boolean
}) {
  return (
    <TrialBanner urgent source="trial-ended" onDismiss={onDismiss} dismissing={dismissing}>
      Your Pro trial ended on {formatDate(endedAt)}. TenuVault continues on Community for one tenant. Buy Pro to get daily
      backups, full restore and drift revert back for both tenants.
    </TrialBanner>
  )
}

function LicenseBanner() {
  const { status } = useLicense()
  const { pathname } = useLocation()
  const [dismissedAt, setDismissedAt] = useState<string>()
  const [trialDismissedAt, setTrialDismissedAt] = useState<string>()
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const tenants = useTenants()
  const { selectedTenant } = useSelectedTenant()
  const trialOfferHidden = useTrialOfferHidden()
  useEffect(() => {
    let active = true
    void bridge.preferences.get().then((preferences) => {
      if (!active) return
      setDismissedAt(preferences.communityBannerDismissedAt)
      setTrialDismissedAt(preferences.trialReminderDismissedAt)
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
  const dismissTrial = async () => {
    setDismissing(true)
    try {
      const preferences = await bridge.preferences.set({ trialReminderDismissedAt: new Date().toISOString() })
      setTrialDismissedAt(preferences.trialReminderDismissedAt)
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not dismiss the trial reminder.", "error")
    } finally {
      setDismissing(false)
    }
  }
  if (!status || (status.communityChoicePendingTenantIds?.length ?? 0) > 1) return null
  if (trialEndVisible(status) || status.tenants.some(t => t.entitled && t.source === "trial" && !t.trialAcknowledged)) return null
  if (isUnlicensed(status) && unlicensedTenants(status).length === 0) {
    // The start pages only: the all-tenants overview, or the dashboard for a single tenant.
    const startPage = pathname === "/portal/overview" || pathname === "/portal/dashboard"
    if (!startPage || !preferencesLoaded || !communityBannerVisible(dismissedAt)) return null
    // The dashboard's trial card makes the same offer for the tenant shown there, so the banner
    // waits for the dismissed tenants and stays away while the card is offered.
    if (pathname === "/portal/dashboard") {
      const shown = (selectedTenant ?? tenants[0])?.credentials?.tenantId ?? ""
      if (!trialOfferHidden || trialOfferEligible(status, shown, trialOfferHidden)) return null
    }
    return (
      <BannerLink tone="neutral" icon={<Sparkles className="h-4 w-4" />} onDismiss={() => void dismiss()} dismissing={dismissing}>
        {status.tenantTrialsEnabled && status.tenants.some(t => t.signedIn && !t.entitled && organizationLicenseRefusal(t))
          ? "You are on Community, the free plan. This tenant has an organization license that this sign-in cannot use. Open License to see how to use it."
          : <>You are on Community, the free plan. {status.tenantTrialsEnabled ? "Try Pro free with no card or email" : "Try Pro free for 30 days with no card"}, or add your license key.</>}
      </BannerLink>
    )
  }
  const inactive = unlicensedTenants(status)
  const tenantTrialHistory = status.tenants.some(t => t.trialEndsAt && (t.source === "trial" || !t.entitled))
  const ended = preferencesLoaded && !tenantTrialHistory ? trialEndedNotice(status, trialDismissedAt) : null
  if (ended) {
    return <TrialEndedBanner endedAt={ended.endedAt} onDismiss={() => void dismissTrial()} dismissing={dismissing} />
  }
  if (inactive.length > 0) {
    // Without a paid license, Pro is what covers the tenant: the trial, Buy Pro after it, or the plans.
    const buy = hasPaidLicense(status) ? undefined : <PlanPromptButton plan="pro" source="not-covered" tenantId={inactive.length === 1 ? inactive[0]!.tenantId : null} size="sm" />
    return (
      <BannerLink tone="amber" icon={<AlertTriangle className="h-4 w-4" />} action={buy}>
        {inactive.length === 1 ? "A signed-in tenant is" : `${inactive.length} signed-in tenants are`} not covered by your
        license. {inactiveTenantNotice(inactive)}
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
  // validUntil leaves out the trial key, so another license's expiry is shown next to
  // the trial reminder rather than hidden behind it.
  let expiry: ReactNode = null
  if (keyExpiry && status.validUntil) {
    const owner = earliestExpiringTenant(status)?.source === "tenant" ? "The license shared by your organization" : "Your license key"
    expiry = (
      <BannerLink tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
        {owner} {keyExpiry === "expired" ? "expired on" : "expires on"} {formatDate(status.validUntil)}. {status.plan === "msp" ? "MSP" : "Pro"} features stop unless it is renewed.
      </BannerLink>
    )
  }
  const reminder = preferencesLoaded ? trialReminder(status, trialDismissedAt) : null
  if (!reminder) return expiry
  return (
    <>
      <TrialReminderBanner reminder={reminder} onDismiss={() => void dismissTrial()} dismissing={dismissing} />
      {expiry}
    </>
  )
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
  const { selectedTenant } = useSelectedTenant()
  if (!status) return null
  const chip = "ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4"
  const state = licenseChipState(statusForTenant(status, selectedTenant?.credentials?.tenantId))
  if (state.tone === "trial") {
    const days = state.daysLeft ?? 0
    const full = `${state.label}, ${days} ${days === 1 ? "day" : "days"} left`
    return <span className={cn(chip, "bg-blue-50 text-blue-700")} title={full}>
      {state.label}
      <span aria-hidden className="tabular-nums opacity-70">{days}d</span>
      <span className="sr-only">, {days} {days === 1 ? "day" : "days"} left</span>
    </span>
  }
  return <span className={cn(chip, state.tone === "inactive" ? "bg-red-50 text-red-700" : "bg-secondary text-gray-700")}>{state.label}</span>
}

/**
 * Whether the element's content is taller than the element. Watches the element and its children, so
 * expanding a section of the sidebar updates it.
 */
function useOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    if (typeof ResizeObserver === "undefined") return measure()
    const resize = new ResizeObserver(measure)
    const watch = () => {
      resize.disconnect()
      resize.observe(element)
      for (const child of element.children) resize.observe(child)
      measure()
    }
    const children = new MutationObserver(watch)
    children.observe(element, { childList: true })
    watch()
    return () => {
      resize.disconnect()
      children.disconnect()
    }
  }, [ref])
  return overflowing
}

export function DesktopLayout() {
  const [supportOpen, setSupportOpen] = useState(false)
  return (
    <FeedbackProvider onOpenSupport={() => setSupportOpen(true)}>
      <DesktopLayoutContent onOpenSupport={() => setSupportOpen(true)} />
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} />
    </FeedbackProvider>
  )
}

function DesktopLayoutContent({ onOpenSupport }: { onOpenSupport: () => void }) {
  const { status: licenseStatus } = useLicense()
  const { pathname } = useLocation()
  const appBackupPage = isAppBackupPath(pathname)
  const tenants = useTenants()
  useScoreInvalidation()
  // MSPs with several tenants get the all-tenants overview at the top.
  const navigation =
    tenants.length > 1 ? [{ name: "All tenants", href: "/portal/overview", icon: LayoutGrid }, ...allNavigation] : allNavigation
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const openFeedback = useOpenFeedback()!
  const navRef = useRef<HTMLElement>(null)
  const navOverflowing = useOverflowing(navRef)

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
      <Link key={item.name} to={item.href!} title={item.hint} className={cn(linkClass(active, depth > 0), depth > 0 && "ml-4")}>
        {item.icon ? (
          <item.icon className="h-[18px] w-[18px]" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center">
            <span className={cn("h-2 w-2 rounded-full", active ? "bg-coral-500" : "bg-gray-400")} />
          </span>
        )}
        <span className="truncate">{item.name}</span>
        {item.href === "/portal/drift" && <DriftScanIndicator />}
        {NAV_PLAN_FEATURES[item.href!] && <NavPlanBadge features={NAV_PLAN_FEATURES[item.href!]!} className="ml-auto" />}
      </Link>
    )
  }

  // Until a tenant is connected the guided setup is the only job, so it gets the window to itself.
  // The page keeps its place in the tree either way, so connecting the first tenant during the
  // setup only brings in the sidebar and never remounts the setup.
  const focus = tenants.length === 0 && pathname === "/portal/onboarding"
  const quiet = "rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"

  return (
    <div className="min-h-screen bg-background">
      {/* Floating white panel on the warm canvas, 12px from the window edge; the content column starts at 16rem. */}
      {focus ? (
        <header className="flex items-center justify-between gap-4 px-6 pt-5 lg:px-8">
          <div className="flex items-center gap-3">
            <BrandMark className="size-9" />
            <div className="leading-tight">
              <div className="text-base font-semibold tracking-tight text-foreground">TenuVault</div>
              <div className="text-xs text-muted-foreground">Desktop</div>
            </div>
          </div>
          <nav aria-label="Help" className="flex items-center gap-1">
            <Link to="/license" className={quiet}>License</Link>
            <button type="button" onClick={() => void openFeedback()} className={quiet}>Share feedback</button>
            <button type="button" onClick={() => onOpenSupport()} className={quiet}>Support</button>
          </nav>
        </header>
      ) : (
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

        {/* min-h-0 lets the list shrink and scroll inside the panel instead of pushing past it. Only while it
            scrolls does it keep the wheel to itself; otherwise the wheel over the sidebar scrolls the page. */}
        <nav ref={navRef} aria-label="Main navigation" className={cn("min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2", navOverflowing && "overscroll-contain")}>{navigation.map((item) => renderItem(item))}<CisBenchmarksNavigation linkClass={(active) => linkClass(active)} /><FrameworkNavigation /></nav>

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
          <button type="button" onClick={() => void openFeedback()} className={cn(linkClass(false), "w-full")}>
            <MessageSquareHeart className="h-[18px] w-[18px]" />
            Share feedback
          </button>
          <button type="button" onClick={() => onOpenSupport()} className={cn(linkClass(false), "w-full")}>
            <LifeBuoy className="h-[18px] w-[18px]" />
            Support
          </button>
        </div>
      </aside>
      )}

      <div className={focus ? undefined : "pl-64"}>
        {!appBackupPage && <TenantTrialNotices showWelcome={pathname !== "/portal/onboarding" && pathname !== "/license"} />}
        {!appBackupPage && !trialEndVisible(licenseStatus) && <CommunityChoiceBanner />}
        {!appBackupPage && !focus && <LicenseBanner />}
        {!focus && <SignInBanner hidden={appBackupPage} />}
        {[/portal\/backup/, /portal\/drift/, /portal\/audit/, /portal\/(governance|changes|operations|reports|alerts|sync)/].some(pattern => pattern.test(pathname)) && <TenantAccessNotice />}
        {/* Room to scroll the end of a page clear of the floating backup and activity panels while they show. */}
        <main className="pb-[calc(var(--floating-progress-offset,0px)+var(--background-tasks-offset,0px))]">
          <ErrorBoundary key={desktopRouteBoundaryKey(pathname)}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <FloatingProgress />
      <BackgroundTasksPanel />
      <Toaster />
      <PurchaseKeyWatcher />
      <FrameworkJobNotifier />
      <CisJobNotifier />
      <DriftScanNotifier />
      <WhatsNewAnnouncement />
    </div>
  )
}
