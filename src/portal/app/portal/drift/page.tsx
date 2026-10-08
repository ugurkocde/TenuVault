"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useTenants, useSelectedTenant } from "~/contexts/TenantContext"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog"
import {
  GitCompare,
  AlertTriangle,
  Info,
  Download,
  Settings,
  FileText,
  Shield,
  Smartphone,
  Package,
  RefreshCw,
  Check,
  X,
  Plus,
  Pencil,
  Minus,
  Loader2,
  FileJson,
  FileSpreadsheet,
  ChevronDown,
  Database,
} from "lucide-react"
import { cn } from "~/lib/utils"
import { useTenantPlan } from "@desktop/lib/license"
import { GatedButton } from "@desktop/components/PlanGate"
import { cancelDriftScan, startDriftScan, useDriftJob, useDriftResult } from "@desktop/lib/drift-jobs"
import { useBackupList } from "@desktop/lib/backup-list"
import { Button } from "~/components/ui/button"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { RevertProgressModal } from "~/components/drift/revert-progress-modal"
import { ChangeList } from "~/components/drift/change-list"
import { BackupPairPicker } from "~/components/drift/backup-pair-picker"
import { formatDate, TRIGGER_LABEL, type BackupSummary } from "~/components/backup/types"
import { backupCompleteness, type Drift, type DriftBackupRef, type SettingNames } from "../../../../shared/intune/drift"
import { settingLabel } from "../../../../shared/intune/drift-format"
import { driftCsv, driftExportName, driftJson } from "../../../../shared/intune/drift-export"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"

/** "Oct 6, 2026, 02:00 (scheduled)" */
function backupLabel(backup: DriftBackupRef): string {
  const trigger = backup.trigger && backup.trigger in TRIGGER_LABEL ? TRIGGER_LABEL[backup.trigger as keyof typeof TRIGGER_LABEL].toLowerCase() : "trigger not recorded"
  return `${formatDate(backup.timestamp)} (${trigger})`
}

const NO_BACKUPS: BackupSummary[] = []

/** Added green, modified amber, deleted red: the same on every badge, icon and count. */
const CHANGE_STYLE: Record<Drift["changeType"], { label: string; tone: string; dot: string; Icon: typeof Plus }> = {
  added: { label: "Added", tone: "bg-green-50 text-green-700", dot: "bg-green-600", Icon: Plus },
  modified: { label: "Modified", tone: "bg-amber-50 text-amber-800", dot: "bg-amber-500", Icon: Pencil },
  deleted: { label: "Deleted", tone: "bg-red-50 text-red-700", dot: "bg-red-600", Icon: Minus },
}

/** The first changed settings by name, such as "Allow Cloud Protection, Password minimum length and 3 more". */
function changedSettings(drift: Drift, names?: SettingNames): string {
  const labels = [...new Set((drift.changes ?? []).map(change => settingLabel(change, names).label))]
  if (labels.length <= 3) return labels.join(", ")
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** Tenants whose page already started its first scan in this session. */
const autoStarted = new Set<string>()

/** Drifts by policy type, types in alphabetical order. */
function byType(drifts: Drift[]): Array<{ type: string; drifts: Drift[] }> {
  const groups = new Map<string, Drift[]>()
  for (const drift of drifts) groups.set(drift.type, [...(groups.get(drift.type) ?? []), drift])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, entries]) => ({ type, drifts: entries }))
}

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-white px-6 py-14 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-500">{icon}</div>
      <h3 className="text-lg font-medium tracking-tight text-gray-900">{title}</h3>
      {children && <div className="mx-auto mt-2 max-w-lg text-sm text-gray-500">{children}</div>}
    </div>
  )
}

export default function DriftDetectionPage() {
  const tenants = useTenants()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const plan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  const tenantId = selectedTenant?.credentials?.tenantId?.toLowerCase()
  const storageAccountName = selectedTenant?.resources?.storageAccountName
  const job = useDriftJob(tenantId)
  const { result, loaded } = useDriftResult(tenantId)
  const running = job?.status === "running"

  const [selectedDrift, setSelectedDrift] = useState<string | null>(null)
  const [error, setError] = useState("")
  // Kept between visits and refreshed in the background, so the picker does not wait for the list again.
  const backupList = useBackupList(selectedTenant)
  const backups = backupList.backups ?? NO_BACKUPS
  const backupsLoaded = backupList.backups !== null
  const backupsLoading = backupList.loading && !backupsLoaded
  const [pair, setPair] = useState<{ baseline: string | null; comparison: string | null }>({ baseline: null, comparison: null })
  // Set once the admin picks a backup, so loading the list or a result does not override the choice.
  const pairTouched = useRef(false)
  const [revertingDriftId, setRevertingDriftId] = useState<string | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean
    driftId: string
    action: "revert" | "restore"
    /** A Revert of a deleted policy, which creates it again. */
    recreate: boolean
    title: string
    message: string
  } | null>(null)
  const [progressModal, setProgressModal] = useState<{
    isOpen: boolean
    action: "revert" | "restore"
    policyName: string
    currentStep: number
    error: string | null
    isComplete: boolean
    isSuccess: boolean
    newPolicyId?: string
    policyType?: string
  }>({
    isOpen: false,
    action: "revert",
    policyName: "",
    currentStep: 0,
    error: null,
    isComplete: false,
    isSuccess: false
  })

  // Links from scan notifications name the tenant the scan ran for.
  const [params, setParams] = useSearchParams()
  const requestedTenant = params.get("tenant")?.toLowerCase()
  useEffect(() => {
    if (!requestedTenant || !tenants.length) return
    const match = tenants.find(t => t.credentials?.tenantId.toLowerCase() === requestedTenant)
    if (match && match.id !== selectedTenant?.id) setSelectedTenantId(match.id)
    setParams({}, { replace: true })
  }, [requestedTenant, tenants])

  // Another tenant starts with its own default pair.
  useEffect(() => {
    pairTouched.current = false
    setPair({ baseline: null, comparison: null })
    setError("")
    setSelectedDrift(null)
  }, [selectedTenant?.id, selectedTenant?.credentials, storageAccountName])

  const completeBackups = backups.filter(backup => backupCompleteness(backup.status) === "complete")
  const shownError = error || backupList.error

  // The picker shows the pair of the shown result, or the default pair: the two newest complete backups.
  useEffect(() => {
    if (pairTouched.current) return
    if (result) setPair({ baseline: result.baseline.id, comparison: result.comparison.id })
    else if (completeBackups.length >= 2) setPair({ baseline: completeBackups[1]!.id, comparison: completeBackups[0]!.id })
  }, [result?.baseline.id, result?.comparison.id, backups])

  // A tenant without a saved result is compared once in the background when the page opens.
  useEffect(() => {
    if (!tenantId || !storageAccountName || !loaded || result || job || autoStarted.has(tenantId)) return
    autoStarted.add(tenantId)
    startDriftScan(tenantId).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "The drift scan could not start."))
  }, [tenantId, storageAccountName, loaded, result, job])

  const startScan = async (chosen?: { baseline: string; comparison: string }) => {
    if (!tenantId) return
    setError("")
    setConfirmDialog(null)
    try {
      await startDriftScan(tenantId, chosen)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The drift scan could not start.")
    }
  }

  const latestPair = completeBackups.length >= 2 ? { baseline: completeBackups[1]!.id, comparison: completeBackups[0]!.id } : null

  const drifts: Drift[] = useMemo(
    () => (result?.drifts ?? []).map(drift => ({ ...drift, tenant: selectedTenant?.name ?? drift.tenant })),
    [result, selectedTenant?.name],
  )
  // A failed or refused scan newer than the shown result.
  const failedJob = job && job.status === "failed" && (!result || (job.finishedAt ?? "") > result.lastScan) ? job : null
  const insufficient = !running && !result && (failedJob?.code === "INSUFFICIENT_BACKUPS" || (backupsLoaded && completeBackups.length < 2))
  const showResult = !!result && !!selectedTenant
  const noDriftText = result ? `No drift between ${formatDate(result.baseline.timestamp)} and ${formatDate(result.comparison.timestamp)}` : ""
  const counts = {
    added: drifts.filter(d => d.changeType === "added").length,
    modified: drifts.filter(d => d.changeType === "modified").length,
    deleted: drifts.filter(d => d.changeType === "deleted").length,
  }


  // Puts the policy back to the backed-up version in place, or recreates a deleted policy under its original name.
  const handleRevertAction = (drift: Drift) => {
    setConfirmDialog({
      isOpen: true,
      driftId: drift.id,
      action: "revert",
      recreate: drift.changeType === "deleted",
      title: drift.changeType === "deleted" ? "Recreate Deleted Policy" : "Revert to Previous Version",
      message: drift.changeType === "deleted"
        ? `Recreate "${drift.configName}" from the backup under its original name? Assignments are not restored.`
        : `Put "${drift.configName}" back to the backed-up version? The current settings are overwritten and reach devices at their next check-in. Assignments stay as they are.`
    })
  }

  const handleRestoreAction = (drift: Drift) => {
    setConfirmDialog({
      isOpen: true,
      driftId: drift.id,
      action: "restore",
      recreate: false,
      title: drift.changeType === "deleted" ? "Restore Deleted Policy" : "Restore Previous Version",
      message: drift.changeType === "deleted"
        ? `Are you sure you want to restore "${drift.configName}"? This will create a new policy with the prefix "[Restored]".`
        : `Are you sure you want to restore the previous version of "${drift.configName}"? This will create a new policy with the prefix "[Restored]" without modifying the current policy.`
    })
  }

  const executeRevert = async () => {
    if (!confirmDialog || !selectedTenant?.credentials || !selectedTenant?.resources?.storageAccountName) return

    const drift = drifts.find(d => d.id === confirmDialog.driftId)
    if (!drift) return

    setRevertingDriftId(drift.id)
    const action = confirmDialog.action
    setConfirmDialog(null)

    // Open progress modal
    setProgressModal({
      isOpen: true,
      action,
      policyName: drift.configName,
      currentStep: 0,
      error: null,
      isComplete: false,
      isSuccess: false,
      policyType: drift.type
    })

    try {
      // Step 1: Fetching policy from backup
      setProgressModal(prev => ({ ...prev, currentStep: 0 }))
      // drift.fromBackup now contains the actual backup folder name (e.g., "backup-2025-08-08-072123")
      const backupFolderName = drift.fromBackup
      // Drift results name the item's file; older results only had its display name.
      const fullBackupPath = drift.backupFile
        ? `${backupFolderName}/${drift.backupFile}`
        : `${backupFolderName}/${getPolicyTypePath(drift.type)}/${drift.configName}.json`

      // Step 2: Preparing policy data
      setProgressModal(prev => ({ ...prev, currentStep: 1 }))
      await new Promise(resolve => setTimeout(resolve, 500)) // Small delay for visual feedback

      // Step 3: Applying changes to Intune
      setProgressModal(prev => ({ ...prev, currentStep: 2 }))

      const response = await fetch("/api/revert-policy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...selectedTenant.credentials,
          storageAccountName: selectedTenant.resources.storageAccountName,
          action,
          policyId: drift.configId,
          policyType: drift.type,
          backupPath: fullBackupPath,
          originalName: drift.configName,
          fromBackup: drift.fromBackup,
          toBackup: drift.toBackup,
          changes: drift.changes
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to revert policy")
      }

      const result = await response.json()

      // Step 4: Updating metadata
      setProgressModal(prev => ({ ...prev, currentStep: 3, newPolicyId: result.policyId }))
      await new Promise(resolve => setTimeout(resolve, 500))

      // Step 5: Refreshing drift detection
      setProgressModal(prev => ({ ...prev, currentStep: 4, newPolicyId: result.policyId }))

      // Clear any existing errors
      setError("")

      // The same pair is compared again in the background, so the item shows as reverted.
      await startScan({ baseline: drift.fromBackup, comparison: drift.toBackup })

      // Show success
      setProgressModal(prev => ({
        ...prev,
        currentStep: 5,
        isComplete: true,
        isSuccess: true
      }))

    } catch (err) {
      console.error("Revert error:", err)
      const errorMessage = err instanceof Error ? err.message : "Failed to revert policy"

      // Show error in modal
      setProgressModal(prev => ({
        ...prev,
        error: errorMessage,
        isComplete: true,
        isSuccess: false
      }))

      setError(errorMessage)
    } finally {
      setRevertingDriftId(null)
    }
  }

  const getPolicyTypePath = (type: string): string => {
    switch (type) {
      case "Device Configuration": return "DeviceConfigurations"
      case "Compliance Policy": return "CompliancePolicies"
      case "Configuration Policy": return "ConfigurationPolicies"
      case "App Protection": return "AppProtectionPolicies"
      case "Conditional Access": return "ConditionalAccessPolicies"
      default: return "Unknown"
    }
  }



  const getConfigTypeIcon = (type: string) => {
    switch (type) {
      case "Compliance Policy":
        return <Shield className="h-5 w-5" />
      case "Device Configuration":
        return <Smartphone className="h-5 w-5" />
      case "App Protection":
      case "App Deployment":
        return <Package className="h-5 w-5" />
      case "Conditional Access":
        return <FileText className="h-5 w-5" />
      default:
        return <Settings className="h-5 w-5" />
    }
  }

  const backupTime = (timestamp: string | undefined, folder: string) => timestamp ? new Date(timestamp).toLocaleString() : folder

  const getRelativeTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60))

    if (diffInHours < 1) return "Just now"
    if (diffInHours < 24) return `${diffInHours}h ago`
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  const handleExport = (format: "csv" | "json") => {
    if (!result) return
    const shown = { ...result, drifts }
    const name = driftExportName(result, selectedTenant?.name)
    if (format === "csv") download(`${name}.csv`, `\ufeff${driftCsv(shown)}`, "text/csv;charset=utf-8")
    else download(`${name}.json`, driftJson(shown, selectedTenant?.name), "application/json")
  }

  /** What an added or deleted item is, and where its backed-up copy is. */
  const itemDetails = (drift: Drift) => (
    <div className="rounded-2xl bg-gray-50 p-4 text-sm">
      <h4 className="mb-2 font-medium text-gray-900">{drift.changeType === "added" ? "Added item" : "Deleted item"}</h4>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-gray-700">
        <dt className="text-gray-500">Type</dt><dd>{drift.type}</dd>
        <dt className="text-gray-500">Name</dt><dd>{drift.configName}</dd>
        {drift.configId && <><dt className="text-gray-500">ID</dt><dd className="break-all font-mono text-xs">{drift.configId}</dd></>}
        <dt className="text-gray-500">Backed up in</dt><dd>{drift.changeType === "added" ? backupTime(drift.toBackupTimestamp, drift.toBackup) : backupTime(drift.fromBackupTimestamp, drift.fromBackup)}</dd>
        {drift.backupFile && <><dt className="text-gray-500">File</dt><dd className="break-all font-mono text-xs">{drift.changeType === "added" ? drift.toBackup : drift.fromBackup}/{drift.backupFile}</dd></>}
      </dl>
    </div>
  )

  const insufficientState = (
    <EmptyState icon={<Database className="h-6 w-6" />} title="Two complete backups are needed">
      <p>Drift detection compares two complete backups of this tenant. {failedJob?.code === "INSUFFICIENT_BACKUPS" && failedJob.error ? failedJob.error : "This tenant has fewer than two. Backups that failed, are still running or stopped early are not compared."}</p>
      <Link to="/portal/backup" className="mt-4 inline-flex h-10 items-center rounded-full bg-coral-600 px-5 text-sm font-medium text-white hover:bg-coral-700">Open Backup & Restore</Link>
    </EmptyState>
  )

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-medium tracking-tight text-gray-900">Drift Detection</h1>
          <p className="mt-2 text-base text-gray-500">See what changed in Intune between two backups</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="lg" disabled={!result || drifts.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Export
              <ChevronDown className="h-4 w-4 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleExport("csv")}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              CSV, one row per changed setting
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport("json")}>
              <FileJson className="h-4 w-4 mr-2" />
              JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* No Tenant Alert */}
      {!selectedTenant && (
        <Alert className="rounded-3xl border-transparent bg-white p-5 [&>svg]:left-5 [&>svg]:top-5">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Please select a tenant to view drift detection data.
          </AlertDescription>
        </Alert>
      )}

      {selectedTenant && !storageAccountName && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Connect this tenant and choose its backup storage in Settings before comparing drift.</AlertDescription>
        </Alert>
      )}

      {/* Backup pair: the page's one action */}
      {selectedTenant && storageAccountName && (
        <BackupPairPicker
          backups={backups}
          loading={backupsLoading}
          baseline={pair.baseline}
          comparison={pair.comparison}
          busy={running}
          latest={latestPair}
          onChange={(next) => { pairTouched.current = true; setPair(next) }}
          onCompare={() => { if (pair.baseline && pair.comparison) void startScan({ baseline: pair.baseline, comparison: pair.comparison }) }}
        />
      )}

      {/* Running scan: real progress from the main process; it keeps running when you leave the page. */}
      {selectedTenant && running && job && (
        <div className="rounded-3xl bg-white p-8">
          <div className="mx-auto flex max-w-xl flex-col items-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50">
              <Loader2 className="h-7 w-7 animate-spin text-blue-600" />
            </div>
            <h3 className="mb-2 text-xl font-medium tracking-tight text-gray-900">Comparing backups</h3>
            <p className="mb-4 text-center text-gray-600" aria-live="polite">{job.detail}</p>
            <div className="mb-4 w-full">
              <div className="mb-2 flex items-center justify-between text-sm text-gray-600">
                <span>{job.phase === "comparing" && job.total > 0 ? `${job.done} of ${job.total} policies` : "Progress"}</span>
                <span>{job.percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-coral-500 transition-all duration-300 ease-out" style={{ width: `${job.percent}%` }} />
              </div>
            </div>
            <p className="mb-5 text-center text-xs text-gray-500">The scan keeps running if you open another page. You will be notified when it is ready.</p>
            <Button variant="outline" onClick={() => void cancelDriftScan(job).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "The scan could not be cancelled."))}>
              <X className="mr-2 h-4 w-4" />
              Cancel scan
            </Button>
          </div>
        </div>
      )}

      {/* Error State */}
      {shownError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{shownError}</AlertDescription>
        </Alert>
      )}
      {failedJob && failedJob.code !== "INSUFFICIENT_BACKUPS" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>The last drift scan failed. {failedJob.error}{result ? " The result below is from an earlier scan." : ""}</AlertDescription>
        </Alert>
      )}

      {/* Fewer than two complete backups */}
      {selectedTenant && storageAccountName && insufficient && insufficientState}

      {/* Nothing compared yet */}
      {selectedTenant && storageAccountName && loaded && !result && !running && !insufficient && !failedJob && (
        <EmptyState icon={<GitCompare className="h-6 w-6" />} title="No comparison yet">
          <p>Choose two backups above and click Compare.</p>
        </EmptyState>
      )}

      {showResult && result && (
        <>
          {/* The compared pair and what changed */}
          <div className="space-y-3 rounded-3xl bg-white px-6 py-5 text-sm text-gray-700">
            <p>
              <span className="text-gray-500">Baseline:</span> <span className="font-medium text-gray-900">{backupLabel(result.baseline)}</span>
              <span className="mx-2 text-gray-400" aria-label="compared with">→</span>
              <span className="text-gray-500">Comparison:</span> <span className="font-medium text-gray-900">{backupLabel(result.comparison)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="font-medium text-gray-900">{drifts.length} {drifts.length === 1 ? "change" : "changes"}</span>
              {(["added", "modified", "deleted"] as const).map(change => (
                <span key={change} className="inline-flex items-center gap-1.5">
                  <span className={cn("h-2 w-2 rounded-full", CHANGE_STYLE[change].dot)} aria-hidden="true" />
                  {counts[change]} {CHANGE_STYLE[change].label.toLowerCase()}
                </span>
              ))}
              <span className="text-xs text-gray-500 sm:ml-auto">
                {result.stats.compared + result.stats.unchanged} items checked. {running ? "Previous result, shown while the new scan runs." : `Scanned ${new Date(result.lastScan).toLocaleString()}.`}
              </span>
            </div>
          </div>

          {result.warnings.length > 0 && (
            <Alert className="rounded-3xl border-transparent bg-amber-50 p-5 [&>svg]:left-5 [&>svg]:top-5">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              <AlertDescription className="text-amber-900">
                <strong>{result.warnings.length} {result.warnings.length === 1 ? "file was" : "files were"} not compared</strong> because {result.warnings.length === 1 ? "it" : "they"} could not be read. Changes to {result.warnings.length === 1 ? "this item" : "these items"} are not shown.
                <ul className="mt-2 space-y-0.5 text-xs">
                  {result.warnings.slice(0, 10).map((warning) => <li key={`${warning.backup}/${warning.file}`}><span className="font-mono">{warning.backup}/{warning.file}</span>: {warning.message}</li>)}
                  {result.warnings.length > 10 && <li>and {result.warnings.length - 10} more</li>}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {counts.added > 50 && (
            <Alert className="rounded-3xl border-transparent bg-white p-5 [&>svg]:left-5 [&>svg]:top-5">
              <Info className="h-4 w-4" />
              <AlertDescription>
                <strong>High number of new policies detected.</strong> This typically happens when comparing against older backups without a proper baseline.
                Compare two consecutive backups for a more accurate picture.
              </AlertDescription>
            </Alert>
          )}

          {drifts.length === 0 && (
            <EmptyState icon={<Check className="h-6 w-6" />} title={noDriftText}>
              <p>Every item both backups include is the same in each. Choose other backups above to compare a different period.</p>
            </EmptyState>
          )}

          {/* Changes, grouped by policy type */}
          {drifts.length > 0 && (
            <div className="space-y-8">
              {byType(drifts).map((group) => (
                <section key={group.type} aria-label={group.type} className="space-y-3">
                  <h2 className="flex items-center gap-2 px-1 text-lg font-medium tracking-tight text-gray-900">
                    {group.type}
                    <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-gray-600">{group.drifts.length}</span>
                  </h2>
                  {group.drifts.map((drift) => {
                    const style = CHANGE_STYLE[drift.changeType]
                    const open = selectedDrift === drift.id
                    const settings = changedSettings(drift, result.settingNames)
                    return (
                      <div
                        key={drift.id}
                        className={cn(
                          "rounded-3xl border bg-white transition-colors",
                          drift.isRevertDrift && "opacity-60",
                          open ? "border-gray-200" : "border-transparent hover:border-gray-200"
                        )}
                      >
                        <button
                          type="button"
                          className="flex w-full items-start gap-4 rounded-3xl p-6 text-left"
                          aria-expanded={open}
                          aria-controls={`drift-${drift.id}`}
                          onClick={() => setSelectedDrift(open ? null : drift.id)}
                        >
                          <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", style.tone)} aria-hidden="true">
                            {getConfigTypeIcon(drift.type)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="mb-1 flex flex-wrap items-center gap-2">
                              <span className="font-medium text-gray-900">{drift.configName}</span>
                              {drift.lastRevertedAt && !drift.isRevertDrift && (
                                <span className="flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                                  <Check className="h-3 w-3" />
                                  Reverted {getRelativeTime(drift.lastRevertedAt)}
                                </span>
                              )}
                              {drift.isRevertDrift && (
                                <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-gray-600">
                                  <Info className="h-3 w-3" />
                                  Result of Revert
                                </span>
                              )}
                            </span>
                            {drift.previousName && <span className="mb-1 block text-xs text-gray-500">Renamed from "{drift.previousName}"</span>}
                            {drift.changeType === "modified" && drift.changes && drift.changes.length > 0 && (
                              <span className="block text-sm text-gray-600">
                                <span className="font-medium text-gray-700">{drift.changes.length} changed setting{drift.changes.length === 1 ? "" : "s"}:</span> {settings}
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-3">
                            <span className={cn("inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium", style.tone)}>
                              <style.Icon className="h-3 w-3" aria-hidden="true" />
                              {style.label}
                            </span>
                            <ChevronDown className={cn("h-4 w-4 text-gray-500 transition-transform", open && "rotate-180")} aria-hidden="true" />
                          </span>
                        </button>

                        {open && (
                          <div id={`drift-${drift.id}`} className="mx-6 space-y-3 border-t border-gray-100 pb-6 pt-5">
                            {drift.isRevertDrift && (
                              <div className="bg-gray-50 rounded-2xl p-4">
                                <h4 className="font-medium text-gray-900 mb-1">Revert Drift Information</h4>
                                <p className="text-sm text-gray-700">
                                  This change was detected because you reverted the policy on {new Date(drift.revertTimestamp!).toLocaleString()}.
                                  This is expected behavior and no action is needed.
                                </p>
                              </div>
                            )}

                            {drift.changes && drift.changes.length > 0 && (
                              <div className="bg-gray-50 rounded-2xl p-4">
                                <h4 className="font-medium text-gray-900 mb-3">Changed settings</h4>
                                <ChangeList changes={drift.changes} names={result.settingNames} />
                              </div>
                            )}

                            {drift.changeType !== "modified" && itemDetails(drift)}

                            {drift.revertHistory && drift.revertHistory.length > 0 && (
                              <div className="bg-green-50 rounded-2xl px-4 py-3">
                                <h4 className="font-medium text-green-900 text-sm mb-2">Revert History</h4>
                                <div className="space-y-1">
                                  {drift.revertHistory.map((revert, idx) => (
                                    <div key={idx} className="flex items-center justify-between text-xs text-green-700">
                                      <span className="flex items-center gap-2">
                                        <RefreshCw className="h-3 w-3" />
                                        {revert.action === "revert" ? "Reverted" : "Restored as new policy"}
                                      </span>
                                      <span>{new Date(revert.timestamp).toLocaleString()}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {!drift.lastRevertedAt && !drift.isRevertDrift && (drift.changeType === "deleted" || drift.changeType === "modified") && (
                              <div className="flex flex-wrap items-center gap-2">
                                <GatedButton
                                  feature="driftRevert"
                                  plan={plan}
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRevertAction(drift)}
                                  disabled={revertingDriftId === drift.id}
                                >
                                  <RefreshCw className="h-4 w-4 mr-1" />
                                  {drift.changeType === "deleted" ? "Recreate" : "Revert"}
                                </GatedButton>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRestoreAction(drift)}
                                  disabled={revertingDriftId === drift.id}
                                >
                                  {revertingDriftId === drift.id ? (
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                  ) : (
                                    <Plus className="h-4 w-4 mr-1" />
                                  )}
                                  {drift.changeType === "deleted" ? "Restore as copy" : "Restore previous version as copy"}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </section>
              ))}
              <p className="px-1 text-xs text-gray-500">Copies made with Restore as copy (named "[Restored] ...") are not listed as added.</p>
            </div>
          )}
        </>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmDialog} onOpenChange={(open) => { if (!open) setConfirmDialog(null) }}>
        {confirmDialog && (
          <DialogContent className="max-w-md p-8">
            {/* Icon */}
            <div className="flex justify-center mb-6">
              <div className={cn(
                "h-16 w-16 rounded-full flex items-center justify-center",
                confirmDialog.action === "revert" 
                  ? "bg-red-50 text-red-600" 
                  : "bg-blue-50 text-blue-600"
              )}>
                {confirmDialog.action === "revert" ? (
                  <RefreshCw className="h-8 w-8" />
                ) : (
                  <Plus className="h-8 w-8" />
                )}
              </div>
            </div>
            
            {/* Content */}
            <div className="text-center mb-8">
              <DialogTitle className="text-2xl font-medium tracking-tight text-gray-900 mb-3">{confirmDialog.title}</DialogTitle>
              <DialogDescription className="text-gray-600 leading-relaxed">{confirmDialog.message}</DialogDescription>
            </div>
            
            {/* Policy Info */}
            <div className="bg-gray-50 rounded-2xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-gray-400" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">Policy Name</p>
                  <p className="text-sm text-gray-600">{drifts.find(d => d.id === confirmDialog.driftId)?.configName}</p>
                </div>
              </div>
            </div>
            
            {/* Actions */}
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setConfirmDialog(null)}
              >
                Cancel
              </Button>
              {confirmDialog.action === "revert" ? (
                <Button variant="destructive" className="flex-1 font-medium" onClick={executeRevert}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {confirmDialog.recreate ? "Recreate policy" : "Revert policy"}
                </Button>
              ) : (
                <Button className="flex-1 text-white font-medium bg-coral-600 hover:bg-coral-700" onClick={executeRevert}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create copy
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
      
      {/* Revert Progress Modal */}
      <RevertProgressModal
        isOpen={progressModal.isOpen}
        onClose={() => setProgressModal(prev => ({ ...prev, isOpen: false }))}
        action={progressModal.action}
        policyName={progressModal.policyName}
        currentStep={progressModal.currentStep}
        error={progressModal.error}
        isComplete={progressModal.isComplete}
        isSuccess={progressModal.isSuccess}
        newPolicyId={progressModal.newPolicyId}
        policyType={progressModal.policyType}
        onComplete={(success) => {
          setProgressModal(prev => ({ ...prev, isOpen: false }))
          // Reset the progress modal state
          setTimeout(() => {
            setProgressModal({
              isOpen: false,
              action: "revert",
              policyName: "",
              currentStep: 0,
              error: null,
              isComplete: false,
              isSuccess: false
            })
          }, 300)
        }}
      />
    </div>
  )
}