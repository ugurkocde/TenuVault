import { BackupCoverage } from "../components/BackupCoverage"
import { OnboardingSignIn, type MethodAvailability } from "../components/OnboardingSignIn"
import { TenuVaultConsent } from "../components/TenuVaultConsent"
import { GRAPH_CLI_CONSENT_WARNING, GRAPH_CLI_UPGRADE, OWN_APP_UPGRADE, SIGN_IN_METHODS, type BackupScopeCoverage, type SignInMethod, type WizardSignInResult } from "../../shared/tenant-connection"
import { DISPLAY_MODULE_ORDER } from "../../shared/services/presentation"
import { tenantPermissionPacks } from "../../shared/services/permission-packs"
import { isGuid } from "../../shared/security"
import { serializeTenants } from "~/lib/tenant-state"
import { Input } from "~/components/ui/input"
import { OnboardingServices } from "../components/OnboardingServices"
import { PermissionRoutes } from "../components/ServicesSettings"
import { checkedOnboardingChoice, choiceLabel, hasOnboardingBackups } from "../../shared/services/onboarding"
import { areaPermissions, type PermissionChoice } from "../../shared/services/manifest"
import { chosenBackupCoverage } from "../../shared/services/graph-cli-coverage"
import { MODULE_BY_ID, moduleForFolder } from "../../shared/services/modules"
import { trialKeyRefusalText } from "../../shared/trial-notices"
import { showCommunityLimitError } from "../lib/plan-dialog"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { AlertTriangle, ArrowLeft, ArrowRight, Ban, Cable, CheckCircle2, Database, FileUp, HardDriveDownload, KeyRound, Loader2, Play, RotateCcw, ShieldCheck, XCircle } from "lucide-react"
import { useSelectedTenant, useTenantOperations, useTenants } from "~/contexts/TenantContext"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"
import type { RegistrationResult, SignedInAccount } from "../../shared/ipc"
import type { AppearanceSetting, SetupConnection, TransferPreview } from "../../shared/settings-transfer"
import { LOCAL_STORAGE_PREFIX, TRIAL_USED_MESSAGE } from "../../shared/constants"
import { TrialKeyRefusalActions, TrialShortcuts } from "../components/TenantTrial"
import { StorageChooser } from "../components/StorageChooser"
import { FirstBackupNote } from "../components/FirstBackupNote"
import { FirstBackupNextSteps } from "../components/FirstBackupNextSteps"
import { PlanContext, TrialOrKey } from "../components/PlanChoice"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { ConnectTenantSetup } from "../components/ConnectTenantSetup"
import { SetupCallHintShown, SetupCallLink } from "../components/SetupCallLink"
import { recordSetup, SetupDiagnosticsReminder } from "../components/SetupDiagnostics"
import { TenantSignInForm, type SignInFields } from "../components/TenantSignInForm"
import { bridge } from "../lib/bridge"
import { buildTenantProfile } from "../lib/desktop-tenant"
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft } from "../lib/onboarding-draft"
import type { StorageChoice } from "../lib/storage"
import { desktopTenantCredentials, type TenantCredentials } from "../overrides/add-tenant-modal"
import { completedWithWarnings, resolveBackupJobDisplay, toBackupJobDisplay, type BackupJobDisplay } from "~/lib/backup-job-display"
import { BackupResults } from "~/components/backup/backup-results"

/** Whether a sign-in is to the tenant and app registration a setup file names. */
function sameRegistration(account: SignedInAccount, connection: SetupConnection): boolean {
  return account.tenantId.toLowerCase() === connection.tenantId.toLowerCase() && account.clientId.toLowerCase() === connection.clientId.toLowerCase()
}

// The theme the setup file preview compares against. Read here and not through lib/appearance,
// whose module applies the theme when it loads.
/** A service choice setup can continue with: valid and naming at least one service. */
function confirmedChoice(choice: PermissionChoice): boolean {
  try { return Object.keys(checkedOnboardingChoice(choice)).length > 0 } catch { return false }
}

function currentAppearance(): AppearanceSetting {
  try {
    const value = localStorage.getItem("tenuvault-appearance")
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

const STEPS = [
  { title: "Services", icon: ShieldCheck },
  { title: "Connect method", icon: Cable },
  { title: "Sign in", icon: KeyRound },
  { title: "Results", icon: CheckCircle2 },
  { title: "Storage", icon: Database },
  { title: "First backup", icon: HardDriveDownload },
]

type JobStatus = BackupJobDisplay
type Step = -2 | -1 | 0 | 1 | 2 | 3 | 4
type PermissionResult = { missing: string[]; error?: string; coverage?: BackupScopeCoverage[] }

const EMPTY_METHODS: MethodAvailability = { graphCli: null, tenuvaultApp: null }

/** The first backup's state: running, completed, cancelled by the user (grey) or failed. */
export function JobStateIcon({ job }: { job: Pick<JobStatus, "isComplete" | "isSuccessful" | "status" | "progressMessage" | "results"> }) {
  if (!job.isComplete) return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (completedWithWarnings(job)) return <AlertTriangle className="h-4 w-4 text-amber-700" />
  if (job.isSuccessful) return <CheckCircle2 className="h-4 w-4 text-green-600" />
  return job.status === "Cancelled" ? <Ban className="h-4 w-4 text-gray-500" /> : <XCircle className="h-4 w-4 text-red-600" />
}

function StepHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} tabIndex={-1} className="text-xl font-medium tracking-tight text-gray-900 outline-none">{children}</h2>
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
  const { addTenant, updateTenant } = useTenantOperations()
  const { setSelectedTenantId } = useSelectedTenant()
  const [initial] = useState(loadOnboardingDraft)
  const [step, setStep] = useState<Step>(initial?.step ?? -1)
  const [services, setServices] = useState<PermissionChoice>(initial?.services ?? {})
  // A saved choice that could not be read must be confirmed with Continue on the service step; picking a
  // service there is not enough, so a setup file that arrives meanwhile waits for that Continue.
  const reconfirm = useRef(initial?.reconfirm === true || !confirmedChoice(initial?.services ?? {}))
  const [permissionCheck, setPermissionCheck] = useState<{ account: SignedInAccount; services: PermissionChoice; result: PermissionResult } | null>(null)
  const [method, setMethod] = useState<SignInMethod>("ownApp")
  const [available, setAvailable] = useState(EMPTY_METHODS)
  const [publicTenant, setPublicTenant] = useState("")
  const [publicBusy, setPublicBusy] = useState(false)
  const [publicError, setPublicError] = useState("")
  const [sharedSignIn, setSharedSignIn] = useState<WizardSignInResult | null>(null)
  const [upgradeTenant, setUpgradeTenant] = useState<string>()
  const [handoffPack, setHandoffPack] = useState<string>()
  const sharedDraft = useRef<string | undefined>(undefined)
  const packPlan = useMemo(() => ({ packs: method === "tenuvaultApp" && confirmedChoice(services)
    ? tenantPermissionPacks(services, { azure: false, audit: false }) : [] }), [method, services])
  const permissionGeneration = useRef(0)
  const [fields, setFields] = useState<SignInFields>({ tenant: initial?.tenant ?? "", clientId: initial?.clientId ?? "", displayName: initial?.displayName ?? "" })
  const [account, setAccount] = useState<SignedInAccount | null>(initial?.account ?? null)
  const permissionResult = permissionCheck?.account === account && permissionCheck?.services === services ? permissionCheck.result : null
  const reviewPermissions = step === 4 || step === 2
  const checkingPermissions = Boolean(account && method === "ownApp" && reviewPermissions && !permissionResult)
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
  const [heldSetup, setHeldSetup] = useState<{ importId: string; connection: SetupConnection } | null>(null)
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
      setServices({})
      setResumed(false)
      setStep(-1)
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
    else if (method === "ownApp") saveOnboardingDraft({ step, ...fields, account, services, ...(reconfirm.current ? { reconfirm: true } : {}) })
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

  // Each step starts at its heading, for keyboard and screen reader users too.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; if (step !== -1 && step !== -2) return }
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
  const switchTenant = async () => {
    if (!account) return
    resumeCheck.current = false
    setReleasing(true)
    setAddError(null)
    try {
      releasingAccount.current = true
      try { if (!connected(account.tenantId)) await bridge.license.releaseTenant(account.tenantId) } finally { releasingAccount.current = false }
      setAccount(null)
      setChoice(null)
      // With a setup file for another tenant open, the form starts with the file's IDs.
      if (setup && !sameRegistration(account, setup.connection)) setFields({ tenant: setup.connection.tenantId, clientId: setup.connection.clientId, displayName: setup.connection.name })
      setStep(1)
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
    const one = missing.length === 1
    setSetupNotice([
      reusedNotice || (result.ready ? "The app registration is ready." : ""),
      several ? `It is one of ${result.candidateCount} in this tenant.` : "",
      missing.length ? `It has no tenant-wide admin consent for ${one ? "one permission" : `${missing.length} permissions`} TenuVault uses by default: ${missing.join(", ")}. TenuVault did not change it, and what needs ${one ? "this permission" : "these permissions"} does not work until an administrator grants ${one ? "it" : "them"} under Entra admin center > App registrations > ${result.displayName} > API permissions.` : "",
      result.ready ? (paused ? "To use it, select Sign in with Microsoft." : "") : pending,
      several ? 'To use another one, select Previous, then "I already have an app registration" and enter its client ID.' : "",
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
    // A saved choice that had to be confirmed again keeps the file waiting on the service step; its
    // Continue then runs this again with the confirmed choice.
    if (reconfirm.current || !confirmedChoice(services)) {
      setHeldSetup({ importId, connection })
      if (!account) {
        const next = { tenant: connection.tenantId, clientId: connection.clientId, displayName: connection.name }
        setFields(next)
        saveOnboardingDraft({ step: -1, ...next, account: null, services, ...(reconfirm.current ? { reconfirm: true } : {}) })
      }
      setStep(-1)
      return
    }
    setHeldSetup(null)
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

  // The Connect step shows what a setup file could not do. A service choice that has to be confirmed
  // again comes first: its step shows the error, and its Continue then opens Connect.
  const showConnect = () => {
    setStep(current => current === -1 && !reconfirm.current && confirmedChoice(latest.current.services) ? 0 : current)
  }

  /** The tenants of a settings file that can be connected from it: with connection details and not connected yet. */
  const setupFrom = (preview: TransferPreview) => {
    const connections = preview.groups.flatMap((group) => (group.setup && !group.connected ? [group.setup] : []))
    if (connections.length === 0) {
      setSetupError("This file has no connection details for a tenant that is not connected yet. Ask the other admin to export it again with Include connection details.")
      showConnect()
    } else if (connections.length === 1) {
      continueWithSetup(preview.importId, connections[0]!)
    } else {
      setSetupError("")
      setSetupChoices({ importId: preview.importId, connections })
      showConnect()
    }
  }

  // A file is read asynchronously; what it does is decided with the state of when it arrives, such as
  // a resumed sign-in the check above turned out to be gone.
  const latest = useRef({ continueWithSetup, setupFrom, services })
  latest.current = { continueWithSetup, setupFrom, services }

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
        showConnect()
      } else latest.current.setupFrom(preview)
    }, (error: unknown) => {
      setSetupError(error instanceof Error ? error.message : String(error))
      showConnect()
    })
  }, [requestedSetup, requestedTenant, checkingResume])

  const discardShared = () => {
    if (sharedDraft.current) void bridge.auth.wizardDiscard(sharedDraft.current).catch(() => undefined)
    sharedDraft.current = undefined
    setSharedSignIn(null)
  }

  const chooseMethod = async (next: SignInMethod, forTenant?: string, pack?: string) => {
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
    if (forTenant && sharedSignIn?.account.tenantId === forTenant) setSharedSignIn(null)
    else discardShared()
    setAccount(null)
    setChoice(null)
    setPublicError("")
    setAddError(null)
    setMethod(next)
    setUpgradeTenant(forTenant)
    setHandoffPack(pack)
    setPublicTenant(forTenant ?? "")
    setFields({ tenant: forTenant ?? "", clientId: "", displayName: "" })
    setSetup(null)
    setHeldSetup(null)
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

  const signInStartNow = async () => {
    if (publicBusy || !isGuid(publicTenant.trim())) return
    setPublicBusy(true)
    setPublicError("")
    try {
      const outcome = await bridge.auth.wizardStage(publicTenant.trim(), "graphCli")
      if ("error" in outcome) {
        if (mounted.current) {
          setPublicError(outcome.error.message.replace(" in Sign-in and access.", "."))
          setStep(4)
        }
      } else signedInShared(outcome.result)
    } catch {
      if (mounted.current) setPublicError("Could not sign in with Start now. Try again or choose another method.")
    } finally { if (mounted.current) setPublicBusy(false) }
  }

  // The license is checked before the tenant is saved. A
  // tenant the license does not cover is not added and its sign-in is removed in the main
  // process, so the admin signs in again with the same IDs once the license is sorted.
  const createTenant = async () => {
    if (creatingRef.current || !account || !choice || checkingResume || checkingPermissions || (method !== "ownApp" && !sharedSignIn)) return
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
      const tenant = { ...(await buildTenantProfile(creds, method === "ownApp")), createdAt: new Date().toISOString() }
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
  // A backup that could not start or ended with an error. Cancelling is the admin's own choice, and
  // an error next to a backup that is on screen is a failed cancel, not a failed backup.
  const backupFailed = (Boolean(jobError) && !displayJob) || (finished && !succeeded && displayJob?.status !== "Cancelled")
  // The license refusal that sent the admin back to the Sign in step leaves them stuck there. A
  // tenant that is already connected has its own way on, and a message of the Storage step that
  // is still set after Previous is not an error of this step.
  const signInStuck = Boolean(addError?.license)
  const stageIndex = step === 3 ? 5 : step === 2 ? 4 : step === 4 ? 3 : step === -2 ? 1 : step === -1 ? 0 : 2
  const rawCoverage = sharedSignIn?.coverage ?? permissionResult?.coverage ?? []
  const coverage = method === "graphCli"
    ? chosenBackupCoverage(rawCoverage, services)
    : rawCoverage.filter(row => services[row.service] || (row.service === "entra" && services.conditionalAccess))
  const missing = permissionResult?.missing ?? []
  const unreadable = coverage.flatMap(({ folders, readable }) => readable === null ? [] : folders.filter(folder => !readable.includes(folder)))
  const hasScopeGaps = unreadable.length > 0
  const unknownCoverage = !coverage.length || coverage.some(row => row.readable === null)
  const targetTenant = account?.tenantId ?? publicTenant.trim()
  const canUpgrade = method === "graphCli"
  const needsPack = DISPLAY_MODULE_ORDER.find(id => {
    const picked = services[id]
    if (!picked) return false
    const missingForService = missing.length > 0 && MODULE_BY_ID.get(id)?.areas.some(area =>
      (!area.optIn || picked.areas?.includes(area.id)) &&
      areaPermissions(area, picked.access, "delegated").some(scope => missing.includes(scope)))
    if (missingForService) return true
    return coverage.some(row => row.folders.some(folder => moduleForFolder(folder)?.module.id === id && !row.readable?.includes(folder)))
  })
  const missingPack = needsPack ? `${needsPack}-${services[needsPack]?.access ?? "backup"}` : "basics"
  const openSetupAction = <div className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-gray-700">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p>Another admin sent you a setup file?</p>
      <Button type="button" variant="outline" size="sm" disabled={openingSetup || releasing || checkingResume} onClick={() => void openSetupFile()}>
        {openingSetup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <FileUp className="mr-2 h-4 w-4" aria-hidden="true" />}Set up from a file
      </Button>
    </div>
    {setupError && <p role="alert" className="text-red-700">{setupError}</p>}
    {setupChoices && <div className="space-y-2">
      <p className="font-medium text-gray-900">Which tenant do you want to connect?</p>
      <ul className="space-y-2">{setupChoices.connections.map(connection => <li key={connection.tenantId}>
        <Button type="button" variant="outline" size="sm" onClick={() => continueWithSetup(setupChoices.importId, connection)}>{connection.name} <span className="ml-2 font-mono text-xs text-gray-500">{connection.tenantId}</span></Button>
      </li>)}</ul>
    </div>}
  </div>

  return (
    <div className={cn("@container mx-auto space-y-4 p-5 lg:p-6", step <= 0 || step === 4 ? "max-w-[96rem]" : step === 2 ? "max-w-6xl" : "max-w-3xl")}>
      {tenants.length > 0 && (
        <Link to="/portal/dashboard" className="group inline-flex items-center gap-3 rounded-full text-sm font-medium text-gray-600 hover:text-gray-900">
          <span className="flex size-10 items-center justify-center rounded-full bg-card transition-colors group-hover:bg-secondary" aria-hidden="true"><ArrowLeft className="h-4 w-4" /></span> Back to dashboard
        </Link>
      )}
      <div className={cn("grid items-start gap-2", step < 0 ? "@5xl:grid-cols-[1fr_auto]" : "@3xl:grid-cols-[1fr_auto]")}>
      <div className="contents">
        <h1 className="whitespace-nowrap text-3xl font-medium tracking-tight text-gray-900 @5xl:text-4xl">Set up TenuVault</h1>

      </div>

      <ol className="grid grid-cols-3 gap-1 @lg:grid-cols-6 @5xl:pt-1" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            aria-current={i === stageIndex ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2.5 text-sm font-medium @5xl:pr-4",
              i === stageIndex ? "bg-primary text-primary-foreground" : i < stageIndex ? "bg-green-50 text-green-700" : "bg-card text-muted-foreground",
            )}
          >
            <span className={cn("flex size-7 flex-shrink-0 items-center justify-center rounded-full", i === stageIndex ? "bg-coral-500 text-white" : "bg-secondary")} aria-hidden="true">
              {i < stageIndex ? <CheckCircle2 className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
            </span>
            <span className="truncate">{s.title}</span>
            <span className="sr-only">{i < stageIndex ? " (done)" : i === stageIndex ? ` (step ${i + 1} of ${STEPS.length})` : ""}</span>
          </li>
        ))}
      </ol>
      </div>

      {resumed && step !== 3 && (
        <p role="status" className="rounded-2xl bg-blue-50/60 px-4 py-3 text-sm text-gray-700">
          Welcome back. You can continue where you left off{account ? `, signed in as ${account.username}` : ""}.
        </p>
      )}

      <div className="@container rounded-3xl bg-card p-5 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        {step === -2 && <div className="space-y-4"><OnboardingSignIn available={available} choice={services} onChoose={chooseMethod} />{openSetupAction}</div>}
        {step === -1 && <OnboardingServices choice={services} onChange={choice => { reconfirm.current = true; setServices(choice) }} onContinue={() => {
          reconfirm.current = false
          if (heldSetup) continueWithSetup(heldSetup.importId, heldSetup.connection)
          else setStep(-2)
        }} />}
        {step === -1 && (setupError || setupChoices) && openSetupAction}
        {/* A file handed over from Settings can fail on any step, for example after its review expired. */}
        {step > 0 && setupError && (
          <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {setupError} Open the file again in Settings, under Import and export, or select Set up from a file in the wizard.
          </p>
        )}
        {step === 0 && method === "ownApp" && (
          <div className="space-y-4">
            <StepHeading id="setup-step-0">Connect your tenant</StepHeading>
            <ConnectTenantSetup
              choice={services}
              expectedTenant={upgradeTenant}
              onRunningChange={setSetupRunning}
              trials={Boolean(status?.tenantTrialsEnabled)}
              onManual={() => { setSetupNotice(""); setAutoSignIn(null); setStep(1) }}
              onRegistered={(result) => { if (attempt === currentAttempt.current) void registered(result, attempt) }}
            />
            {openSetupAction}
          </div>
        )}

        {step === 1 && method !== "ownApp" && (
          <div className="space-y-4">
            <StepHeading id="setup-step-1">{SIGN_IN_METHODS[method]}</StepHeading>
            {method === "graphCli" && <p className="rounded-xl bg-blue-50 p-3 text-sm text-gray-700">{GRAPH_CLI_CONSENT_WARNING}</p>}
            {method === "tenuvaultApp" && <p className="text-sm text-gray-600">Review the permission packs for your chosen services, then sign in.</p>}
            <label className="block space-y-1 text-sm font-medium">Tenant ID
              <Input value={publicTenant} disabled={publicBusy || Boolean(upgradeTenant)} onChange={event => setPublicTenant(event.target.value)} placeholder="Directory (tenant) ID" aria-describedby="public-tenant-help" />
              <span id="public-tenant-help" className="block text-xs font-normal text-gray-600">Find Tenant ID on the Overview page in the Microsoft Entra admin center.</span>
            </label>
            {publicError && <p role="alert" className="text-sm text-red-700">{publicError}</p>}
            {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
            <div className="flex flex-wrap gap-2">
              {method === "graphCli" ? <>
                <Button onClick={() => void signInStartNow()} disabled={publicBusy || !isGuid(publicTenant.trim())}>{publicBusy ? "Waiting for Microsoft" : "Sign in with Start now"}</Button>
                {publicBusy && <Button variant="outline" onClick={() => void bridge.auth.cancelSignIn()}>Cancel sign-in</Button>}
              </> : packPlan.packs.length > 0 && isGuid(publicTenant.trim()) &&
                <TenuVaultConsent key={publicTenant.trim()} tenantId={publicTenant.trim()} plan={packPlan} active={false} wizard={{ choice: services, pack: handoffPack, onSignedIn: signedInShared }} />}
            </div>
          </div>
        )}

        {step === 1 && method === "ownApp" && (
          <div className="space-y-4">
            <StepHeading id="setup-step-1">Sign in to your tenant</StepHeading>
            {status?.tenantTrialsEnabled && <p className="text-sm text-gray-600">New tenants start with a Pro trial. No card and no email needed.</p>}
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
            {/* Shown only when the setup ended with a problem it reported, such as missing admin consent. */}
            {setupNotice && !account && <SetupDiagnosticsReminder step="setup" />}
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
                <p className="flex items-center gap-2 rounded-full bg-green-50 px-4 py-2.5 text-sm text-green-800">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Signed in as {account.username}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => void switchTenant()} disabled={releasing}>
                    {releasing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                    Use a different tenant or account
                  </Button>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setStep(4)} disabled={releasing}>
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
                  expectedTenant={upgradeTenant}
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
                    if (upgradeTenant && signedIn.tenantId.toLowerCase() !== upgradeTenant.toLowerCase()) {
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
          <section className="space-y-4" aria-labelledby="setup-step-4">
            <StepHeading id="setup-step-4">Sign-in results</StepHeading>
            {publicError && <p role="alert" className="text-sm text-red-700">{publicError}</p>}
            {account && <p className="text-sm text-gray-600">Signed in as {account.username}</p>}
            {checkingPermissions || checkingResume ? <p role="status" className="text-sm text-gray-600">Checking permissions for your chosen services…</p> : <>
              {method === "graphCli" && <p className="text-sm text-gray-600">Start now uses the backup permissions your sign-in already has. Restore is unavailable.</p>}
              <BackupCoverage coverage={coverage} />
              <p className="text-sm text-gray-600">Coverage shows what your permissions allow. If your role can't do this, the first backup reports the refusal separately from missing permissions.</p>
              {(hasScopeGaps || missing.length > 0) && <p className="text-sm text-gray-700">Permission not granted for some of your chosen backup or restore types.</p>}
              {unknownCoverage && account && <p className="text-sm text-gray-700">Some coverage is unknown.</p>}
              {method === "ownApp" && permissionResult && (missing.length > 0 || permissionResult.error) && <div className="space-y-2 rounded-xl border p-3 text-sm text-gray-700">
                {permissionResult.error && <p>Permissions could not be checked. You can continue to storage or check again.</p>}
                <SetupCallLink source="signin-error" variant="hint" />
                <PermissionRoutes report={account!} missing={missing} />
                <Button variant="outline" onClick={() => { if (account) setAccount({ ...account }) }}>Check again</Button>
              </div>}
              <div className="flex flex-wrap gap-2">
                {method !== "tenuvaultApp" && available.tenuvaultApp === true && isGuid(targetTenant) && (canUpgrade || hasScopeGaps || missing.length > 0) &&
                  <Button variant="outline" disabled={releasing} onClick={() => void chooseMethod("tenuvaultApp", targetTenant)}>{GRAPH_CLI_UPGRADE}</Button>}
                {method !== "ownApp" && <Button variant="outline" disabled={releasing} onClick={() => void chooseMethod("ownApp", isGuid(targetTenant) ? targetTenant : undefined)}>{OWN_APP_UPGRADE}</Button>}
                {available.tenuvaultApp === true && method !== "tenuvaultApp" && isGuid(targetTenant) && confirmedChoice(services) && (hasScopeGaps || unknownCoverage || missing.length > 0) &&
                  <Button variant="outline" disabled={releasing} onClick={() => void chooseMethod("tenuvaultApp", targetTenant, missingPack)}>Send to my admin</Button>}
                {account && <Button className="ml-auto" disabled={releasing} onClick={() => setStep(2)}>Continue to storage</Button>}
              </div>
            </>}
          </section>
        )}

        {step === 2 && account && (
          <div className="space-y-4">
            <StepHeading id="setup-step-2">Choose where backups are stored</StepHeading>
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <CheckCircle2 className="h-4 w-4 text-green-700" aria-hidden="true" /> Signed in as {account.username}
            </p>
            {checkingPermissions && <p role="status" className="text-sm text-gray-600">Checking permissions for your chosen services…</p>}
            {method === "graphCli" && <p className="text-sm text-gray-600">Start now keeps backups on this device.</p>}
            {method === "tenuvaultApp" && <p className="text-sm text-gray-600">The first backup is stored on this device.</p>}
            {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
            {setup?.connection.storage && setup.connection.tenantId === account.tenantId.toLowerCase() && (
              <p className="text-sm text-gray-600">The setup file chose {setup.connection.storage.kind === "local" ? "This device" : `the storage account ${setup.connection.storage.storageAccountName}`}. {setup.connection.storage.kind === "azure" ? "Select Check access to confirm you can use it." : ""}</p>
            )}
            <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <StorageChooser
                // A setup file opened while this step shows starts the chooser again with the file's storage.
                key={setup ? `setup:${setup.importId}` : "manual"}
                tenantId={account.tenantId}
                clientId={account.clientId}
                localOnly={method !== "ownApp"}
                initial={setup && setup.connection.tenantId === account.tenantId.toLowerCase() ? setup.connection.storage : undefined}
                onChange={setChoice}
                onBlockerChange={setStorageBlocker}
              />
              <PlanContext tenantId={account.tenantId} username={account.username} />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!choice && storageBlocker && <p role="status" className="text-sm text-gray-600">{storageBlocker}</p>}
              <Button className="bg-blue-600 hover:bg-blue-700" disabled={!choice || creating || checkingResume || checkingPermissions} onClick={() => void createTenant()}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {creating ? "Checking the license..." : "Continue"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <StepHeading id="setup-step-3">{succeeded ? "Your first backup is done" : hasBackupTypes ? "Your first backup" : "Your tenant is connected"}</StepHeading>
            {!hasBackupTypes && <p className="text-sm text-gray-700">Your choice of {choiceLabel(services)} is saved. There are no backup types for this choice. You can change services in Settings.</p>}
            {!succeeded && hasBackupTypes && (
              <div className="space-y-2 text-sm text-gray-700">
                <p>{tenantName ? `${tenantName} is connected.` : "Your tenant is connected."} TenuVault starts a backup of your chosen services automatically.</p>
                <ul className="list-disc space-y-1 pl-5 text-gray-600">
                  <li>It reads the available policies and settings for {choiceLabel(services)}, and changes nothing in your tenant.</li>
                  {services.intune && <li>Apps are left out by default to keep it quick. You can change what is backed up later in the backup scope.</li>}
                  {services.entra && <li>Entra ID backs up the supported types in your selected areas. Areas without backup types are listed in Services and permissions.</li>}
                  <li>It usually takes a few minutes, longer for large tenants.</li>
                  <li>A restore needs a backup from before the change, so this first backup cannot bring back a policy already lost. It protects what you back up from now on.</li>
                </ul>
              </div>
            )}
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
            {displayJob && (
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
                <Progress value={displayJob.progress} />
                {!displayJob.isComplete && runningJobId && (
                  <Button variant="outline" disabled={cancelling} onClick={() => void cancelBackup()}>
                    {cancelling ? "Cancelling…" : "Cancel backup"}
                  </Button>
                )}
                {succeeded && <FirstBackupNote plan={plan} />}
                <BackupResults job={displayJob} jobId={runningJobId} />
              </div>
            )}
            {succeeded && credentials && <TrialShortcuts tenantId={credentials.tenantId} />}
            {succeeded && credentials && <FirstBackupNextSteps tenantId={credentials.tenantId} plan={plan} local={!credentials.storageAccountName || credentials.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)} />}
            {backupFailed && <SetupCallLink source="first-backup-error" variant="hint" />}
            <div className="flex flex-wrap justify-end gap-2">
              {succeeded ? (
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void navigate("/portal/dashboard")}>
                  Go to dashboard
                </Button>
              ) : finished ? (
                <>
                  <Button variant="outline" onClick={() => void navigate("/portal/backup")}>
                    Go to Backup &amp; Restore
                  </Button>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void runBackup()}>
                    <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" /> Try again
                  </Button>
                </>
              ) : !displayJob && (
                <>
                  <Button variant="outline" onClick={() => void navigate("/portal/dashboard")}>
                    Skip for now
                  </Button>
                  {hasBackupTypes && <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void runBackup()}>
                    <Play className="mr-2 h-4 w-4" /> Run first backup
                  </Button>}
                </>
              )}
            </div>
          </div>
        )}

        {step !== -1 && step !== 3 && (
          <div className="mt-6 border-t border-gray-100 pt-4">
            <Button variant="ghost" onClick={() => {
              if (step === 2) setStep(4)
              else if (step === 4) {
                if (method !== "ownApp") { discardShared(); setAccount(null) }
                setStep(1)
              }
              else if (step === 1 && method === "ownApp") setStep(0)
              else if (step === -2) setStep(-1)
              else {
                if (method !== "ownApp") { discardShared(); setAccount(null); setMethod("ownApp") }
                setStep(-2)
              }
            }} disabled={creating || releasing || setupRunning || publicBusy}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Previous
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** What a setup file fills in, shown in full before the admin signs in, because a file can come from anyone. */
function SetupFileNotice({ connection }: { connection: SetupConnection }) {
  return (
    <div role="note" className="space-y-1 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> From a setup file</p>
      <p>Tenant <span className="font-mono">{connection.tenantId}</span>, app registration <span className="font-mono">{connection.clientId}</span>{connection.storage?.kind === "azure" ? <>, storage account <span className="font-mono">{connection.storage.storageAccountName}</span></> : null}.</p>
      <p>Use a setup file only from an admin you trust: it decides which app registration you sign in to and where backups are stored. You sign in with your own account.</p>
    </div>
  )
}
