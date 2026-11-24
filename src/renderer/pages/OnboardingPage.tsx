import { NoticeCard } from "../components/NoticeCard"
import { OnboardingHeading, onboardingCard, onboardingLink, onboardingPrimary } from "../components/OnboardingCard"
import { OnboardingSignIn, type MethodAvailability } from "../components/OnboardingSignIn"
import { BrowserSignInWait, OtherTenant } from "../components/OnboardingConnection"
import { type BackupScopeCoverage, type SignInMethod, type WizardSignInResult } from "../../shared/tenant-connection"
import { MODULES } from "../../shared/services/modules"
import { typeForFolder } from "../../shared/intune/registry"
import { BACKUP_SERVICES } from "../../shared/services/presentation"
import { tenantPermissionPacks } from "../../shared/services/permission-packs"
import { serializeTenants } from "~/lib/tenant-state"
import { PermissionRoutes, Switch } from "../components/ServicesSettings"
import { choiceLabel, DEFAULT_ONBOARDING_CHOICE, ONBOARDING_ENTRA_CHOICE, hasOnboardingBackups } from "../../shared/services/onboarding"
import { graphPermissions, missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { chosenBackupCoverage } from "../../shared/services/graph-cli-coverage"
import { backupAreaCoverage, needsBackupAccess } from "../../shared/services/backup-coverage"
import { listNames, needsAccessText, StartNowAccessHelp } from "../components/BackupAccessHelp"
import { trialKeyRefusalText } from "../../shared/trial-notices"
import { showCommunityLimitError } from "../lib/plan-dialog"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { AlertTriangle, ArrowLeft, ArrowRight, Ban, CheckCircle2, Cloud, HardDriveDownload, KeyRound, Loader2, Play, RotateCcw, ScanSearch, XCircle, Zap } from "lucide-react"
import { useSelectedTenant, useTenantOperations, useTenants } from "~/contexts/TenantContext"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"
import type { RegistrationResult, SignedInAccount } from "../../shared/ipc"
import type { AppearanceSetting, SetupConnection, TransferPreview } from "../../shared/settings-transfer"
import { LOCAL_STORAGE_PREFIX, TRIAL_USED_MESSAGE } from "../../shared/constants"
import { TrialKeyRefusalActions } from "../components/TenantTrial"
import { StorageChooser } from "../components/StorageChooser"
import { FirstBackupNextSteps } from "../components/FirstBackupNextSteps"
import { PlanContext, TrialOrKey } from "../components/PlanChoice"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { ConnectTenantSetup } from "../components/ConnectTenantSetup"
import { SetupCallHintShown, SetupCallLink } from "../components/SetupCallLink"
import { recordSetup, SetupDiagnosticsCard } from "../components/SetupDiagnostics"
import { TenantSignInForm, type SignInFields } from "../components/TenantSignInForm"
import { bridge } from "../lib/bridge"
import { buildTenantProfile, fetchTenantDetails } from "../lib/desktop-tenant"
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft } from "../lib/onboarding-draft"
import type { StorageChoice } from "../lib/storage"
import { desktopTenantCredentials, type TenantCredentials } from "../overrides/add-tenant-modal"
import { completedWithWarnings, formatBackupDuration, summarizeBackupResults, resolveBackupJobDisplay, toBackupJobDisplay, type BackupJobDisplay } from "~/lib/backup-job-display"
import { BackupResults } from "~/components/backup/backup-results"

/** Whether a sign-in is to the tenant and app registration a setup file names. */
function sameRegistration(account: SignedInAccount, connection: SetupConnection): boolean {
  return account.tenantId.toLowerCase() === connection.tenantId.toLowerCase() && account.clientId.toLowerCase() === connection.clientId.toLowerCase()
}

function currentAppearance(): AppearanceSetting {
  try {
    const value = localStorage.getItem("tenuvault-appearance")
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

const STEPS = ["Connect", "Check", "Storage", "First backup"]
const entraBackupFolders = MODULES.filter(module => module.id === "entra" || module.id === "conditionalAccess")
  .flatMap(module => module.areas.filter(area => !area.optIn).flatMap(area => area.folders))

type JobStatus = BackupJobDisplay
type Step = -2 | 0 | 1 | 2 | 3 | 4
type PermissionResult = { missing: string[]; error?: string; coverage?: BackupScopeCoverage[] }

const EMPTY_METHODS: MethodAvailability = { graphCli: null, tenuvaultApp: null }

/** The first backup's state: running, completed, cancelled by the user (grey) or failed. */
export function JobStateIcon({ job }: { job: Pick<JobStatus, "isComplete" | "isSuccessful" | "status" | "progressMessage" | "results"> }) {
  if (!job.isComplete) return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (completedWithWarnings(job)) return <AlertTriangle className="h-4 w-4 text-amber-700" />
  if (job.isSuccessful) return <CheckCircle2 className="h-4 w-4 text-green-600" />
  return job.status === "Cancelled" ? <Ban className="h-4 w-4 text-gray-500" /> : <XCircle className="h-4 w-4 text-red-600" />
}

/**
 * Set up a new tenant, choose where backups
 * go and take a first backup. No Azure resources are required. Progress is saved, so setup can
 * continue after a restart, for example once another administrator created the app registration.
 */
export default function OnboardingPage() {
  const navigate = useNavigate()
  const { status } = useLicense()
  const tenants = useTenants()
  const [addingTenant] = useState(tenants.length > 0)
  const { addTenant, updateTenant } = useTenantOperations()
  const { setSelectedTenantId } = useSelectedTenant()
  const [initial] = useState(loadOnboardingDraft)
  const [step, setStep] = useState<Step>(initial?.step ?? -2)
  const [services, setServices] = useState<PermissionChoice>(initial?.services ?? DEFAULT_ONBOARDING_CHOICE)
  const [reviewingEntra, setReviewingEntra] = useState(false)
  const [permissionCheck, setPermissionCheck] = useState<{ account: SignedInAccount; services: PermissionChoice; result: PermissionResult } | null>(null)
  const [method, setMethod] = useState<SignInMethod>("ownApp")
  const [available, setAvailable] = useState(EMPTY_METHODS)
  const [publicTenant, setPublicTenant] = useState("")
  const [publicBusy, setPublicBusy] = useState(false)
  const [publicError, setPublicError] = useState("")
  const [sharedSignIn, setSharedSignIn] = useState<WizardSignInResult | null>(null)
  const [retryTenant, setRetryTenant] = useState<string>()
  const [publicCode, setPublicCode] = useState("")
  const [consentBusy, setConsentBusy] = useState<"open" | "handoff" | null>(null)
  const [consentStatus, setConsentStatus] = useState("")
  const sharedDraft = useRef<string | undefined>(undefined)
  const appPermissions = useMemo(() => method === "tenuvaultApp"
    ? [...new Set(tenantPermissionPacks(services, { azure: false, audit: false }).flatMap(item => item.scopes))].filter(scope => scope.includes(".")).sort()
    : [], [method, services])
  const permissionGeneration = useRef(0)
  const [fields, setFields] = useState<SignInFields>({ tenant: initial?.tenant ?? "", clientId: initial?.clientId ?? "", displayName: initial?.displayName ?? "" })
  const [account, setAccount] = useState<SignedInAccount | null>(initial?.account ?? null)
  const permissionResult = permissionCheck?.account === account && permissionCheck?.services === services ? permissionCheck.result : null
  const reviewPermissions = step === 4 || step === 2
  const checkingPermissions = Boolean(account && method === "ownApp" && reviewPermissions && !permissionResult)
  const tenantDetails = useRef<{ account: SignedInAccount; result: ReturnType<typeof fetchTenantDetails> } | null>(null)
  const [organization, setOrganization] = useState<{ account: SignedInAccount; name: string } | null>(null)
  const [completedCheck, setCompletedCheck] = useState<{ account: SignedInAccount; services: PermissionChoice } | null>(null)
  const [firstBackupLabel, setFirstBackupLabel] = useState("")
  const [resumed, setResumed] = useState(Boolean(initial && (initial.step > 0 || initial.account)))
  const [checkingResume, setCheckingResume] = useState(Boolean(initial?.account))
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [storageBlocker, setStorageBlocker] = useState<string | null>(null)
  const plan = useTenantPlan(account?.tenantId)
  const [credentials, setCredentials] = useState<TenantCredentials | null>(null)
  const [tenantProfileId, setTenantProfileId] = useState<number | null>(null)
  const [tenantName, setTenantName] = useState("")
  const [setupRunning, setSetupRunning] = useState(false)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [releasing, setReleasing] = useState(false)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [jobError, setJobError] = useState("")
  const [runningJobId, setRunningJobId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [addError, setAddError] = useState<{ message: string; license: boolean; alreadyConnected?: boolean } | null>(null)
  // After the in-app setup: what it did, and the account the Sign in step signs in as by itself.
  const [setupNotice, setSetupNotice] = useState("")
  const [autoSignIn, setAutoSignIn] = useState<{ loginHint: string } | null>(null)
  // A setup file another admin exported: its connection details fill in the Connect and Storage steps.
  const [setup, setSetup] = useState<{ importId: string; connection: SetupConnection } | null>(null)
  // A setup file waiting for a service choice that has to be confirmed again; Continue picks it up.
  const [setupChoices, setSetupChoices] = useState<{ importId: string; connections: SetupConnection[] } | null>(null)
  const [setupError, setSetupError] = useState("")
  const [openingSetup, setOpeningSetup] = useState(false)
  // Each setup file starts a new attempt. An in-app setup started before it may still finish in the
  // browser; its result then belongs to the attempt the admin left and must not sign in by itself.
  const [attempt, setAttempt] = useState(0)
  const currentAttempt = useRef(0)
  // A sign-in that is being given up right now: a setup file arriving meanwhile treats it as gone.
  const releasingAccount = useRef(false)
  const [searchParams] = useSearchParams()
  const { addJob, removeJob, updateJob, activeJobs } = useBackupProgress()
  const completedBackup = useRef<string | null>(null)
  const handledPollError = useRef<string | null>(null)
  const [snapshot, setSnapshot] = useState<JobStatus | null>(null)
  const tracked = runningJobId ? activeJobs.find((item) => item.jobId === runningJobId) : undefined
  const trackedStatus: JobStatus | null = tracked ? toBackupJobDisplay(tracked) : null
  // The snapshot keeps a finished backup finished after the store removes it.
  const displayJob: JobStatus | null = resolveBackupJobDisplay(trackedStatus, snapshot, job)
  const firstStep = useRef(true)
  // The floating panel takes over when the admin leaves an unfinished backup.
  const leavingBackup = useRef({ runningJobId, displayJob, updateJob })
  leavingBackup.current = { runningJobId, displayJob, updateJob }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (sharedDraft.current) void bridge.auth.wizardDiscard(sharedDraft.current).catch(() => undefined)
      const { runningJobId, displayJob, updateJob } = leavingBackup.current
      if (runningJobId && !displayJob?.isComplete) updateJob(runningJobId, { isHidden: false })
    }
  }, [])

  useEffect(() => {
    if (step !== -2 && step !== 4) return
    let current = true
    const check = (key: keyof MethodAvailability, read?: () => Promise<boolean>) => {
      void (read?.() ?? Promise.resolve(false)).catch(() => false).then(enabled => {
        if (current) setAvailable(previous => ({ ...previous, [key]: enabled }))
      })
    }
    check("graphCli", bridge.auth.graphCliAvailable)
    check("tenuvaultApp", bridge.auth.tenuvaultAppAvailable)
    return () => { current = false }
  }, [step])

  // A resumed sign-in counts only while it is still signed in on this computer. The check no longer
  // applies once the admin switched accounts, ran the setup again or signed in anew.
  const resumeCheck = useRef(true)
  useEffect(() => {
    if (!initial?.account) return
    let active = true
    const saved = initial.account
    if (tenants.some(tenant => tenant.credentials?.tenantId?.toLowerCase() === saved.tenantId.toLowerCase())) {
      setAccount(null)
      setFields({ tenant: "", clientId: "", displayName: "" })
      setServices(DEFAULT_ONBOARDING_CHOICE)
      setResumed(false)
      setStep(-2)
      setCheckingResume(false)
      clearOnboardingDraft()
      return
    }
    void bridge.auth.accounts().then((accounts) => {
      if (!active || !resumeCheck.current) return
      const signedIn = accounts.find((item) => item.tenantId === saved.tenantId && item.clientId === saved.clientId)
      setAccount(signedIn ?? null)
      if (!signedIn) {
        setStep((current) => (current > 1 ? 1 : current))
      }
    }).catch(() => {
      if (!active || !resumeCheck.current) return
      setAccount(null)
      setStep((current) => (current > 1 ? 1 : current))
    }).finally(() => { if (active) setCheckingResume(false) })
    return () => { active = false }
  }, [initial])

  useEffect(() => {
    if (step === 3) clearOnboardingDraft()
    else if (method === "ownApp") saveOnboardingDraft({ step, ...fields, account, services })
  }, [step, fields, account, services, method])

  useEffect(() => {
    const sent = ++permissionGeneration.current
    setPermissionCheck(null)
    if (!account || method !== "ownApp" || !reviewPermissions) return
    // Bound the wait so an unavailable check stays advisory. Drop answers after timeout or retry.
    const finish = (result: PermissionResult) => {
      if (!mounted.current || sent !== permissionGeneration.current) return
      permissionGeneration.current++
      clearTimeout(timer)
      setPermissionCheck({ account, services, result })
    }
    const timer = setTimeout(() => finish({ missing: [], error: "The permission check did not finish within 20 seconds." }), 20_000)
    void bridge.setup.checkPermissions(account.tenantId, account.clientId, services).then(finish).catch(error => {
      finish({ missing: [], error: error instanceof Error ? error.message : String(error) })
    })
    return () => { permissionGeneration.current++; clearTimeout(timer) }
  }, [account, services, method, reviewPermissions])

  // Fetch the profile details once per sign-in so the name can be confirmed before enrollment.
  useEffect(() => {
    if (!account || method !== "ownApp" || !reviewPermissions || checkingResume) return
    let active = true
    if (tenantDetails.current?.account !== account) {
      tenantDetails.current = { account, result: fetchTenantDetails(desktopTenantCredentials(account, "", { kind: "local" })) }
    }
    void tenantDetails.current.result.then(({ organization }) => {
      if (active && organization?.id?.toLowerCase() === account.tenantId.toLowerCase() && organization.displayName) {
        setOrganization({ account, name: organization.displayName })
      }
    })
    return () => { active = false }
  }, [account, method, reviewPermissions, checkingResume])

  // Each step starts at its heading, for keyboard and screen reader users too.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; if (step !== -2) return }
    document.getElementById(`setup-step-${step}`)?.focus()
  }, [step])

  useEffect(() => {
    if (!tracked?.isComplete || !runningJobId || completedBackup.current === runningJobId) return
    completedBackup.current = runningJobId
    setSnapshot(trackedStatus)
    setCancelling(false)
    // A cancel that failed while the backup ran says nothing about how it ended.
    setJobError("")
    if (tracked.isSuccessful && tenantProfileId) updateTenant(tenantProfileId, { lastBackup: new Date().toISOString(), syncStatus: "success" })
  }, [tracked?.isComplete, tracked?.isSuccessful, trackedStatus, runningJobId, tenantProfileId, updateTenant])

  // Status polling stopped on error: show the error, clear the job and let the admin retry or skip.
  useEffect(() => {
    if (!tracked?.pollError || !runningJobId || handledPollError.current === runningJobId) return
    handledPollError.current = runningJobId
    setJobError(tracked.pollError)
    setJob(null)
    setSnapshot(null)
    setCancelling(false)
    removeJob(runningJobId)
    setRunningJobId(null)
  }, [tracked?.pollError, runningJobId, removeJob])

  const connected = (tenantId: string) => tenants.some((tenant) => tenant.credentials?.tenantId?.toLowerCase() === tenantId.toLowerCase())

  /**
   * Signs out of a tenant that was signed in here but never saved, which also frees the free
   * Community plan for another tenant, then shows the sign-in form again.
   */
  const switchTenant = async (differentTenant = false) => {
    if (!account) return
    resumeCheck.current = false
    setReleasing(true)
    setAddError(null)
    try {
      releasingAccount.current = true
      try { if (!connected(account.tenantId)) await bridge.license.releaseTenant(account.tenantId) } finally { releasingAccount.current = false }
      setAccount(null)
      setChoice(null)
      if (differentTenant) {
        setFields({ tenant: "", clientId: "", displayName: "" })
        setRetryTenant(undefined)
        setSetup(null)
        setSetupNotice("")
        setAutoSignIn(null)
        setStep(0)
      } else {
        // With a setup file for another tenant open, the form starts with the file's IDs.
        if (setup && !sameRegistration(account, setup.connection)) setFields({ tenant: setup.connection.tenantId, clientId: setup.connection.clientId, displayName: setup.connection.name })
        setStep(1)
      }
    } catch (error) {
      setAddError({ message: error instanceof Error ? error.message : String(error), license: false })
    } finally {
      setReleasing(false)
    }
  }

  /**
   * The in-app setup made (or found) the app registration: keep its IDs and sign in on the next
   * step, where a failed sign-in can simply be repeated. An earlier sign-in that was never saved
   * belongs to another attempt and is given up first, as "Use a different tenant or account" does,
   * so the wizard cannot carry on with the tenant it showed before.
   */
  const registered = async (result: RegistrationResult, startedIn: number) => {
    resumeCheck.current = false
    const next = { ...fields, tenant: result.tenantId, clientId: result.clientId }
    setFields(next)
    saveOnboardingDraft({ step: 1, ...next, account: null, services })
    setAddError(null)
    if (account) {
      setReleasing(true)
      releasingAccount.current = true
      // A release the licensing service could not take is repeated at the next start.
      try { if (!connected(account.tenantId)) await bridge.license.releaseTenant(account.tenantId) } catch { /* see above */ }
      releasingAccount.current = false
      setReleasing(false)
      setAccount(null)
      setChoice(null)
      // A setup file opened while the sign-in was given up is the admin's newer choice: stop here.
      if (startedIn !== currentAttempt.current) return
    }
    // With several registrations the admin may want another one than the one TenuVault picked. A
    // sign-in that starts by itself could finish, and move on, while they are going back for it.
    const several = result.reused && result.candidateCount > 1
    // A reused registration is left as it is. What its admin consent lacks is said here, and the
    // sign-in waits, because this notice goes away once the admin is signed in.
    const missing = result.reused ? result.missingConsent : []
    const paused = several || missing.length > 0
    setAutoSignIn(result.ready && !paused ? { loginHint: result.username } : null)
    const reusedNotice = result.reused ? `This tenant already had a TenuVault app registration, "${result.displayName}", so TenuVault uses that one.` : ""
    const pending = "The app registration is ready, but Microsoft is still making it available for sign-in. Wait a moment, then select Sign in with Microsoft."
    setSetupNotice([
      reusedNotice || (result.ready ? "The app registration is ready." : ""),
      several ? `It is one of ${result.candidateCount} in this tenant.` : "",
      missing.length ? `It has no tenant-wide admin consent for some permissions TenuVault uses by default: ${missing.join(", ")}. TenuVault did not change it, and what needs these permissions does not work until an administrator grants them under Entra admin center > App registrations > ${result.displayName} > API permissions.` : "",
      result.ready ? (paused ? "To use it, select Sign in with Microsoft." : "") : pending,
      several ? 'To use another one, select Back, then "I already have an app registration" and enter its client ID.' : "",
    ].filter(Boolean).join(" "))
    setStep(1)
  }

  /**
   * Continues with the tenant of a setup file, on the Sign in step with its IDs filled in. A sign-in
   * that is not saved yet is never given up by opening a file: with the file's tenant and app
   * registration it is used as it is, and for another one the admin decides with "Use a different
   * tenant or account", which then fills in the file's IDs.
   */
  const continueWithSetup = (importId: string, connection: SetupConnection) => {
    setMethod("ownApp")
    currentAttempt.current += 1
    setAttempt(currentAttempt.current)
    resumeCheck.current = false
    setSetupChoices(null)
    setSetupError("")
    setAddError(null)
    setSetup({ importId, connection })
    setSetupNotice("")
    setAutoSignIn(null)
    if (account && !releasingAccount.current) {
      if (sameRegistration(account, connection)) {
        setFields((current) => ({ tenant: connection.tenantId, clientId: connection.clientId, displayName: current.displayName || connection.name }))
        setStep(4)
      } else setStep(1)
      return
    }
    const next = { tenant: connection.tenantId, clientId: connection.clientId, displayName: connection.name }
    setFields(next)
    saveOnboardingDraft({ step: 1, ...next, account: null, services })
    setStep(1)
  }

  /** The tenants of a settings file that can be connected from it: with connection details and not connected yet. */
  const setupFrom = (preview: TransferPreview) => {
    const connections = preview.groups.flatMap((group) => (group.setup && !group.connected ? [group.setup] : []))
    if (connections.length === 0) {
      setSetupError("This file has no connection details for a tenant that is not connected yet. Ask the other admin to export it again with Include connection details.")
    } else if (connections.length === 1) {
      continueWithSetup(preview.importId, connections[0]!)
    } else {
      setSetupError("")
      setSetupChoices({ importId: preview.importId, connections })
    }
  }

  // A file is read asynchronously; what it does is decided with the state of when it arrives, such as
  // a resumed sign-in the check above turned out to be gone.
  const latest = useRef({ continueWithSetup, setupFrom })
  latest.current = { continueWithSetup, setupFrom }

  const openSetupFile = async () => {
    setOpeningSetup(true)
    setSetupError("")
    try {
      const preview = await bridge.settingsTransfer.import(currentAppearance())
      if (preview) latest.current.setupFrom(preview)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    } finally {
      setOpeningSetup(false)
    }
  }

  // Settings > Import and export opens setup with a file it already read and the tenant to connect.
  const requestedSetup = searchParams.get("setup")
  const requestedTenant = searchParams.get("tenant")
  const handledSetup = useRef<string | null>(null)
  useEffect(() => {
    // A resumed sign-in is checked first, so the file is matched against the sign-in that is really there.
    if (!requestedSetup || checkingResume || handledSetup.current === requestedSetup) return
    handledSetup.current = requestedSetup
    bridge.settingsTransfer.preview(requestedSetup, currentAppearance()).then((preview) => {
      const group = preview.groups.find((entry) => entry.id === requestedTenant && entry.setup && !entry.connected)
      if (group?.setup) latest.current.continueWithSetup(preview.importId, group.setup)
      else if (requestedTenant) {
        // The link named a tenant that can no longer be connected from the file, for example one just
        // connected: say so, and let the admin choose another one instead of filling it in.
        const named = preview.groups.find((entry) => entry.id === requestedTenant)
        const others = preview.groups.flatMap((entry) => (entry.setup && !entry.connected ? [entry.setup] : []))
        setSetupError(named?.connected ? `${named.title} from this file is already connected.` : "The tenant this link names cannot be connected from the file.")
        setSetupChoices(others.length ? { importId: preview.importId, connections: others } : null)
        } else latest.current.setupFrom(preview)
    }, (error: unknown) => {
      setSetupError(error instanceof Error ? error.message : String(error))
    })
  }, [requestedSetup, requestedTenant, checkingResume])

  const discardShared = () => {
    if (sharedDraft.current) void bridge.auth.wizardDiscard(sharedDraft.current).catch(() => undefined)
    sharedDraft.current = undefined
    setSharedSignIn(null)
  }

  const chooseDifferentTenant = () => {
    if (method === "ownApp") {
      void switchTenant(true)
      return
    }
    discardShared()
    setAccount(null)
    setChoice(null)
    setAddError(null)
    setPublicError("")
    setPublicCode("")
    setConsentStatus("")
    setRetryTenant(undefined)
    setPublicTenant("")
    setStep(1)
  }

  const chooseMethod = async (next: SignInMethod) => {
    if (releasing || (next !== "ownApp" && available[next] !== true)) return
    setPublicError("")
    if (account && method === "ownApp" && !connected(account.tenantId)) {
      setReleasing(true)
      try { await bridge.license.releaseTenant(account.tenantId) }
      catch {
        if (mounted.current) setPublicError("Could not release the unfinished sign-in. Try again.")
        return
      } finally { if (mounted.current) setReleasing(false) }
      if (!mounted.current) return
    }
    discardShared()
    setAccount(null)
    setChoice(null)
    setPublicError("")
    setAddError(null)
    setMethod(next)
    setRetryTenant(undefined)
    setPublicCode("")
    setConsentStatus("")
    setPublicTenant("")
    setFields({ tenant: "", clientId: "", displayName: "" })
    setSetup(null)
    setSetupNotice("")
    setAutoSignIn(null)
    if (next !== "ownApp") saveOnboardingDraft({ step: -2, tenant: "", clientId: "", displayName: "", account: null, services })
    setStep(next === "ownApp" ? 0 : 1)
  }

  const signedInShared = (result: WizardSignInResult) => {
    if (!mounted.current) {
      void bridge.auth.wizardDiscard(result.id).catch(() => undefined)
      return
    }
    sharedDraft.current = result.id
    setSharedSignIn(result)
    setAccount(result.account)
    setStep(4)
  }

  const signInShared = async (tenant = retryTenant ?? publicTenant.trim()) => {
    if (publicBusy || consentBusy || method === "ownApp") return
    const startedIn = currentAttempt.current
    if (account) { setRetryTenant(account.tenantId); setPublicTenant(account.tenantId) }
    setPublicBusy(true)
    setPublicError("")
    setPublicCode("")
    setConsentStatus("")
    try {
      const outcome = await bridge.auth.wizardStage(tenant, method, services)
      if (!mounted.current || startedIn !== currentAttempt.current) {
        if ("result" in outcome) void bridge.auth.wizardDiscard(outcome.result.id).catch(() => undefined)
        return
      }
      if ("error" in outcome) {
        const declined = method === "graphCli" && (outcome.error.code === "AADSTS65004" || outcome.error.code === "cancelled")
        setPublicCode(outcome.error.code)
        setPublicError(declined ? "Sign-in was cancelled in the browser." : outcome.error.message.replace(/(?:permission )?\bpacks?\b/gi, "permissions").replace(" in Sign-in and access.", "."))
      } else signedInShared(outcome.result)
    } catch {
      if (mounted.current && startedIn === currentAttempt.current) setPublicError("Could not finish signing in. Try again.")
    } finally { if (mounted.current) setPublicBusy(false) }
  }

  const adminConsent = async (action: "open" | "handoff") => {
    if (publicBusy || consentBusy) return
    setConsentBusy(action)
    setConsentStatus("")
    try {
      const result = await bridge.auth.wizardPackConsent(account?.tenantId ?? retryTenant ?? publicTenant.trim(), services, "onboarding-backup", action)
      if (result.status === "handoff") {
        await navigator.clipboard.writeText(result.message)
        setConsentStatus("Instructions copied. Send them to your administrator, then sign in again after approval.")
      } else if (result.status === "received") {
        setConsentStatus("Microsoft returned an approval. Sign in again to check your access.")
      } else if (result.status === "error" || result.status === "waiting") {
        setConsentStatus(result.issue?.message.replace(/(?:permission )?pack/gi, "permissions") ?? "Waiting for administrator approval.")
      }
    } catch {
      setConsentStatus("Could not prepare the permission request. Try again.")
    } finally { if (mounted.current) setConsentBusy(null) }
  }

  // The license is checked before the tenant is saved. A
  // tenant the license does not cover is not added and its sign-in is removed in the main
  // process, so the admin signs in again with the same IDs once the license is sorted.
  const createTenant = async () => {
    if (creatingRef.current || !account || !choice || checkingResume || checkingPermissions || nothingReadable || (method !== "ownApp" && !sharedSignIn)) return
    if (connected(account.tenantId)) {
      setAddError({ message: "This tenant is already connected to TenuVault.", license: false, alreadyConnected: true })
      setAccount(null)
      setChoice(null)
      setAutoSignIn(null)
      setStep(1)
      return
    }
    creatingRef.current = true
    setCreating(true)
    setAddError(null)
    // The trial as the Storage step showed it. A trial that only starts during the check below
    // was never shown here, so it keeps its welcome card in the app.
    const shown = tenantLicense(status, account.tenantId)
    let community = false
    try {
      if (method === "ownApp") {
        const status = await bridge.license.checkNewTenant(account.tenantId)
        community = tenantPlan(tenantLicense(status, account.tenantId)) === "community"
      }
    } catch (error) {
      if (!showCommunityLimitError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        setAddError({ message: `${message} TenuVault signed you out of this tenant. Sign in again once the license covers it.`, license: true })
      }
      setAccount(null)
      setChoice(null)
      creatingRef.current = false
      setCreating(false)
      setStep(1)
      return
    }
    // The plan can change between the storage choice and this check, such as a trial that ended.
    if (community && choice.kind === "azure") {
      setAddError({ message: "This tenant is on Community now, which keeps backups on this device. Choose This device to continue.", license: false })
      setChoice(null)
      creatingRef.current = false
      setCreating(false)
      return
    }
    try {
      const creds = desktopTenantCredentials(account, fields.displayName, choice)
      const tenant = { ...(await buildTenantProfile(creds, method === "ownApp", tenantDetails.current?.account === account ? tenantDetails.current.result : undefined)), createdAt: new Date().toISOString() }
      if (!mounted.current) return
      const profile = serializeTenants([tenant])
      const outcome = sharedSignIn
        ? await bridge.auth.wizardFinish(sharedSignIn.id, profile, services)
        : await bridge.setup.enrollOwnApp(account.tenantId, account.clientId, profile, services)
      if ("error" in outcome) {
        if (outcome.error.code === "sign_in_required") {
          discardShared()
          setAccount(null)
          setChoice(null)
          setStep(1)
        }
        setAddError({ message: outcome.error.message, license: false })
        return
      }
      sharedDraft.current = undefined
      recordSetup({ name: "storage", props: { kind: choice.kind } })
      addTenant(tenant)
      setSelectedTenantId(tenant.id)
      setCredentials(creds)
      setTenantProfileId(tenant.id)
      setTenantName(tenant.name)
      setResumed(false)
      if (readable.length) setCompletedCheck({ account, services })
      setFirstBackupLabel(backupLabel)
      setStep(3)
      // The Storage step showed the trial, so it does not follow the admin into the app as a
      // welcome card to dismiss. Showing it again costs nothing, so a failure is ignored.
      if (shown?.source === "trial" && shown.trial && !shown.trialAcknowledged) void bridge.license.tenantTrialAction(account.tenantId, "acknowledge").catch(() => undefined)
    } catch (error) {
      if (!showCommunityLimitError(error)) setAddError({ message: error instanceof Error ? error.message : String(error), license: false })
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  /** POSTs to an API route and returns its JSON, or throws with the route's error message. */
  const post = async <T,>(path: string, body: object): Promise<T> => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = (await response.json().catch(() => ({}))) as T & { error?: string }
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`)
    return data
  }

  const runBackup = async () => {
    if (!credentials) return
    if (runningJobId) removeJob(runningJobId)
    setRunningJobId(null)
    setCancelling(false)
    setJobError("")
    setSnapshot(null)
    completedBackup.current = null
    handledPollError.current = null
    setJob({ status: "Running", progress: 5, progressMessage: "Starting backup...", isComplete: false, isSuccessful: false })
    let jobId: string
    try {
      const started = await post<{ jobId?: string }>("/api/backup/start", credentials)
      if (!started.jobId) throw new Error("The backup could not start.")
      jobId = started.jobId
      setRunningJobId(jobId)
    } catch (error) {
      setJob(null)
      setJobError(error instanceof Error ? error.message : String(error))
      return
    }

    // The shared backup job store polls this job; the effect above records a successful finish.
    addJob({
      jobId,
      tenantName: "",
      tenantId: credentials.tenantId,
      status: "Running",
      progress: 5,
      progressMessage: "Starting backup...",
      startTime: new Date().toISOString(),
      isComplete: false,
      isSuccessful: false,
      // A backup that started after the admin left is shown in the floating panel straight away.
      isHidden: mounted.current,
      quiet: true,
      credentials: { tenantId: credentials.tenantId, appId: credentials.appId, clientSecret: credentials.clientSecret },
      resources: { subscriptionId: credentials.subscriptionId ?? "", resourceGroupName: credentials.resourceGroupName ?? "", automationAccountName: "", storageAccountName: credentials.storageAccountName ?? "" },
    })
  }

  const cancelBackup = async () => {
    if (!runningJobId) return
    const jobId = runningJobId
    setCancelling(true)
    try {
      await bridge.backups.cancel(jobId)
    } catch (error) {
      // The answer can arrive after the backup ended or another one started. It then says nothing
      // the admin can act on.
      if (completedBackup.current === jobId || handledPollError.current === jobId || leavingBackup.current.runningJobId !== jobId) return
      setJobError(error instanceof Error ? error.message : "Could not cancel the backup. Try again.")
      setCancelling(false)
    }
  }

  const finished = Boolean(displayJob?.isComplete)
  const hasBackupTypes = hasOnboardingBackups(services)
  const automaticBackup = useRef(false)
  const startFirstBackup = useRef(runBackup)
  startFirstBackup.current = runBackup
  useEffect(() => {
    if (step !== 3 || !credentials || !hasBackupTypes || automaticBackup.current) return
    automaticBackup.current = true
    void startFirstBackup.current()
  }, [step, credentials, hasBackupTypes])

  const succeeded = Boolean(displayJob?.isComplete && displayJob.isSuccessful)
  const backupSummary = succeeded && displayJob?.results ? summarizeBackupResults(displayJob.results, true) : null
  // A backup that could not start or ended with an error. Cancelling is the admin's own choice, and
  // an error next to a backup that is on screen is a failed cancel, not a failed backup.
  const backupFailed = (Boolean(jobError) && !displayJob) || (finished && !succeeded && displayJob?.status !== "Cancelled")
  // The license refusal that sent the admin back to the Sign in step leaves them stuck there. A
  // tenant that is already connected has its own way on, and a message of the Storage step that
  // is still set after Back is not an error of this step.
  const signInStuck = Boolean(addError?.license)
  const stageIndex = step === 3 ? 3 : step === 2 ? 2 : step === 4 ? 1 : 0
  const coverage = chosenBackupCoverage(sharedSignIn?.coverage ?? permissionResult?.coverage ?? [], services)
  const selectedScopes = method === "tenuvaultApp" ? appPermissions : graphPermissions(services, "delegated")
  const sharedMissing = sharedSignIn?.verifiedScopes
    ? method === "tenuvaultApp"
      ? appPermissions.filter(scope => !sharedSignIn.verifiedScopes?.includes(scope))
      : missingForChoice(services, { kind: "delegated", permissions: new Set(sharedSignIn.verifiedScopes) })
    : sharedSignIn?.missing?.filter(scope => selectedScopes.includes(scope))
  const missing = [...new Set(sharedMissing ?? permissionResult?.missing ?? [])]
  const serviceChecks = BACKUP_SERVICES.flatMap(({ id, label }) => {
    if (!services[id] && !(id === "entra" && services.conditionalAccess)) return []
    const row = coverage.find(item => item.service === id)
    const areas = row ? backupAreaCoverage(row) : { readable: 0, complete: 0, total: 0, missing: [], unknown: true }
    return [{ label, ...areas, needsAccess: needsBackupAccess(row) }]
  })
  const incomplete = (service: typeof serviceChecks[number]) => service.missing.length > 0 || service.unknown
  const readable = serviceChecks.filter(service => service.readable > 0)
    .sort((a, b) => Number(incomplete(a)) - Number(incomplete(b)))
  const unavailable = serviceChecks.filter(service => service.needsAccess)
  const unknownCoverage = serviceChecks.some(service => service.unknown)
  const gaps = serviceChecks.filter(service => service.missing.length > 0)
  const nothingReadable = unavailable.length > 0 && unavailable.length === serviceChecks.length
  const checkPassed = Boolean(account && !publicError && !checkingResume && !checkingPermissions && readable.length &&
    !unknownCoverage && !gaps.length)
  const skippedCheck = Boolean(unknownCoverage || gaps.length || missing.length || publicError)
  const names = listNames(readable.map(service => service.label))
  const readyLabel = listNames(readable.map(service => {
    if (service.complete > 0 && service.complete < service.total) return `${service.label} (${service.complete} of ${service.total} areas)`
    return incomplete(service) ? `part of ${service.label}` : service.label
  }))
  const backupLabel = listNames(readable.map(service => incomplete(service) ? `part of ${service.label}` : service.label))
  const checkHeading = readable.length ? `You're ready to back up ${readyLabel}.`
    : nothingReadable ? "TenuVault can't read any of the services you picked with this sign-in."
    : "Check backup access"
  const checked = completedCheck?.account === account && completedCheck?.services === services
  const stageComplete = [stageIndex > 0, stageIndex > 1 && (checked || checkPassed), stageIndex > 2, succeeded]
  const continueToStorage = useCallback(() => {
    if (nothingReadable) return
    setCompletedCheck(names && account ? { account, services } : null)
    setStep(2)
  }, [account, names, nothingReadable, services])
  const stageWarning = [
    stageIndex === 0 && Boolean(addError || publicError),
    stageIndex >= 1 && !stageComplete[1] && skippedCheck,
    stageIndex === 2 && Boolean(addError),
    stageIndex === 3 && (backupFailed || Boolean(displayJob && completedWithWarnings(displayJob))),
  ]

  useEffect(() => {
    if (step !== 4 || !checkPassed || reviewingEntra || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const timer = setTimeout(continueToStorage, 1800)
    return () => clearTimeout(timer)
  }, [step, checkPassed, reviewingEntra, continueToStorage])

  // A resumed Storage step can pick up newly removed permissions.
  useEffect(() => {
    if (step === 2 && nothingReadable) setStep(4)
  }, [step, nothingReadable])

  const checkAgain = () => {
    if (!account) return
    if (method === "ownApp") setAccount({ ...account })
    else void signInShared(account.tenantId)
  }

  const copyAdminInstructions = async () => {
    const permissions = missing.length ? ` Missing permissions: ${missing.join(", ")}.` : ""
    if (!account || method !== "ownApp") return
    const instructions = `Please review backup access for ${choiceLabel(services)} in TenuVault. Add the missing delegated permissions to app registration ${account.clientId} in tenant ${account.tenantId} and grant consent for those permissions.${permissions} Let me know when I can check access again.`
    try {
      await navigator.clipboard.writeText(instructions)
      setConsentStatus("Instructions copied.")
    } catch {
      setConsentStatus("Could not copy the instructions.")
    }
  }

  const organizationName = method === "ownApp"
    ? (organization?.account === account ? organization?.name : undefined)
    : (sharedSignIn?.account === account ? sharedSignIn?.organizationName : undefined)
  const connectedTenant = account && <details className="text-center text-xs text-muted-foreground open:w-full">
    <summary className={cn("cursor-pointer", onboardingLink)}>{organizationName ?? "Connected tenant"}</summary>
    <div className="mt-2 space-y-1 break-words">
      <p>Signed in as {account.username}</p>
      <p>Tenant{organizationName ? ` ${organizationName}` : ""} <span className="font-mono">{account.tenantId}</span></p>
      <button type="button" className={onboardingLink} disabled={creating || releasing || publicBusy || Boolean(consentBusy)} onClick={chooseDifferentTenant}>Different tenant?</button>
    </div>
  </details>
  const openSetupAction = <div className="space-y-3 text-center">
    <button type="button" className={onboardingLink} aria-label="Another admin sent you a setup file? Set up from a file" disabled={openingSetup || releasing} onClick={() => void openSetupFile()}>
      {openingSetup ? "Opening setup file…" : "Another admin sent you a setup file?"}
    </button>
    {setupError && <p role="alert" className="text-sm text-red-700">{setupError}</p>}
    {setupChoices && <div className="space-y-2 text-sm">
      <p className="font-medium">Which tenant do you want to connect?</p>
      <ul className="space-y-2">{setupChoices.connections.map(connection => <li key={connection.tenantId}>
        <Button type="button" variant="outline" size="sm" onClick={() => continueWithSetup(setupChoices.importId, connection)}>{connection.name} <span className="ml-2 font-mono text-xs text-gray-500">{connection.tenantId}</span></Button>
      </li>)}</ul>
    </div>}
  </div>
  const resumeMessage = resumed && !addError && !publicError && !setupError &&
    <p role="status" className="text-center text-xs text-muted-foreground">Welcome back. Continue where you left off.</p>

  return (
    <div className="flex min-h-[calc(100vh-56px)] flex-col px-4 py-6 sm:px-6">
      <div className={cn("mx-auto my-auto w-full space-y-4", step === -2 ? "max-w-[960px]" : "max-w-[640px]")}>
        <h1 className="sr-only">Set up TenuVault</h1>
        <div className="space-y-2 text-center text-sm text-muted-foreground">
          <p>Step {stageIndex + 1} of {STEPS.length} <span aria-hidden="true">·</span> <span className="font-medium text-foreground">{STEPS[stageIndex]}</span></p>
          <ol className="flex justify-center gap-2.5" aria-label="Setup steps">
            {STEPS.map((title, i) => (
              <li key={title} aria-current={i === stageIndex ? "step" : undefined}
                className={cn("size-2 rounded-full",
                  stageWarning[i] ? "bg-amber-600 dark:bg-amber-400" : i === stageIndex ? "bg-foreground" : stageComplete[i] ? "bg-muted-foreground" : "bg-border",
                  i === stageIndex && "ring-1 ring-foreground ring-offset-2 ring-offset-background")}>
                <span className="sr-only">{title}{stageWarning[i] ? " (needs attention)" : stageComplete[i] ? " (done)" : ""}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className={cn(onboardingCard, "relative")}>
          {addingTenant && step === -2 && <Link to="/portal/dashboard" className={cn(onboardingLink, "mb-4 inline-flex items-center gap-2")}><ArrowLeft className="size-4" aria-hidden="true" /> Back to dashboard</Link>}
          {step !== -2 && step !== 3 && (
            <div className={cn("mb-4", step === 2 && "@lg:absolute @lg:top-10 @lg:left-10 @lg:mb-0")}>
              <button type="button" className={cn(onboardingLink, "inline-flex items-center gap-2")} onClick={() => {
                if (step === 2) setStep(4)
                else if (step === 4) {
                  if (method !== "ownApp") {
                    setRetryTenant(account?.tenantId)
                    setPublicTenant(account?.tenantId ?? "")
                    discardShared()
                    setAccount(null)
                  }
                  setStep(1)
                }
                else if (step === 1 && method === "ownApp") setStep(0)
                else {
                  if (method !== "ownApp") { discardShared(); setAccount(null); setMethod("ownApp") }
                  setStep(-2)
                }
              }} disabled={creating || releasing || setupRunning || publicBusy || Boolean(consentBusy)}>
                <ArrowLeft className="size-4" aria-hidden="true" />Back
              </button>
            </div>
          )}
          {step === -2 && <div className="space-y-4"><OnboardingSignIn available={available} choice={services} onChoose={chooseMethod} />{openSetupAction}</div>}
          {/* A file handed over from Settings can fail on any step, for example after its review expired. */}
          {step > 0 && setupError && (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {setupError} Open the file again in Settings, under Import and export, or select Set up from a file in the wizard.
            </p>
          )}
          {step === 0 && method === "ownApp" && (
            <div className="space-y-4">
              <OnboardingHeading id="setup-step-0" title="Create your TenuVault app registration" icon={<KeyRound />} />
              <ConnectTenantSetup
                choice={services}
                expectedTenant={retryTenant}
                onRunningChange={setSetupRunning}
                setupFile={openSetupAction}
                onManual={() => { setSetupNotice(""); setAutoSignIn(null); setStep(1) }}
                onRegistered={(result) => { if (attempt === currentAttempt.current) void registered(result, attempt) }}
              />
            </div>
          )}

          {step === 1 && method !== "ownApp" && (
            <div className="space-y-4 text-center">
              <OnboardingHeading id="setup-step-1" title="Sign in with Microsoft" icon={method === "graphCli" ? <Zap /> : <Cloud />}
                subtitle={publicBusy || consentBusy === "open" ? undefined : method === "graphCli"
                  ? "Use existing read access. Nothing is created in your tenant."
                  : "An admin approves read access for TenuVault once."} />
              {publicError && <div role="alert" className="space-y-1 text-sm text-red-700">
                <p>{publicError}</p>
                {method === "graphCli" && publicCode.startsWith("AADSTS") && <p className="text-xs">{publicCode}</p>}
              </div>}
              {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
              {publicBusy || consentBusy === "open"
                ? <BrowserSignInWait kind={consentBusy === "open" ? "consent" : "signin"} cancel={() => void bridge.auth.cancelSignIn()} />
                : <>
                  <Button className={onboardingPrimary} disabled={Boolean(consentBusy)} onClick={() => void signInShared()}>
                    <span aria-hidden="true" className="grid size-4 grid-cols-2 gap-0.5"><span className="bg-[#f25022]" /><span className="bg-[#7fba00]" /><span className="bg-[#00a4ef]" /><span className="bg-[#ffb900]" /></span>
                    {publicError ? "Try again" : "Sign in with Microsoft"}
                  </Button>
                  {method === "graphCli" && <p className="mx-auto max-w-md text-xs text-muted-foreground">If Microsoft asks for new permissions, go back and choose another connection method.</p>}
                  {method === "tenuvaultApp" && <div><button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={() => void adminConsent("handoff")}>Send to my admin</button></div>}
                  <OtherTenant tenant={publicTenant} onChange={setPublicTenant} disabled={Boolean(consentBusy)} expectedTenant={retryTenant} />
                  {method === "tenuvaultApp" && <details className="space-y-3" open={publicError ? true : undefined}>
                    <summary className={cn("cursor-pointer", onboardingLink)}>Permissions an admin will approve ({appPermissions.length})</summary>
                    <ul className="max-h-40 overflow-auto break-words rounded-xl bg-secondary p-3 text-left text-xs">
                      {appPermissions.map(scope => <li key={scope}>{scope}</li>)}
                    </ul>
                    <button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={() => void adminConsent("open")}>Open admin consent</button>
                  </details>}
                </>}
              {consentStatus && <p role="status" className="text-sm text-muted-foreground">{consentStatus}</p>}
            </div>
          )}

          {step === 1 && method === "ownApp" && (
            <div className="space-y-4">
              <OnboardingHeading id="setup-step-1" title="Sign in to your tenant" icon={<KeyRound />} />
              {setup && !account && <SetupFileNotice connection={setup.connection} />}
              {setup && account && !sameRegistration(account, setup.connection) && (
                <p role="status" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  The setup file is for tenant <span className="font-mono">{setup.connection.tenantId}</span>, but you are signed in to another tenant or app registration that is not saved yet. Select Use a different tenant or account to sign in with the file&apos;s details instead.
                </p>
              )}
              {setupNotice && !account && (
                <p role="status" className="flex items-start gap-2 rounded-2xl bg-green-50 px-4 py-2.5 text-sm text-green-800">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" /> {setupNotice}
                </p>
              )}
              {addError && (
                <div role="alert" className="space-y-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p className="flex items-start gap-2"><XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" /> {addError.license ? trialKeyRefusalText(addError.message) : addError.message}</p>
                  {addError.alreadyConnected && <Link className="text-blue-600 underline" to="/portal/dashboard">Go to dashboard</Link>}
                  {addError.license && <div className="space-y-2 text-gray-700">
                    <TrialKeyRefusalActions message={addError.message} source="setup-trial-key-refused" />
                    {addError.message.includes(TRIAL_USED_MESSAGE) ? <Link className="text-blue-600 underline" to="/license">Enter a Pro license key</Link> : <TrialOrKey source="setup-license-error" />}
                  </div>}
                  {signInStuck && <SetupCallLink source="signin-error" variant="hint" />}
                </div>
              )}
              {account ? (
                <div className="space-y-4">
                  <p className="flex items-center justify-center gap-2 text-sm text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Signed in as {account.username}
                  </p>
                  <div className="flex flex-col-reverse items-center gap-3">
                    <button type="button" className={onboardingLink} onClick={() => void switchTenant()} disabled={releasing}>
                      {releasing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                      Use a different tenant or account
                    </button>
                    <Button className={onboardingPrimary} onClick={() => setStep(4)} disabled={releasing}>
                      Continue <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : (
                // The error above already offers the setup call, so an error of the form does not repeat it.
                <SetupCallHintShown.Provider value={signInStuck}>
                  <TenantSignInForm
                    choice={services}
                    wizard
                    expectedTenant={setup && !account ? setup.connection.tenantId : setupNotice ? fields.tenant : retryTenant}
                    // The form keeps its own fields once mounted; a setup file that arrives later starts it again with the file's IDs.
                    key={setup ? `setup:${setup.importId}:${setup.connection.tenantId}` : "manual"}
                    initial={fields}
                    autoSignIn={autoSignIn}
                    hidePaste={Boolean(setupNotice)}
                    onFieldsChange={setFields}
                    onSignedIn={(signedIn, displayName) => {
                      resumeCheck.current = false
                      if (connected(signedIn.tenantId)) {
                        setAutoSignIn(null)
                        setAddError({ message: "This tenant is already connected to TenuVault.", license: false, alreadyConnected: true })
                        return
                      }
                      if (retryTenant && signedIn.tenantId.toLowerCase() !== retryTenant.toLowerCase()) {
                        void bridge.license.releaseTenant(signedIn.tenantId).catch(() => undefined)
                        setAutoSignIn(null)
                        setAddError({ message: "You signed in to a different tenant. Sign in with an account from this tenant.", license: false })
                        return
                      }
                      setAddError(null)
                      // The automatic sign-in is for this one registration; a later sign-in asks again.
                      setAutoSignIn(null)
                      setSetupNotice("")
                      setAccount(signedIn)
                      setFields((current) => ({ ...current, displayName }))
                      setStep(4)
                    }}
                  />
                </SetupCallHintShown.Provider>
              )}
            </div>
          )}

          {step === 4 && (
            <section className="space-y-4 text-center" aria-labelledby="setup-step-4">
              <OnboardingHeading id="setup-step-4" title={checkingPermissions || checkingResume || publicBusy ? "Check backup access" : checkHeading}
                icon={readable.length && !checkingPermissions && !checkingResume && !publicBusy ? <CheckCircle2 /> : <ScanSearch />}
                success={readable.length > 0 && !checkingPermissions && !checkingResume && !publicBusy} />
              <div className="space-y-2" onFocus={() => setReviewingEntra(true)}>
                <Switch showLabel checked={Boolean(services.entra)} disabled={publicBusy || Boolean(consentBusy)}
                  label="Also back up Entra ID device and access settings"
                  onChange={enabled => {
                    setReviewingEntra(true)
                    setConsentStatus("")
                    setServices(enabled ? ONBOARDING_ENTRA_CHOICE : DEFAULT_ONBOARDING_CHOICE)
                  }} />
                <details className="text-xs text-muted-foreground">
                  <summary className={cn("cursor-pointer", onboardingLink)}>What's included</summary>
                  <p className="mx-auto mt-2 max-w-md">{entraBackupFolders.map(folder => typeForFolder(folder)?.singleton?.name ?? typeForFolder(folder)?.label).filter(Boolean).join(", ")}.</p>
                  <p className="mt-1">Turn on groups and device inventory later in Settings.</p>
                  {method === "tenuvaultApp" && services.entra && <div className="mt-2">
                    <details>
                      <summary className={cn("cursor-pointer", onboardingLink)}>Permissions an admin will approve ({appPermissions.length})</summary>
                      <ul className="mt-2 space-y-1">{appPermissions.map(scope => <li key={scope}>{scope}</li>)}</ul>
                    </details>
                  </div>}
                </details>
              </div>
              {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
              {checkingPermissions || checkingResume || publicBusy ? (
                publicBusy ? <BrowserSignInWait kind="signin" cancel={() => void bridge.auth.cancelSignIn()} /> : <p role="status" className="space-y-3 text-sm text-muted-foreground"><Loader2 className="mx-auto size-8 motion-safe:animate-spin" aria-hidden="true" /> Checking permissions for your chosen services…</p>
              ) : <>
                {publicError && <p role="alert" className="text-sm text-red-700">{publicError}</p>}
                <div className="flex flex-col items-center gap-3" aria-label="Check actions">
                  {!nothingReadable && account && <Button className={onboardingPrimary} onClick={continueToStorage}>{!checkPassed && readable.length ? `Continue with ${names}` : "Continue"}</Button>}
                  {nothingReadable && <>
                    {method === "graphCli" && <Button className={onboardingPrimary} onClick={() => void chooseMethod("ownApp")}>Use your own app registration</Button>}
                    {method === "tenuvaultApp" && <Button className={onboardingPrimary} disabled={Boolean(consentBusy)} onClick={() => void adminConsent("open")}>Open admin consent</Button>}
                    {method === "ownApp" && <Button className={onboardingPrimary} onClick={() => void copyAdminInstructions()}>Copy instructions for my admin</Button>}
                    <button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={checkAgain}>Check again</button>
                  </>}
                </div>
                {!nothingReadable && !permissionResult?.error && resumeMessage}
                {(!checkPassed || missing.length > 0) && <NoticeCard
                  summary={unavailable.length ? needsAccessText(unavailable.map(service => service.label))
                    : gaps.length ? `Needs access for ${gaps.reduce((count, service) => count + service.missing.length, 0)} backup areas.`
                    : unknownCoverage ? "Some backup access could not be checked." : "Review backup access."}
                  details={<>
                    {unknownCoverage && <p>You can continue and check backup access later.</p>}
                    {!nothingReadable && unavailable.length > 0 && <p>You can add access later from Services.</p>}
                    {gaps.length > 0 && <ul className="space-y-2" aria-label="Areas needing access">
                      {gaps.map(service => <li key={service.label}><span className="font-medium">{service.label} ({service.missing.length})</span><p>{service.missing.join(", ")}</p></li>)}
                    </ul>}
                    {method === "graphCli" && <StartNowAccessHelp />}
                    {method === "tenuvaultApp" && <p>Ask a Microsoft administrator to approve backup access, then check again.</p>}
                    {method === "ownApp" && <p>Ask your Microsoft administrator to add access to this app registration.</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {method === "graphCli" && <>
                        {!nothingReadable && <button type="button" className={onboardingLink} onClick={() => void chooseMethod("ownApp")}>Use your own app registration</button>}
                        {available.tenuvaultApp === true && <button type="button" className={onboardingLink} onClick={() => void chooseMethod("tenuvaultApp")}>Use the TenuVault app</button>}
                      </>}
                      {!nothingReadable && method === "ownApp" && <button type="button" className={onboardingLink} onClick={() => void copyAdminInstructions()}>Copy instructions for my admin</button>}
                      {method === "tenuvaultApp" && <>
                        {!nothingReadable && <button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={() => void adminConsent("open")}>Open admin consent</button>}
                        <button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={() => void adminConsent("handoff")}>Copy instructions for my admin</button>
                      </>}
                      {!nothingReadable && <button type="button" className={onboardingLink} disabled={Boolean(consentBusy)} onClick={checkAgain}>Check again</button>}
                    </div>
                    {missing.length > 0 && <details>
                      <summary className="cursor-pointer font-medium">Show permission names</summary>
                      <ul className="my-2 list-disc break-words pl-5">{missing.map(scope => <li key={scope}>{scope}</li>)}</ul>
                      {method === "ownApp" && account && <PermissionRoutes compact report={account} missing={missing} />}
                    </details>}
                  </>}
                />}
                {consentBusy === "open" && <BrowserSignInWait kind="consent" cancel={() => void bridge.auth.cancelSignIn()} />}
                {consentStatus && <p role="status" className="text-sm text-gray-700">{consentStatus}</p>}
              </>}
              {connectedTenant}
            </section>
          )}

          {step === 2 && account && (
            <div className="space-y-3">
              <OnboardingHeading id="setup-step-2" title="Where should backups go?" subtitle="Choose where to keep your encrypted backups." />
              {checkingPermissions && <p role="status" className="text-sm text-gray-600">Checking permissions for your chosen services…</p>}
              {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
              {setup?.connection.storage && setup.connection.tenantId === account.tenantId.toLowerCase() && (
                <p className="text-sm text-gray-600">The setup file chose {setup.connection.storage.kind === "local" ? "This device" : `the storage account ${setup.connection.storage.storageAccountName}`}. {setup.connection.storage.kind === "azure" ? "TenuVault checks access automatically." : ""}</p>
              )}
              <StorageChooser
                // A setup file opened while this step shows starts the chooser again with the file's storage.
                key={setup ? `setup:${setup.importId}` : "manual"}
                tenantId={account.tenantId}
                clientId={account.clientId}
                localOnly={method !== "ownApp"}
                onboarding
                initial={setup && setup.connection.tenantId === account.tenantId.toLowerCase() ? setup.connection.storage : undefined}
                onChange={setChoice}
                onBlockerChange={setStorageBlocker}
              />
              <div className="flex flex-col items-center gap-3 text-center">
                {!choice && storageBlocker && <p role="status" className="text-sm text-gray-600">{storageBlocker}</p>}
                <Button className={onboardingPrimary} disabled={!choice || creating || checkingResume || checkingPermissions || nothingReadable} onClick={() => void createTenant()}>
                  {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                  {creating ? "Checking the license..." : "Start first backup"}
                </Button>
                {status?.tenantTrialsEnabled && <p className="text-xs text-muted-foreground">Eligible tenants start with a Pro trial.</p>}
                {(choice || !storageBlocker) && resumeMessage}
              </div>
              <div className="flex flex-wrap items-start justify-center gap-x-5 gap-y-2">
                {connectedTenant}
                <details className="text-center text-xs open:w-full">
                  <summary className={cn("cursor-pointer", onboardingLink)}>Plan details</summary>
                  <div className="mt-2 text-left"><PlanContext tenantId={account.tenantId} username={account.username} /></div>
                </details>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 text-center">
              <OnboardingHeading id="setup-step-3"
                title={succeeded ? "Your first backup is done" : hasBackupTypes ? "Your first backup" : "Your tenant is connected"}
                icon={succeeded ? <CheckCircle2 /> : <HardDriveDownload />} success={succeeded}
                subtitle={succeeded ? (tenantName ? `Backup saved for ${tenantName}.` : undefined)
                  : hasBackupTypes ? (firstBackupLabel ? `Backing up ${firstBackupLabel}.` : "TenuVault starts your first backup automatically.")
                  : `You can change your saved choice of ${choiceLabel(services)} in Settings.`} />
              {backupSummary && displayJob && <dl className="grid grid-cols-3 divide-x divide-border rounded-2xl bg-secondary/60 py-3">
                {[
                  ["Policies saved", String(backupSummary.policies)],
                  ["Types backed up", String(backupSummary.typesBackedUp)],
                  ["Duration", formatBackupDuration(displayJob.startTime, displayJob.endTime) || "Unavailable"],
                ].map(([label, value]) => <div key={label} className="flex flex-col-reverse gap-1 px-1">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums sm:text-xl">{value}</dd>
                </div>)}
              </dl>}
              {succeeded && displayJob && <span role="status" className="sr-only">{displayJob.progressMessage}</span>}
              {succeeded && displayJob && (displayJob.results
                ? <BackupResults job={displayJob} view="notices" />
                : completedWithWarnings(displayJob) && <NoticeCard summary="The first backup completed with warnings." tone="warning" />)}
              {setup && credentials && setup.connection.tenantId === credentials.tenantId.toLowerCase() && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-gray-700">
                  <p>The setup file holds more settings, such as services and what is backed up. Review them to apply them to future backups.</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void navigate(`/portal/settings?section=transfer&import=${encodeURIComponent(setup.importId)}`)}>
                    Review settings from the file
                  </Button>
                </div>
              )}
              {jobError && (
                <p role="alert" className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                  <XCircle className="h-4 w-4" /> {jobError}
                </p>
              )}
              {displayJob && !succeeded && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-gray-800">
                      <JobStateIcon job={displayJob} />
                      {displayJob.exception ?? displayJob.progressMessage}
                    </span>
                    {/* Announces the result once, not every progress tick. */}
                    <span role="status" className="sr-only">{displayJob.isComplete ? displayJob.exception ?? displayJob.progressMessage : ""}</span>
                    <span className="text-gray-500">{displayJob.progress}%</span>
                  </div>
                  <Progress value={displayJob.progress} className="h-2" aria-label="First backup progress" />
                  {!displayJob.isComplete && runningJobId && (
                    <button type="button" className={onboardingLink} disabled={cancelling} onClick={() => void cancelBackup()}>
                      {cancelling ? "Cancelling…" : "Cancel backup"}
                    </button>
                  )}
                  {finished && <div className="text-left"><BackupResults job={displayJob} jobId={runningJobId} /></div>}
                </div>
              )}
              {backupFailed && <SetupCallLink source="first-backup-error" variant="hint" />}
              <div className="flex flex-col items-center gap-3">
                {succeeded ? (
                  <Button className={onboardingPrimary} onClick={() => void navigate("/portal/dashboard")}>
                    Go to dashboard
                  </Button>
                ) : finished ? (
                  <>
                    <Button className={onboardingPrimary} onClick={() => void runBackup()}>
                      <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
                    </Button>
                    <button type="button" className={onboardingLink} onClick={() => void navigate("/portal/backup")}>
                      Go to Backup &amp; Restore
                    </button>
                  </>
                ) : !displayJob && (
                  <>
                    {hasBackupTypes && <Button className={onboardingPrimary} onClick={() => void runBackup()}>
                      <Play className="mr-2 h-4 w-4" /> Run first backup
                    </Button>}
                    <button type="button" className={onboardingLink} onClick={() => void navigate("/portal/dashboard")}>
                      Skip for now
                    </button>
                  </>
                )}
              </div>
              {succeeded && credentials && <FirstBackupNextSteps tenantId={credentials.tenantId} plan={plan} local={!credentials.storageAccountName || credentials.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)} />}
              {succeeded && displayJob && (displayJob.results || displayJob.output) && <details>
                <summary className={cn("cursor-pointer", onboardingLink)}>See backup details</summary>
                <div role="region" aria-label="First backup results" tabIndex={0} className="mt-3 max-h-56 overflow-y-auto text-left">
                  <BackupResults job={displayJob} jobId={runningJobId} hideStats view="details" />
                </div>
              </details>}
              {displayJob && !finished && <div className="space-y-1 text-xs text-muted-foreground">
                <p>Read-only backup. Large tenants can take longer.</p>
                <p>{services.intune ? "Apps are excluded by default. " : ""}Restores use the policies saved in a backup.</p>
                {displayJob.output && <div className="text-left"><BackupResults job={{ ...displayJob, results: undefined }} jobId={runningJobId} /></div>}
              </div>}
            </div>
          )}
          {step < 2 && resumeMessage && <div className="mt-4">{resumeMessage}</div>}
        </div>
        {succeeded && <SetupDiagnosticsCard />}
      </div>
    </div>
  )
}

/** What a setup file fills in, shown in full before the admin signs in, because a file can come from anyone. */
function SetupFileNotice({ connection }: { connection: SetupConnection }) {
  return (
    <div role="note" className="space-y-1 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> From a setup file</p>
      <details><summary className="cursor-pointer underline">Connection details</summary><p>Tenant <span className="font-mono">{connection.tenantId}</span>, app registration <span className="font-mono">{connection.clientId}</span>{connection.storage?.kind === "azure" ? <>, storage account <span className="font-mono">{connection.storage.storageAccountName}</span></> : null}.</p></details>
      <p>Use a setup file only from an admin you trust: it decides which app registration you sign in to and where backups are stored. You sign in with your own account.</p>
    </div>
  )
}
