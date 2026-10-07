"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { AlertCircle, AlertTriangle, Calendar, CheckCircle, Download, GitBranch, Loader2, Play, RefreshCw, Upload } from "lucide-react"
import { useSelectedTenant, useTenantOperations, useTenants } from "~/contexts/TenantContext"
import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { BackupProgressModal } from "~/components/tenants/backup-progress-modal"
import { BackupChangesDialog } from "~/components/backup/backup-changes-dialog"
import { RestoreWizard } from "~/components/backup/restore-wizard"
import { formatDate, formatDuration, formatSize, STATUS_LABEL, statusKind, TRIGGER_LABEL, type BackupSummary, type BackupTenant, type StatusKind } from "~/components/backup/types"
import { BackupSchedulePanel } from "@desktop/components/BackupSchedulePanel"
import { RunBackupDialog } from "@desktop/components/RunBackupDialog"
import { useTenantPlan } from "@desktop/lib/license"
import { useBackupList } from "@desktop/lib/backup-list"
import { allows } from "../../../../shared/plans"
import { AREAS } from "../../../../shared/intune/scope"
import { typeForFolder } from "../../../../shared/intune/registry"
import { storageLabel } from "~/lib/storage-label"

type Tab = "backup" | "restore" | "schedule"

const NO_BACKUPS: BackupSummary[] = []

const STATUS_STYLE: Record<StatusKind, { icon: typeof CheckCircle; iconBg: string; iconColor: string; badge: string }> = {
  success: { icon: CheckCircle, iconBg: "bg-green-50", iconColor: "text-green-700", badge: "bg-green-50 text-green-700" },
  warning: { icon: AlertTriangle, iconBg: "bg-amber-50", iconColor: "text-amber-700", badge: "bg-amber-50 text-amber-800" },
  failed: { icon: AlertCircle, iconBg: "bg-red-50", iconColor: "text-red-600", badge: "bg-red-50 text-red-700" },
  running: { icon: Loader2, iconBg: "bg-blue-50", iconColor: "text-blue-600", badge: "bg-blue-50 text-blue-700" },
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Changes since the previous backup; `first` when no older backup exists. */
function ChangesText({ backup, first }: { backup: BackupSummary; first: boolean }) {
  if (!backup.changes) return <span className="text-gray-500" title={first ? undefined : "Made by an older version, or the backup before it did not finish"}>{first ? "First backup" : "Not compared"}</span>
  const { added, modified, removed } = backup.changes
  if (added + modified + removed === 0) return <span>None</span>
  return (
    <span className="flex flex-wrap gap-x-2">
      {added > 0 && <span className="text-green-700">+{added}</span>}
      {modified > 0 && <span className="text-amber-800">~{modified}</span>}
      {removed > 0 && <span className="text-red-700">-{removed}</span>}
    </span>
  )
}

export default function BackupRestorePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get("tab")
  const activeTab: Tab = requested === "restore" || requested === "schedule" ? requested : "backup"
  const setActiveTab = (tab: Tab) => setSearchParams({ tab })

  const tenants = useTenants()
  const { selectedTenantId, selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const { updateTenant } = useTenantOperations()
  const plan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  const community = plan === "community"
  // Copying to other tenants is an MSP action; the main process also checks every target.
  const canCopyToTenants = plan !== null && allows(plan, "bulkActions")

  // Shared with the drift page and kept between visits: shown at once, refreshed in the background.
  const backupList = useBackupList(selectedTenant)
  const backups = backupList.backups ?? NO_BACKUPS
  const isLoading = backupList.loading && backupList.backups === null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restoreFrom, setRestoreFrom] = useState<string | null>(null)
  const [setupError, setSetupError] = useState("")
  const error = setupError || backupList.error
  // A failed refresh leaves the kept list (and its Refresh button) shown below the error.
  const blockingError = setupError || (backupList.backups === null ? backupList.error : "")
  const [runOpen, setRunOpen] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [showProgress, setShowProgress] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const detailRef = useRef<HTMLDivElement | null>(null)

  const tenant: BackupTenant | null = useMemo(
    () =>
      selectedTenant?.credentials && selectedTenant.resources?.storageAccountName
        ? { name: selectedTenant.name, credentials: selectedTenant.credentials, storageAccountName: selectedTenant.resources.storageAccountName }
        : null,
    [selectedTenant?.name, selectedTenant?.credentials, selectedTenant?.resources?.storageAccountName],
  )
  const copyCandidates = tenants
    .filter((entry) => entry.id !== selectedTenantId && entry.credentials?.tenantId && entry.credentials.appId)
    .map((entry) => ({ tenantId: entry.credentials!.tenantId, appId: entry.credentials!.appId, name: entry.name, domain: entry.domain }))
  const selected = backups.find((backup) => backup.id === selectedId) ?? null
  const latest = backups.find((backup) => backup.counts && statusKind(backup.status) === "success")

  useEffect(() => {
    if (!selectedTenantId && tenants[0]) setSelectedTenantId(tenants[0].id)
  }, [tenants, selectedTenantId, setSelectedTenantId])

  // A refresh keeps the selected backup while it is still listed.
  useEffect(() => {
    setSelectedId((current) => (current && backups.some((backup) => backup.id === current) ? current : backups[0]?.id ?? null))
  }, [backups])

  const fetchBackups = () => backupList.refresh({ force: true })

  useEffect(() => {
    setRestoreFrom(null)
    setSetupError("")
    if (!selectedTenant) return
    if (!selectedTenant.credentials || !selectedTenant.resources?.storageAccountName) {
      setSetupError(!selectedTenant.credentials ? "Tenant credentials are missing. Please reconfigure the tenant." : "Backup storage is not configured for this tenant. Choose local or Azure storage in Settings.")
    }
  }, [selectedTenant?.id, !!selectedTenant?.credentials, selectedTenant?.resources?.storageAccountName])

  const backupStarted = (id: string) => {
    setJobId(id)
    setShowProgress(true)
  }

  const backupFinished = (success: boolean) => {
    setShowProgress(false)
    setJobId(null)
    if (success && selectedTenant) {
      updateTenant(selectedTenant.id, { lastBackup: new Date().toISOString(), lastSync: new Date().toISOString() })
      // Show the new backup, the newest in the list.
      setSelectedId(null)
      void fetchBackups()
    }
  }

  const download = async (backup: BackupSummary) => {
    if (!tenant) return
    setIsDownloading(true)
    try {
      const response = await fetch("/api/download-backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, backupId: backup.id }),
      })
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Failed to download backup")
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement("a")
      link.href = url
      link.download = `${backup.id}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (failure) {
      alert(`Failed to download backup: ${failure instanceof Error ? failure.message : "Unknown error"}`)
    } finally {
      setIsDownloading(false)
    }
  }

  const restore = (backup: BackupSummary) => {
    setRestoreFrom(backup.id)
    setActiveTab("restore")
  }

  return (
    <div className="space-y-8 p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-medium tracking-tight text-gray-900">Backup & Restore</h1>
          <p className="mt-2 text-base text-gray-500">Back up Intune, see what changed, and restore items from any backup</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {tenants.length > 0 && (
            <Select value={selectedTenantId?.toString()} onValueChange={(value) => setSelectedTenantId(Number(value))}>
              <SelectTrigger aria-label="Select tenant" className="h-11 w-[240px]">
                <SelectValue placeholder="Select a tenant" />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id.toString()}>
                    <div className="flex items-center gap-2">
                      <div className={cn("h-2 w-2 rounded-full", entry.status === "healthy" ? "bg-green-500" : entry.status === "warning" ? "bg-amber-500" : "bg-red-500")} />
                      {entry.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="lg" className="cursor-pointer bg-coral-600 text-white hover:bg-coral-700" disabled={!tenant} onClick={() => setRunOpen(true)}>
            <Play className="h-4 w-4" />
            Run Backup
          </Button>
        </div>
      </div>

      <nav className="inline-flex flex-wrap gap-1 rounded-full bg-white p-1.5 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
        {[
          { id: "backup" as const, label: "Backup History", icon: Download },
          { id: "restore" as const, label: "Restore", icon: Upload },
          { id: "schedule" as const, label: "Schedule", icon: Calendar },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              if (tab.id === "restore") setRestoreFrom(null)
              setActiveTab(tab.id)
            }}
            className={cn(
              "flex h-10 items-center gap-2 rounded-full px-5 text-sm font-medium transition-colors",
              activeTab === tab.id ? "bg-primary text-primary-foreground" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900",
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </nav>

      {tenants.length === 0 && (
        <div className="flex gap-3 rounded-3xl bg-amber-50 p-5">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
          <div>
            <h3 className="text-sm font-medium text-amber-900">No tenants configured</h3>
            <p className="mt-1 text-sm text-amber-800">Please add a tenant first to view backup history.</p>
          </div>
        </div>
      )}

      {activeTab !== "schedule" && selectedTenant && isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          <span className="ml-2 text-gray-600">Loading backups...</span>
        </div>
      )}
      {activeTab !== "schedule" && selectedTenant && error && !isLoading && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {activeTab === "backup" && selectedTenant && !isLoading && !blockingError && (
        <div className="space-y-6">
          <div className="rounded-3xl bg-white p-6 sm:p-8">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-medium tracking-tight text-gray-900">Backup Timeline</h2>
              <Button variant="outline" size="sm" onClick={() => void fetchBackups()} disabled={backupList.loading}>
                <RefreshCw className={cn("mr-2 h-4 w-4", backupList.loading && "animate-spin")} />
                Refresh
              </Button>
            </div>

            {backups.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
                  <Download className="h-6 w-6 text-gray-500" />
                </div>
                <p className="font-medium text-gray-900">No backups found for this tenant</p>
                <p className="mt-1 text-sm text-gray-500">Run a backup to see it appear here</p>
              </div>
            ) : (
              <div className="-mx-2 space-y-1">
                {backups.map((backup) => {
                  const kind = statusKind(backup.status)
                  const style = STATUS_STYLE[kind]
                  return (
                    <div key={backup.id} className="flex gap-4">
                      <div className={cn("ml-2 mt-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-full", style.iconBg)}>
                        <style.icon className={cn("h-5 w-5", style.iconColor, kind === "running" && "animate-spin")} />
                      </div>
                      <button
                        type="button"
                        className={cn("flex-1 rounded-2xl border p-4 text-left transition-colors", selectedId === backup.id ? "border-blue-200" : "border-transparent hover:bg-gray-50")}
                        onClick={() => {
                          setSelectedId(backup.id)
                          requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
                        }}
                      >
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <div>
                            <h3 className="font-medium text-gray-900">{formatDate(backup.timestamp)}</h3>
                            <p className="text-sm text-gray-500">{backup.scope ? backup.scope.description : "Everything (made before backup choices existed)"}</p>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            {backup.type && <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", backup.type === "scheduled" ? "bg-blue-50 text-blue-700" : "bg-muted text-gray-700")}>{TRIGGER_LABEL[backup.type]}</span>}
                            {kind !== "success" && <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", style.badge)}>{backup.status === "incomplete" ? "Incomplete" : STATUS_LABEL[kind]}</span>}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-4 text-sm xl:grid-cols-4">
                          <div>
                            <span className="text-xs text-gray-500">Items</span>
                            <p className="mt-0.5 font-medium text-gray-900">{backup.totalPolicies}</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Size</span>
                            <p className="mt-0.5 font-medium text-gray-900">{formatSize(backup.size)}</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Duration</span>
                            <p className="mt-0.5 font-medium text-gray-900">{formatDuration(backup.duration)}</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-500">Changes</span>
                            <div className="mt-0.5 font-medium text-gray-900">
                              <ChangesText backup={backup} first={backup.id === backups[backups.length - 1]?.id} />
                            </div>
                          </div>
                        </div>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {selected && tenant && (
            <BackupDetails
              ref={detailRef}
              backup={selected}
              first={selected.id === backups[backups.length - 1]?.id}
              storageAccountName={tenant.storageAccountName}
              downloading={isDownloading}
              onChanges={() => setChangesOpen(true)}
              onDownload={() => void download(selected)}
              onRestore={() => restore(selected)}
            />
          )}
        </div>
      )}

      {activeTab === "restore" && tenant && !isLoading && !blockingError && (
        <RestoreWizard
          key={`${selectedTenant?.id}:${restoreFrom ?? ""}`}
          tenant={tenant}
          backups={backups}
          initialBackupId={restoreFrom}
          community={community}
          canCopyToTenants={canCopyToTenants}
          copyCandidates={copyCandidates}
        />
      )}

      {activeTab === "schedule" && selectedTenant?.credentials && <BackupSchedulePanel tenantId={selectedTenant.credentials.tenantId} tenantName={selectedTenant.name} />}

      <RunBackupDialog open={runOpen} onOpenChange={setRunOpen} tenant={tenant} counts={latest?.counts} uncounted={latest ? [...(latest.scope?.excluded ?? []), ...(latest.skippedTypes ?? [])] : undefined} onStarted={backupStarted} />

      {selectedTenant && jobId && (
        <BackupProgressModal
          open={showProgress}
          onOpenChange={setShowProgress}
          tenantName={selectedTenant.name}
          credentials={selectedTenant.credentials ? { tenantId: selectedTenant.credentials.tenantId, appId: selectedTenant.credentials.appId, clientSecret: selectedTenant.credentials.clientSecret } : null}
          resources={
            selectedTenant.resources
              ? { subscriptionId: selectedTenant.resources.subscriptionId, resourceGroupName: selectedTenant.resources.resourceGroupName, automationAccountName: selectedTenant.resources.automationAccountName }
              : null
          }
          jobId={jobId}
          onComplete={backupFinished}
        />
      )}

      {selected && tenant && (
        <BackupChangesDialog
          open={changesOpen}
          onOpenChange={setChangesOpen}
          tenant={tenant}
          backup={selected}
          previous={backups.find((backup) => backup.id === selected.comparedWith)}
        />
      )}
    </div>
  )
}

interface BackupDetailsProps {
  backup: BackupSummary
  first: boolean
  storageAccountName: string
  downloading: boolean
  onChanges: () => void
  onDownload: () => void
  onRestore: () => void
  ref: React.Ref<HTMLDivElement>
}

/** Everything known about one backup, from its metadata and file listing. */
function BackupDetails({ backup, first, storageAccountName, downloading, onChanges, onDownload, onRestore, ref }: BackupDetailsProps) {
  const kind = statusKind(backup.status)
  const counts = backup.counts ?? {}
  const excluded = new Set(backup.scope?.excluded ?? [])
  const areas = AREAS.map(({ area, types }) => ({
    area,
    count: types.reduce((sum, type) => sum + (counts[type.folder] ?? 0), 0),
    types: types.filter((type) => !excluded.has(type.folder) && (counts[type.folder] ?? 0) > 0),
    left: types.filter((type) => excluded.has(type.folder)).length,
    all: types.length,
  }))
  const typeLabel = (folder: string) => capitalize(typeForFolder(folder)?.label ?? folder)

  return (
    <div ref={ref} className="rounded-3xl bg-white p-6 sm:p-8">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-medium tracking-tight text-gray-900">Backup Details</h2>
          <p className="text-sm text-gray-500">{formatDate(backup.timestamp)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onChanges} disabled={!backup.changes} title={backup.changes ? undefined : "There is no earlier backup to compare this one with, or it was made by an older version."}>
            <GitBranch className="mr-1 h-4 w-4" />
            View Changes
          </Button>
          <Button variant="outline" size="sm" onClick={onDownload} disabled={downloading}>
            {downloading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
            Download
          </Button>
          <Button size="sm" className="bg-coral-600 text-white hover:bg-coral-700" onClick={onRestore} disabled={kind === "running" || backup.totalPolicies === 0}>
            <RefreshCw className="mr-1 h-4 w-4" />
            Restore from this backup
          </Button>
        </div>
      </div>

      {(kind === "warning" || kind === "failed" || (backup.skippedTypes?.length ?? 0) > 0) && (
        <div className={cn("mb-6 flex gap-3 rounded-2xl px-4 py-3 text-sm", kind === "failed" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900")}>
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="space-y-1">
            {backup.status === "incomplete" && <p>This backup stopped before it finished, for example because TenuVault was closed. It holds only part of the tenant.</p>}
            {(backup.failures ?? 0) > 0 && <p>{backup.failures} item{backup.failures === 1 ? "" : "s"} or type{backup.failures === 1 ? "" : "s"} could not be read. The backup log lists them.</p>}
            {(backup.failedTypes?.length ?? 0) > 0 && <p>Not read: {backup.failedTypes!.map(typeLabel).join(", ")}.</p>}
            {(backup.skippedTypes?.length ?? 0) > 0 && <p>Left out because access was denied: {backup.skippedTypes!.map(typeLabel).join(", ")}. Grant admin consent for the app registration in Microsoft Entra, or run the setup script again, and check that your Intune role covers these items.</p>}
          </div>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
        {[
          ["Items", String(backup.totalPolicies)],
          ["Size", formatSize(backup.size)],
          ["Duration", formatDuration(backup.duration)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-gray-50 p-4">
            <span className="text-xs text-gray-500">{label}</span>
            <p className="mt-1 text-2xl font-medium tracking-tight text-gray-900">{value}</p>
          </div>
        ))}
        <div className="rounded-2xl bg-gray-50 p-4">
          <span className="text-xs text-gray-500">Changes since the previous backup</span>
          <div className="mt-1 text-2xl font-medium tracking-tight text-gray-900">
            <ChangesText backup={backup} first={first} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-medium text-gray-500">Contents</h3>
          <div className="space-y-2">
            {areas
              .filter((entry) => entry.count > 0 || entry.left < entry.all)
              .map((entry) => (
                <details key={entry.area} className="group rounded-xl bg-gray-50 px-3 py-2.5 text-sm">
                  <summary className="flex cursor-pointer list-none items-center justify-between">
                    <span className="text-gray-700">{entry.area}</span>
                    <span className="font-medium text-gray-900">{entry.count}</span>
                  </summary>
                  <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2 text-xs">
                    {entry.types.map((type) => (
                      <li key={type.folder} className="flex justify-between text-gray-600">
                        <span>{capitalize(type.label)}</span>
                        <span>{counts[type.folder]}</span>
                      </li>
                    ))}
                    {entry.types.length === 0 && <li className="text-gray-500">No items of these types in the tenant.</li>}
                    {entry.left > 0 && <li className="text-gray-500">{entry.left} type{entry.left === 1 ? "" : "s"} not included in this backup</li>}
                  </ul>
                </details>
              ))}
            {areas
              .filter((entry) => entry.left === entry.all)
              .map((entry) => (
                <div key={entry.area} className="flex justify-between rounded-xl px-3 py-2 text-sm text-gray-500">
                  <span>{entry.area}</span>
                  <span>Not included</span>
                </div>
              ))}
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-xs font-medium text-gray-500">About this backup</h3>
          <dl className="divide-y divide-gray-100 text-sm">
            {[
              ["Status", backup.status === "incomplete" ? "Incomplete" : STATUS_LABEL[kind]],
              ["Started", backup.type ? TRIGGER_LABEL[backup.type] : "Not recorded"],
              ["Included", backup.scope ? backup.scope.description : "Everything"],
              ["Stored", storageLabel(storageAccountName)],
              ["Backup ID", backup.id],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2.5 first:pt-0">
                <dt className="text-gray-500">{label}</dt>
                <dd className={cn("text-right font-medium text-gray-900", label === "Backup ID" && "font-mono text-xs")}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
