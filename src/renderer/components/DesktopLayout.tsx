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
  CircleHelp,
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu"
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
import { SetupCallLink } from "./SetupCallLink"
import { SignInBanner } from "./SignInBanner"
import { SupportDialog } from "./SupportDialog"
import { FeedbackDialog } from "./FeedbackDialog"
import { feedbackPageLabel, type FeedbackSnapshot } from "../../shared/feedback"
import { TenantSwitcher } from "./TenantSwitcher"
import { UpdateSidebarLabel } from "./UpdateSidebarLabel"
import { WhatsNewAnnouncement, WhatsNewDialog } from "./WhatsNewDialog"
import { useWhatsNew } from "../lib/whats-new"
import { TenantAccessNotice } from "./TenantAccessNotice"
import { CisBenchmarksNavigation } from "./CisBenchmarksNavigation"
import { NAV_PLAN_FEATURES, NavPlanBadge } from "./NavPlanBadge"
import { FrameworkNavigation } from "./FrameworkNavigation"
import { OibJobIndicator } from "./oib/JobIndicator"
import { NavFoldGroup, useFoldedGroups, useHoverPill } from "./SidebarNavigation"
import { firstConnected } from "../lib/return-focus"

interface NavItem {
  name: string
  href?: string
  /** One-line job of the screen, shown as the link title where names alone blur together. */
  hint?: string
  icon?: ComponentType<{ className?: string }>
  children?: NavItem[]
}

/** The sidebar's entries in groups; the first group has no heading. */
interface NavGroup {
  label?: string
  items: NavItem[]
}

const navigationGroups: NavGroup[] = [
  { items: [
    { name: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
    { name: "Tenants", href: "/portal/tenants", icon: Building2 },
  ] },
  { label: "Protect", items: [
    { name: "Backup & Restore", href: "/portal/backup", icon: Database },
    { name: "App Backup", href: "/portal/app-backup", icon: Package, hint: "Intune apps and installer backups" },
    { name: "Drift Detection", href: "/portal/drift", icon: GitCompare },
    { name: "Sync", href: "/portal/sync", icon: RefreshCw, hint: "Copy settings from one tenant to others" },
    { name: "Alerts", href: "/portal/alerts", icon: Siren, hint: "Teams, email and webhook alerts for backups and policy changes" },
  ] },
  // CIS Benchmarks and Frameworks follow OpenIntuneBaseline in this group.
  { label: "Baselines", items: [
    { name: "OpenIntuneBaseline", href: "/portal/oib", icon: Layers },
  ] },
  { label: "Oversight", items: [
    { name: "Reports", href: "/portal/reports", icon: FileText, hint: "What changed, setting by setting, and who changed it" },
    { name: "Audit Log", href: "/portal/audit", icon: Shield, hint: "What TenuVault did, when, and did it work" },
    { name: "Governance", href: "/portal/governance", icon: ClipboardCheck, hint: "Posture, accepted deviations and standards" },
    { name: "Changes", href: "/portal/changes", icon: GitPullRequest, hint: "Reviewed and approved tenant writes" },
    { name: "Operations", href: "/portal/operations", icon: Activity },
  ] },
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

/** Runs after the next paint, so a closed menu is gone from the window (and from a feedback screenshot). */
function afterPaint(run: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(run))
  else setTimeout(run, 0)
}

/**
 * Help at the foot of the sidebar: the release notes and feedback, with Support as the panel's last
 * row. It opens upward with the same motion as the tenant switcher. The release notes keep
 * their dot on the Help entry while an installed build is unseen. A chosen item runs once the menu has
 * closed and painted, and the dialog it opens hands focus back to Help. Until that item has done its
 * work (for Share feedback, until the window is captured) Help does not open again, so the menu can
 * never be in the feedback screenshot.
 */
function HelpMenu({ linkClass, onWhatsNew, onFeedback, onSupport, launching, busy, trigger }: {
  linkClass: (active: boolean) => string
  /** Set while a chosen item launches. Owned by DesktopLayout, so it outlives a sidebar that unmounts meanwhile. */
  launching: RefObject<boolean>
  /** True while Help must stay closed: an item is launching, or a feedback capture started anywhere is pending. */
  busy: () => boolean
  /** The Help button, owned by DesktopLayout so dialogs can return focus to the current one. */
  trigger: RefObject<HTMLButtonElement | null>
  /** The items' actions and dialogs live in DesktopLayout too, so a queued item still runs if the sidebar unmounts first. */
  onWhatsNew: (opener: HTMLElement | null) => void
  onFeedback: (opener: HTMLElement | null) => Promise<void>
  onSupport: (opener: HTMLElement | null) => void
}) {
  const { state } = useWhatsNew()
  const [open, setOpen] = useState(false)
  const pending = useRef<(() => void | Promise<void>) | null>(null)
  // The first item chosen wins: the closing menu stays on screen for its exit animation, and a second
  // choice made then (or while the first is still launching) is ignored. So is a choice in a menu that
  // was dismissed (Escape, a click outside) and is only still on screen while it animates out.
  const choose = (run: () => void | Promise<void>) => (event: Event) => {
    if (!open || busy()) {
      event.preventDefault()
      return
    }
    pending.current = run
    launching.current = true
  }
  const unseen = Boolean(state?.hasUnseen)
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => { if (!next || !busy()) setOpen(next) }}>
        <DropdownMenuTrigger asChild>
          <button ref={trigger} type="button" className={cn(linkClass(false), "w-full")} aria-label={unseen ? "Help, new changes since you last looked" : undefined}>
            <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
            Help
            {unseen && <span aria-hidden="true" className="ml-auto size-2 rounded-full bg-blue-600" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={6}
          className="tv-pop w-72 overflow-hidden rounded-[1.375rem] p-0"
          onCloseAutoFocus={() => {
            const run = pending.current
            pending.current = null
            if (!run) return
            afterPaint(() => {
              void Promise.resolve(run()).catch(() => undefined).finally(() => { launching.current = false })
            })
          }}
        >
          <div className="space-y-px p-1.5">
            <DropdownMenuItem onSelect={choose(() => onWhatsNew(trigger.current))} className="gap-3 rounded-2xl px-3 py-2">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              What&apos;s new
              {unseen && <><span aria-hidden="true" className="ml-auto size-2 rounded-full bg-blue-600" /><span className="sr-only">, new changes since you last looked</span></>}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={choose(() => onFeedback(trigger.current))} className="gap-3 rounded-2xl px-3 py-2">
              <MessageSquareHeart className="h-4 w-4" aria-hidden="true" />
              Share feedback
            </DropdownMenuItem>
          </div>
          <div className="border-t bg-secondary/60 p-1.5">
            <DropdownMenuItem onSelect={choose(() => onSupport(trigger.current))} className="group/support gap-3 rounded-2xl px-2 py-2">
              <span aria-hidden="true" className="flex size-8 flex-shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground"><LifeBuoy className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">Support</span>
                <span className="block text-xs text-muted-foreground">Documentation, contact options and a free setup call</span>
              </span>
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground motion-safe:transition-transform motion-safe:group-focus/support:translate-x-0.5" />
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
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
function useOverflowing(element: HTMLElement | null): boolean {
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
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
  }, [element])
  return overflowing
}

export function DesktopLayout() {
  const { status: licenseStatus } = useLicense()
  const location = useLocation()
  const { pathname } = location
  const appBackupPage = isAppBackupPath(pathname)
  const tenants = useTenants()
  useScoreInvalidation()
  // MSPs with several tenants get the all-tenants overview at the top.
  const groups: NavGroup[] = tenants.length > 1
    ? [{ items: [{ name: "All tenants", href: "/portal/overview", icon: LayoutGrid }, ...navigationGroups[0]!.items] }, ...navigationGroups.slice(1)]
    : navigationGroups
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [supportOpen, setSupportOpen] = useState(false)
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const whatsNewReturn = useRef<HTMLElement | null>(null)
  const [feedback, setFeedback] = useState<{ open: boolean; snapshot: FeedbackSnapshot | null }>({ open: false, snapshot: null })
  const capturingFeedback = useRef(false)
  const helpLaunching = useRef(false)
  const helpTrigger = useRef<HTMLButtonElement>(null)
  // During the guided setup there is no sidebar: dialogs fall back to the header's Support button.
  const headerSupport = useRef<HTMLButtonElement>(null)
  // Dialogs opened from Help or the first-run header hand focus back to the control that opened them.
  const supportReturn = useRef<HTMLElement | null>(null)
  const feedbackReturn = useRef<HTMLElement | null>(null)
  const openSupport = (opener: HTMLElement | null) => {
    supportReturn.current = opener
    setSupportOpen(true)
  }
  // The window is captured before the dialog opens, so the dialog is not in the screenshot.
  // The page is read when the capture starts: a Help choice runs after the menu's exit, and the user
  // may have moved to another page meanwhile, which is then the one in the screenshot. The count goes up
  // on every navigation, also one back to the same page or to an entry already in the history.
  const currentRoute = useRef({ pathname, count: 0 })
  useEffect(() => { currentRoute.current = { pathname: location.pathname, count: currentRoute.current.count + 1 } }, [location])
  const openFeedback = async (opener: HTMLElement | null) => {
    if (capturingFeedback.current || feedback.open) return
    capturingFeedback.current = true
    feedbackReturn.current = opener
    let snapshot: FeedbackSnapshot | null = null
    for (let attempt = 0; ; attempt++) {
      const { pathname: path, count } = currentRoute.current
      // After the page changed under two captures, the last one names no page, so it cannot name the wrong one.
      const page = attempt < 2 ? feedbackPageLabel(path) : undefined
      snapshot = await bridge.feedback.capture(page).catch(() => null)
      if (page === undefined || currentRoute.current.count === count) break
      // The page changed while the window was captured, so the screenshot may show either one: take
      // it again once the new page has painted, so the page named matches the one in the picture.
      if (snapshot) void bridge.feedback.discardCapture(snapshot.id).catch(() => undefined)
      await new Promise<void>((resolve) => afterPaint(resolve))
    }
    capturingFeedback.current = false
    setFeedback({ open: true, snapshot })
  }
  // Until a tenant is connected the guided setup is the only job, so it gets the window to itself.
  // The page keeps its place in the tree either way, so connecting the first tenant during the
  // setup only brings in the sidebar and never remounts the setup.
  const focus = tenants.length === 0 && pathname === "/portal/onboarding"
  const hoverPill = useHoverPill(pathname)
  // Measured on the mounted nav, so a sidebar that appears after the first-run setup is watched too.
  const navOverflowing = useOverflowing(hoverPill.nav)
  const { folded, toggle: toggleGroup } = useFoldedGroups()
  // Baselines also holds CIS Benchmarks, the framework catalog and custom baselines.
  const holdsActive = (group: NavGroup) =>
    group.items.some((item) => item.href && pathname.startsWith(item.href)) ||
    (group.label === "Baselines" && /^\/portal\/(frameworks|baselines)(\/|$)/.test(pathname))

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const linkClass = (active: boolean, nested = false) =>
    cn(
      // 32px rows, sized for a pointer, so the grouped list fits the default 920px tall window. No colour
      // transition: a row that becomes the open page takes its fill and white label at once, so the label
      // never passes through a shade that matches its background. Hover motion is the sliding pill's job.
      "flex min-h-8 items-center gap-3 rounded-full px-4 py-1.5 text-sm font-medium",
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
      <Link key={item.name} to={item.href!} title={item.hint} aria-current={active ? "page" : undefined} data-nav-row="" className={cn(linkClass(active, depth > 0), depth > 0 && "ml-4")}>
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

  const quiet = "rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"

  return (
    <div className="min-h-screen bg-background">
      {/* Floating white panel on the warm canvas, 12px from the window edge; the content column starts at 16rem. */}
      {focus ? (
        <header className="flex items-center justify-between gap-4 px-6 pt-5 lg:px-8">
          <div className="flex items-center gap-3">
            <BrandMark className="size-9" />
            <div className="text-base font-semibold tracking-tight text-foreground">TenuVault</div>
          </div>
          <nav aria-label="Help" className="flex items-center gap-1">
            <SetupCallLink source="setup-header" variant="nav" className={quiet} />
            <Link to="/license" className={quiet}>License</Link>
            <button type="button" onClick={(event) => void openFeedback(event.currentTarget)} className={quiet}>Share feedback</button>
            <button ref={headerSupport} type="button" onClick={(event) => openSupport(event.currentTarget)} className={quiet}>Support</button>
          </nav>
        </header>
      ) : (
      <aside className="tv-sidebar fixed bottom-3 left-3 top-3 z-40 flex w-[15.25rem] flex-col rounded-3xl bg-card shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        <div className="flex items-center gap-3 px-5 pb-3 pt-4">
          <BrandMark className="size-9" />
          <div className="text-lg font-semibold tracking-tight text-foreground">TenuVault</div>
        </div>

        <div className="px-3 pb-2">
          <TenantSwitcher />
        </div>

        {/* min-h-0 lets the list shrink and scroll inside the panel instead of pushing past it. Only while it
            scrolls does it keep the wheel to itself; otherwise the wheel over the sidebar scrolls the page. */}
        <nav ref={hoverPill.navRef} aria-label="Main navigation" data-pills={hoverPill.on ? "on" : undefined} className={cn("tv-nav relative min-h-0 flex-1 overflow-y-auto px-3 py-1", navOverflowing && "overscroll-contain")}>
          <span aria-hidden="true" className="tv-pill" />
          {groups.map((group) => group.label ? (
            <NavFoldGroup key={group.label} label={group.label} open={!folded.has(group.label)} holdsActive={holdsActive(group)} onToggle={() => toggleGroup(group.label!)}>
              {group.items.map((item) => renderItem(item))}
              {group.label === "Baselines" && <><CisBenchmarksNavigation linkClass={(active) => linkClass(active)} /><FrameworkNavigation /></>}
            </NavFoldGroup>
          ) : (
            <div key="start" className="space-y-px">{group.items.map((item) => renderItem(item))}</div>
          ))}
        </nav>

        <OibJobIndicator />
        <div className="space-y-0.5 px-3 pb-3 pt-1">
          <UpdateSidebarLabel />
          <Link to="/portal/settings" className={linkClass(pathname.startsWith("/portal/settings"))}>
            <Settings className="h-[18px] w-[18px]" />
            Settings
          </Link>
          <Link to="/license" className={linkClass(pathname.startsWith("/license"))}>
            <KeyRound className="h-[18px] w-[18px]" />
            License
            <LicenseNavBadge />
          </Link>
          <HelpMenu linkClass={linkClass} onFeedback={openFeedback} onSupport={openSupport} onWhatsNew={(opener) => { whatsNewReturn.current = opener; setWhatsNewOpen(true) }} launching={helpLaunching} busy={() => helpLaunching.current || capturingFeedback.current} trigger={helpTrigger} />
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
      <WhatsNewDialog open={whatsNewOpen} onOpenChange={setWhatsNewOpen} returnFocus={firstConnected(whatsNewReturn, helpTrigger, headerSupport)} />
      <SupportDialog open={supportOpen} onOpenChange={setSupportOpen} returnFocus={firstConnected(supportReturn, helpTrigger, headerSupport)} />
      <FeedbackDialog
        open={feedback.open}
        onOpenChange={(open) => setFeedback((current) => ({ open, snapshot: open ? current.snapshot : null }))}
        snapshot={feedback.snapshot}
        returnFocus={firstConnected(feedbackReturn, helpTrigger, headerSupport)}
        // Support opened from the feedback dialog returns to where feedback was opened from.
        onOpenSupport={() => { supportReturn.current = feedbackReturn.current; setSupportOpen(true) }}
      />
      <WhatsNewAnnouncement />
    </div>
  )
}
