import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowLeft, CheckCircle2, Database, HardDriveDownload, KeyRound, Loader2, Play, ShieldCheck, XCircle } from "lucide-react"
import { useSelectedTenant, useTenantOperations } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Progress } from "~/components/ui/progress"
import { cn } from "~/lib/utils"
import type { SignedInAccount } from "../../shared/ipc"
import { StorageChooser } from "../components/StorageChooser"
import { FirstBackupNote } from "../components/FirstBackupNote"
import { useTenantPlan } from "../lib/license"
import { SetupScriptCard, TenantSignInForm } from "../components/TenantSignInForm"
import { bridge } from "../lib/bridge"
import { buildTenantProfile } from "../lib/desktop-tenant"
import type { StorageChoice } from "../lib/storage"
import { desktopTenantCredentials, type TenantCredentials } from "../overrides/add-tenant-modal"

const onboardingDraft: { step: number; account: { account: SignedInAccount; displayName: string } | null; choice: StorageChoice | null } = { step: 0, account: null, choice: null }

const STEPS = [
  { title: "Prepare", icon: ShieldCheck },
  { title: "Sign in", icon: KeyRound },
  { title: "Storage", icon: Database },
  { title: "First backup", icon: HardDriveDownload },
]

interface JobStatus {
  status: string
  progress: number
  progressMessage: string
  output?: string
  exception?: string
  isComplete: boolean
  isSuccessful: boolean
}

/**
 * First-run setup: connect a tenant with the admin's own app registration, choose where
 * backups go and take a first backup. No Azure resources are required.
 */
export default function OnboardingPage() {
  const navigate = useNavigate()
  const { addTenant, updateTenant } = useTenantOperations()
  const { setSelectedTenantId } = useSelectedTenant()
  const [step, setStep] = useState(onboardingDraft.step)
  const [account, setAccount] = useState<{ account: SignedInAccount; displayName: string } | null>(onboardingDraft.account)
  const [choice, setChoice] = useState<StorageChoice | null>(onboardingDraft.choice)
  const plan = useTenantPlan(account?.account.tenantId)
  const [credentials, setCredentials] = useState<TenantCredentials | null>(null)
  const [tenantProfileId, setTenantProfileId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [jobError, setJobError] = useState("")
  const [addError, setAddError] = useState("")
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    Object.assign(onboardingDraft, step < 3 ? { step, account, choice } : { step: 0, account: null, choice: null })
  }, [step, account, choice])

  // The license was checked at the sign-in; it is checked again before the tenant is
  // saved. A tenant the license does not cover is not added and its sign-in is removed.
  const createTenant = async () => {
    if (!account || !choice) return
    setCreating(true)
    setAddError("")
    try {
      await bridge.license.checkNewTenant(account.account.tenantId)
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
      setAccount(null)
      setChoice(null)
      setCreating(false)
      setStep(1)
      return
    }
    try {
      const creds = desktopTenantCredentials(account.account, account.displayName, choice)
      const tenant = await buildTenantProfile(creds)
      addTenant(tenant)
      setSelectedTenantId(tenant.id)
      setCredentials(creds)
      setTenantProfileId(tenant.id)
      setStep(3)
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
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
    setJobError("")
    setJob({ status: "Running", progress: 5, progressMessage: "Starting backup...", isComplete: false, isSuccessful: false })
    let jobId: string
    try {
      const started = await post<{ jobId?: string }>("/api/backup/start", credentials)
      if (!started.jobId) throw new Error("The backup could not start.")
      jobId = started.jobId
    } catch (error) {
      setJob(null)
      setJobError(error instanceof Error ? error.message : String(error))
      return
    }

    const poll = async () => {
      try {
        const status = await post<JobStatus>("/api/backup/status", { jobId })
        setJob(status)
        if (!status.isComplete) {
          setTimeout(() => void poll(), 1000)
        } else if (status.isSuccessful && tenantProfileId) {
          updateTenant(tenantProfileId, { lastBackup: new Date().toISOString(), syncStatus: "success" })
        }
      } catch (error) {
        // Stop polling and let the admin retry or skip.
        setJob(null)
        setJobError(error instanceof Error ? error.message : String(error))
      }
    }
    void poll()
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [job?.output])

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 lg:p-8">
      <Link to="/portal/dashboard" className="group inline-flex items-center gap-3 rounded-full text-sm font-medium text-gray-600 hover:text-gray-900">
        <span className="flex size-10 items-center justify-center rounded-full bg-card transition-colors group-hover:bg-secondary" aria-hidden="true"><ArrowLeft className="h-4 w-4" /></span> Back to dashboard
      </Link>
      <div>
        <h1 className="text-4xl font-medium tracking-tight text-gray-900">Set up TenuVault</h1>
        <p className="mt-2 text-base text-gray-500">
          Connect a tenant and take your first backup. Everything runs on this computer as you; no Azure resources are
          required.
        </p>
      </div>

      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className={cn(
              "flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-4 text-sm font-medium",
              i === step ? "bg-primary text-primary-foreground" : i < step ? "bg-green-50 text-green-700" : "bg-card text-muted-foreground",
            )}
          >
            <span className={cn("flex size-7 flex-shrink-0 items-center justify-center rounded-full", i === step ? "bg-coral-500 text-white" : "bg-secondary")} aria-hidden="true">
              {i < step ? <CheckCircle2 className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
            </span>
            <span className="truncate">{s.title}</span>
          </li>
        ))}
      </ol>

      {step > 0 && step < 3 && <Button variant="outline" onClick={() => setStep(step - 1)} disabled={creating}><ArrowLeft className="mr-2 h-4 w-4" />Previous</Button>}
      <div className="rounded-3xl bg-card p-7 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        {step === 0 && (
          <div className="space-y-5">
            <SetupScriptCard />
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium text-gray-900">The admins who use TenuVault need:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>An Intune role, for example Intune Administrator.</li>
                <li>For backups in Azure: the Storage Blob Data Contributor role on the storage account.</li>
              </ul>
              <p className="text-gray-600">Already have the client id from an earlier setup? Continue.</p>
            </div>
            <div className="flex justify-end">
              <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => setStep(1)}>
                I have the client id
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            {addError && (
              <p className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                <XCircle className="h-4 w-4 flex-shrink-0" /> {addError}
              </p>
            )}
            <TenantSignInForm
              initial={account ? { tenant: account.account.tenantId, clientId: account.account.clientId, displayName: account.displayName } : undefined}
              onSignedIn={(signedIn, displayName) => {
                setAddError("")
                setAccount({ account: signedIn, displayName })
                setStep(2)
              }}
            />
          </div>
        )}

        {step === 2 && account && (
          <div className="space-y-5">
            <div className="flex items-center gap-2 rounded-full bg-green-50 px-4 py-2.5 text-sm text-green-800">
              <CheckCircle2 className="h-4 w-4" /> Signed in as {account.account.username}
            </div>
            {addError && <p role="alert" className="text-sm text-red-700">{addError}</p>}
            <StorageChooser initial={choice ?? undefined} tenantId={account.account.tenantId} clientId={account.account.clientId} onChange={setChoice} />
            <div className="flex justify-end">
              <Button className="bg-blue-600 hover:bg-blue-700" disabled={!choice || creating} onClick={() => void createTenant()}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <p className="text-sm text-gray-700">
              Your tenant is connected. Take a first backup now to make sure everything works, or do it later from Backup &amp;
              Restore.
            </p>
            {jobError && (
              <p className="flex items-center gap-2 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">
                <XCircle className="h-4 w-4" /> {jobError}
              </p>
            )}
            {job && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-gray-800">
                    {!job.isComplete && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
                    {job.isComplete && job.isSuccessful && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                    {job.isComplete && !job.isSuccessful && <XCircle className="h-4 w-4 text-red-600" />}
                    {job.exception ?? job.progressMessage}
                  </span>
                  <span className="text-gray-500">{job.progress}%</span>
                </div>
                <Progress value={job.progress} />
                {job.isComplete && job.isSuccessful && <FirstBackupNote plan={plan} />}
                {job.output && (
                  <pre ref={logRef} className="max-h-48 overflow-auto rounded-2xl bg-slate-900 p-4 text-xs text-slate-100">
                    {job.output}
                  </pre>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {job?.isComplete ? (
                <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void navigate("/portal/backup")}>
                  Go to Backup &amp; Restore
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => void navigate("/portal/tenants")} disabled={Boolean(job)}>
                    Skip for now
                  </Button>
                  <Button className="bg-blue-600 hover:bg-blue-700" onClick={() => void runBackup()} disabled={Boolean(job)}>
                    <Play className="mr-2 h-4 w-4" /> Run first backup
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
