import { showCommunityLimitError } from "../lib/plan-dialog"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowLeft, ArrowRight, Ban, CheckCircle2, Database, HardDriveDownload, KeyRound, Loader2, Play, RotateCcw, ShieldCheck, XCircle } from "lucide-react"
import { useSelectedTenant, useTenantOperations, useTenants } from "~/contexts/TenantContext"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"
import type { SignedInAccount } from "../../shared/ipc"
import { LOCAL_STORAGE_PREFIX, TRIAL_USED_MESSAGE } from "../../shared/constants"
import { TrialKeyRefusalActions } from "../components/TenantTrial"
import { StorageChooser } from "../components/StorageChooser"
import { FirstBackupNote } from "../components/FirstBackupNote"
import { FirstBackupNextSteps } from "../components/FirstBackupNextSteps"
import { PlanContext, TrialOrKey } from "../components/PlanChoice"
import { tenantLicense, tenantPlan, useLicense, useTenantPlan } from "../lib/license"
import { SetupScriptCard, TenantSignInForm, type SignInFields } from "../components/TenantSignInForm"
import { bridge } from "../lib/bridge"
import { buildTenantProfile } from "../lib/desktop-tenant"
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft } from "../lib/onboarding-draft"
import type { StorageChoice } from "../lib/storage"
import { desktopTenantCredentials, type TenantCredentials } from "../overrides/add-tenant-modal"
import { resolveBackupJobDisplay, toBackupJobDisplay, type BackupJobDisplay } from "~/lib/backup-job-display"

const STEPS = [
  { title: "Prepare", icon: ShieldCheck },
  { title: "Sign in", icon: KeyRound },
  { title: "Storage", icon: Database },
  { title: "First backup", icon: HardDriveDownload },
]

type JobStatus = BackupJobDisplay
type Step = 0 | 1 | 2 | 3

/** The first backup's state: running, completed, cancelled by the user (grey) or failed. */
export function JobStateIcon({ job }: { job: Pick<JobStatus, "isComplete" | "isSuccessful" | "status"> }) {
  if (!job.isComplete) return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (job.isSuccessful) return <CheckCircle2 className="h-4 w-4 text-green-600" />
  return job.status === "Cancelled" ? <Ban className="h-4 w-4 text-gray-500" /> : <XCircle className="h-4 w-4 text-red-600" />
}

function StepHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} tabIndex={-1} className="text-xl font-medium tracking-tight text-gray-900 outline-none">{children}</h2>
}

/**
 * First-run setup: connect a tenant with the admin's own app registration, choose where backups
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
  const [step, setStep] = useState<Step>(initial?.step ?? 0)
  const [fields, setFields] = useState<SignInFields>({ tenant: initial?.tenant ?? "", clientId: initial?.clientId ?? "", displayName: initial?.displayName ?? "" })
  const [account, setAccount] = useState<SignedInAccount | null>(initial?.account ?? null)
  const [resumed, setResumed] = useState(Boolean(initial && (initial.step > 0 || initial.account)))
  const [checkingResume, setCheckingResume] = useState(Boolean(initial?.account))
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [storageBlocker, setStorageBlocker] = useState<string | null>(null)
  const plan = useTenantPlan(account?.tenantId)
  const [credentials, setCredentials] = useState<TenantCredentials | null>(null)
  const [tenantProfileId, setTenantProfileId] = useState<number | null>(null)
  const [tenantName, setTenantName] = useState("")
  const [creating, setCreating] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [jobError, setJobError] = useState("")
  const [runningJobId, setRunningJobId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [addError, setAddError] = useState<{ message: string; license: boolean } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const { addJob, removeJob, activeJobs } = useBackupProgress()
  const completedBackup = useRef<string | null>(null)
  const handledPollError = useRef<string | null>(null)
  const [snapshot, setSnapshot] = useState<JobStatus | null>(null)
  const tracked = runningJobId ? activeJobs.find((item) => item.jobId === runningJobId) : undefined
  const trackedStatus: JobStatus | null = tracked ? toBackupJobDisplay(tracked) : null
  // The snapshot keeps a finished backup finished after the store removes it.
  const displayJob: JobStatus | null = resolveBackupJobDisplay(trackedStatus, snapshot, job)
  const firstStep = useRef(true)

  // A resumed sign-in counts only while it is still signed in on this computer.
  useEffect(() => {
    if (!initial?.account) return
    let active = true
    const saved = initial.account
    void bridge.auth.accounts().then((accounts) => {
      if (!active) return
      const signedIn = accounts.some((item) => item.tenantId === saved.tenantId && item.clientId === saved.clientId)
      if (!signedIn) {
        setAccount(null)
        setStep((current) => (current > 1 ? 1 : current))
      }
    }).catch(() => undefined).finally(() => { if (active) setCheckingResume(false) })
    return () => { active = false }
  }, [initial])

  useEffect(() => {
    if (step === 3) clearOnboardingDraft()
    else saveOnboardingDraft({ step, ...fields, account })
  }, [step, fields, account])

  // Each step starts at its heading, for keyboard and screen reader users too.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return }
    document.getElementById(`setup-step-${step}`)?.focus()
  }, [step])

  useEffect(() => {
    if (!tracked?.isComplete || !runningJobId || completedBackup.current === runningJobId) return
    completedBackup.current = runningJobId
    setSnapshot(trackedStatus)
    setCancelling(false)
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
    setReleasing(true)
    setAddError(null)
    try {
      if (!connected(account.tenantId)) await bridge.license.releaseTenant(account.tenantId)
      setAccount(null)
      setChoice(null)
      setStep(1)
    } catch (error) {
      setAddError({ message: error instanceof Error ? error.message : String(error), license: false })
    } finally {
      setReleasing(false)
    }
  }

  // The license was checked at the sign-in; it is checked again before the tenant is saved. A
  // tenant the license does not cover is not added and its sign-in is removed in the main
  // process, so the admin signs in again with the same IDs once the license is sorted.
  const createTenant = async () => {
    if (!account || !choice) return
    setCreating(true)
    setAddError(null)
    let community = false
    try {
      const status = await bridge.license.checkNewTenant(account.tenantId)
      community = tenantPlan(tenantLicense(status, account.tenantId)) === "community"
    } catch (error) {
      if (!showCommunityLimitError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        setAddError({ message: `${message} TenuVault signed you out of this tenant. Sign in again once the license covers it.`, license: true })
      }
      setAccount(null)
      setChoice(null)
      setCreating(false)
      setStep(1)
      return
    }
    // The plan can change between the storage choice and this check, such as a trial that ended.
    if (community && choice.kind === "azure") {
      setAddError({ message: "This tenant is on Community now, which keeps backups on this device. Choose This device to continue.", license: false })
      setChoice(null)
      setCreating(false)
      return
    }
    try {
      const creds = desktopTenantCredentials(account, fields.displayName, choice)
      const tenant = await buildTenantProfile(creds)
      addTenant(tenant)
      setSelectedTenantId(tenant.id)
      setCredentials(creds)
      setTenantProfileId(tenant.id)
      setTenantName(tenant.name)
      setResumed(false)
      setStep(3)
    } catch (error) {
      if (!showCommunityLimitError(error)) setAddError({ message: error instanceof Error ? error.message : String(error), license: false })
    } finally {
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
      isHidden: true,
      quiet: true,
      credentials: { tenantId: credentials.tenantId, appId: credentials.appId, clientSecret: credentials.clientSecret },
      resources: { subscriptionId: credentials.subscriptionId ?? "", resourceGroupName: credentials.resourceGroupName ?? "", automationAccountName: "", storageAccountName: credentials.storageAccountName ?? "" },
    })
  }

  const cancelBackup = async () => {
    if (!runningJobId) return
    setCancelling(true)
    try {
      await bridge.backups.cancel(runningJobId)
    } catch (error) {
      setJobError(error instanceof Error ? error.message : "Could not cancel the backup. Try again.")
      setCancelling(false)
    }
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [displayJob?.output])

  const finished = Boolean(displayJob?.isComplete)
  const succeeded = Boolean(displayJob?.isComplete && displayJob.isSuccessful)

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 lg:p-8">
      {tenants.length > 0 && (
        <Link to="/portal/dashboard" className="group inline-flex items-center gap-3 rounded-full text-sm font-medium text-gray-600 hover:text-gray-900">
          <span className="flex size-10 items-center justify-center rounded-full bg-card transition-colors group-hover:bg-secondary" aria-hidden="true"><ArrowLeft className="h-4 w-4" /></span> Back to dashboard
        </Link>
      )}
      <div>
        <h1 className="text-4xl font-medium tracking-tight text-gray-900">Set up TenuVault</h1>
        <p className="mt-2 text-base text-gray-500">
          Connect a tenant and take your first backup, in about 10 minutes. Everything runs on this computer as you; no Azure
          resources are required.
        </p>
      </div>

      <ol className="grid grid-cols-4 gap-2" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-4 text-sm font-medium",
              i === step ? "bg-primary text-primary-foreground" : i < step ? "bg-green-50 text-green-700" : "bg-card text-muted-foreground",
            )}
          >
            <span className={cn("flex size-7 flex-shrink-0 items-center justify-center rounded-full", i === step ? "bg-coral-500 text-white" : "bg-secondary")} aria-hidden="true">
              {i < step ? <CheckCircle2 className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
            </span>
            <span className="truncate">{s.title}</span>
            <span className="sr-only">{i < step ? " (done)" : i === step ? ` (step ${i + 1} of ${STEPS.length})` : ""}</span>
          </li>
        ))}
      </ol>

      {resumed && step < 3 && (
        <p role="status" className="rounded-2xl bg-blue-50/60 px-4 py-3 text-sm text-gray-700">
          Welcome back. You can continue where you left off{account ? `, signed in as ${account.username}` : ""}.
        </p>
      )}

      <div className="rounded-3xl bg-card p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        {step === 0 && (
          <div className="space-y-5">
            <StepHeading id="setup-step-0">Before you sign in</StepHeading>
            <SetupScriptCard />
            <p className="text-sm text-gray-600">
              The admins who use TenuVault need an Intune role, for example Intune Administrator. Already have the two values
              from an earlier setup? Continue.
            </p>
            <div className="flex justify-end">
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setStep(1)}>
                Next: sign in <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <StepHeading id="setup-step-1">Sign in to your tenant</StepHeading>
            {status?.tenantTrialsEnabled && <p className="text-sm text-gray-600">New tenants start with a Pro trial. No card and no email needed.</p>}
            {addError && (
              <div role="alert" className="space-y-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                <p className="flex items-start gap-2"><XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" /> {addError.message}</p>
                {addError.license && <div className="space-y-2 text-gray-700">
                  <TrialKeyRefusalActions message={addError.message} source="setup-trial-key-refused" />
                  {addError.message.includes(TRIAL_USED_MESSAGE) ? <Link className="text-blue-600 underline" to="/license">Enter a Pro license key</Link> : <TrialOrKey source="setup-license-error" />}
                </div>}
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
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setStep(2)} disabled={releasing}>
                    Continue <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : (
              <TenantSignInForm
                initial={fields}
                onFieldsChange={setFields}
                onSignedIn={(signedIn, displayName) => {
                  setAddError(null)
                  setAccount(signedIn)
                  setFields((current) => ({ ...current, displayName }))
                  setStep(2)
                }}
              />
            )}
          </div>
        )}

        {step === 2 && account && (
          <div className="space-y-5">
            <StepHeading id="setup-step-2">Choose where backups are stored</StepHeading>
            <p className="flex items-center gap-2 rounded-full bg-green-50 px-4 py-2.5 text-sm text-green-800">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Signed in as {account.username}
            </p>
            <PlanContext tenantId={account.tenantId} username={account.username} />
            {addError && <p role="alert" className="text-sm text-red-700">{addError.message}</p>}
            <StorageChooser tenantId={account.tenantId} clientId={account.clientId} onChange={setChoice} onBlockerChange={setStorageBlocker} />
            <div className="flex flex-wrap items-center justify-end gap-3">
              {!choice && storageBlocker && <p role="status" className="text-sm text-gray-600">{storageBlocker}</p>}
              <Button className="bg-blue-600 hover:bg-blue-700" disabled={!choice || creating || checkingResume} onClick={() => void createTenant()}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {creating ? "Checking the license..." : "Continue"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <StepHeading id="setup-step-3">{succeeded ? "Your first backup is done" : "Take a first backup"}</StepHeading>
            {!succeeded && (
              <div className="space-y-2 text-sm text-gray-700">
                <p>{tenantName ? `${tenantName} is connected.` : "Your tenant is connected."} Take a first backup to check that everything works.</p>
                <ul className="list-disc space-y-1 pl-5 text-gray-600">
                  <li>It reads your Intune policies, scripts and settings, and changes nothing in your tenant.</li>
                  <li>Apps are left out by default to keep it quick. You can change what is backed up later in the backup scope.</li>
                  <li>It usually takes a few minutes, longer for large tenants.</li>
                </ul>
              </div>
            )}
            {jobError && (
              <p role="alert" className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                <XCircle className="h-4 w-4" /> {jobError}
              </p>
            )}
            {displayJob && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm" role="status">
                  <span className="flex items-center gap-2 text-gray-800">
                    <JobStateIcon job={displayJob} />
                    {displayJob.exception ?? displayJob.progressMessage}
                  </span>
                  <span className="text-gray-500">{displayJob.progress}%</span>
                </div>
                <Progress value={displayJob.progress} />
                {!displayJob.isComplete && runningJobId && (
                  <Button variant="outline" disabled={cancelling} onClick={() => void cancelBackup()}>
                    {cancelling ? "Cancelling…" : "Cancel backup"}
                  </Button>
                )}
                {succeeded && <FirstBackupNote plan={plan} />}
                {displayJob.output && (
                  <pre ref={logRef} className="max-h-48 overflow-auto rounded-2xl bg-slate-900 p-4 text-xs text-slate-100">
                    {displayJob.output}
                  </pre>
                )}
              </div>
            )}
            {succeeded && credentials && <FirstBackupNextSteps tenantId={credentials.tenantId} plan={plan} local={!credentials.storageAccountName || credentials.storageAccountName.startsWith(LOCAL_STORAGE_PREFIX)} />}
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
              ) : (
                <>
                  <Button variant="outline" onClick={() => void navigate("/portal/dashboard")} disabled={Boolean(displayJob)}>
                    Skip for now
                  </Button>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void runBackup()} disabled={Boolean(displayJob)}>
                    <Play className="mr-2 h-4 w-4" /> Run first backup
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {step > 0 && step < 3 && (
          <div className="mt-6 border-t border-gray-100 pt-4">
            <Button variant="ghost" onClick={() => setStep((step - 1) as Step)} disabled={creating || releasing}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Previous
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
