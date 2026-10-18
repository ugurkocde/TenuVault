import { useEffect, useRef } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { AlertTriangle, CheckCircle2, LoaderCircle, X } from "lucide-react"
import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import { trackBackup } from "../../lib/backups"
import { progressText } from "./FlowShell"
import { jobProgress, jobRoute, jobTitle, markSeen, useOibJobs, type OibJob } from "./jobs"

/** Opens the workflow of a job for its tenant. */
function useOpenJob() {
  const tenants = useTenants()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const navigate = useNavigate()
  return (job: OibJob) => {
    const match = tenants.find(t => t.credentials?.tenantId === job.tenantId)
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
    navigate(jobRoute(job))
  }
}

/** One OIB job: title, live stage or outcome; opens its workflow. Also usable on the overview. */
export function OibJobCard({ job, onDismiss }: { job: OibJob; onDismiss?: () => void }) {
  const open = useOpenJob()
  const progress = jobProgress(job)
  const Icon = !job.finishedAt ? LoaderCircle : job.error ? AlertTriangle : CheckCircle2
  return <div className="flex items-start gap-2 rounded-2xl bg-secondary p-3 text-xs">
    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${!job.finishedAt ? "animate-spin text-blue-700" : job.error ? "text-red-700" : "text-green-700"}`} aria-hidden="true" />
    <button type="button" onClick={() => open(job)} className="min-w-0 flex-1 text-left">
      <span className="block font-medium text-foreground">{jobTitle(job)}</span>
      <span className="mt-0.5 block text-muted-foreground">{progress ? progressText(progress) : job.error ? "Open to see what happened" : "Open to see the result"}</span>
      {job.percent != null && !job.finishedAt && <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-gray-200" aria-hidden="true"><span className="block h-full rounded-full bg-primary" style={{ width: `${job.percent}%` }} /></span>}
    </button>
    {onDismiss && <button type="button" onClick={onDismiss} className="-mr-1 -mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground" aria-label={`Dismiss ${jobTitle(job)}`}><X className="h-3.5 w-3.5" aria-hidden="true" /></button>}
  </div>
}

/**
 * Mounted once in the sidebar: running and unseen finished OIB jobs, except the one whose workflow
 * is open for its tenant. Backups the jobs start are added to the floating backup progress, which
 * lists them only while their job runs and its workflow is not on screen (the workflow's action bar
 * shows the backup itself, and the result reports how it ended). They never expand on their own.
 */
export function OibJobIndicator() {
  const jobs = useOibJobs()
  const tenants = useTenants()
  const { selectedTenant } = useSelectedTenant()
  const { addJob, updateJob } = useBackupProgress()
  const { pathname } = useLocation()
  // Backup job ID to the OIB job that started it, and whether the panel currently hides it.
  const tracked = useRef(new Map<string, string>())
  const hidden = useRef(new Map<string, boolean>())
  const selected = selectedTenant?.credentials?.tenantId
  const onScreen = (job: OibJob) => pathname === jobRoute(job) && selected === job.tenantId

  useEffect(() => {
    for (const job of jobs) {
      if (!job.backupJobId || tracked.current.has(job.backupJobId)) continue
      const tenant = tenants.find(t => t.credentials?.tenantId === (job.backupTenantId ?? job.tenantId))
      if (!tenant) continue
      const hide = onScreen(job)
      tracked.current.set(job.backupJobId, job.id)
      hidden.current.set(job.backupJobId, hide)
      trackBackup(tenant, job.backupJobId, addJob, { quiet: true, isHidden: hide })
    }
    for (const [backupId, jobId] of tracked.current) {
      const job = jobs.find(j => j.id === jobId)
      const hide = !job || !!job.finishedAt || onScreen(job)
      if (hidden.current.get(backupId) !== hide) { hidden.current.set(backupId, hide); updateJob(backupId, { isHidden: hide }) }
    }
    // A finished job shown in its own workflow counts as seen.
    for (const job of jobs) if (job.finishedAt && !job.seen && onScreen(job)) markSeen(job.id)
  }, [jobs, tenants, addJob, updateJob, pathname, selected])

  const shown = jobs.filter(job => !onScreen(job) && (!job.finishedAt || !job.seen))
  if (!shown.length) return null
  return <section className="space-y-2 px-3 pb-2" aria-label="OpenIntuneBaseline jobs">
    {shown.map(job => <OibJobCard key={job.id} job={job} onDismiss={job.finishedAt ? () => markSeen(job.id) : undefined} />)}
  </section>
}
