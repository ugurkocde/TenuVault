import { normalizeBackupStatus, backupHealth, backupSummary, latestComplete } from "~/lib/backup-health"
import { useLicense, tenantLicense, tenantPlan } from "@desktop/lib/license"
import { allows } from "../../../shared/plans"
import { bridge } from "@desktop/lib/bridge"
import { useQuery } from "@tanstack/react-query"
import { useTenants } from "~/contexts/TenantContext"
import type { DashboardStats, BackupHistoryItem, ScheduleInfo } from "~/types/dashboard"

const debugLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== "production") {
    console.debug("[dashboard]", ...args)
  }
}

function truncateMessage(message: string, maxLength = 120) {
  if (!message) return ""
  if (message.length <= maxLength) return message
  return `${message.slice(0, maxLength - 3)}...`
}

/** Policies in a backup, counted by type from its folder layout (see /api/list-backups). */
export interface PolicyBreakdown {
  deviceConfigurations: number
  compliancePolicies: number
  configurationPolicies: number
  appProtectionPolicies: number
  conditionalAccess: number
}

export type DashboardBackup = BackupHistoryItem & { policies?: PolicyBreakdown }

/** A backup attempt that failed without saving a backup, recorded by the app on this device. */
export interface FailedAttemptItem {
  tenantId: number
  timestamp: Date
  message: string
}

interface BackupHistoryResult {
  items: DashboardBackup[]
  /** Why the backups could not be listed; null when the list is complete. */
  error: string | null
}

/** Dashboard stats plus the details the tile layout shows for the selected tenant. */
export interface TenantDashboardStats extends DashboardStats {
  latestBackup: DashboardBackup | null
  latestCompleteBackup: DashboardBackup | null
  /** Every backup in storage, newest first, across reporting periods. */
  backupHistory: DashboardBackup[]
  /** Attempts that failed without saving a backup, newest first. They count as failed in their period. */
  failedAttempts: FailedAttemptItem[]
  /** Start of the selected reporting period. Pass all three to backupSummary for the tile counts. */
  periodStart: Date
  /** Set when the backup list could not be loaded, so an empty list is not shown as "no backups". */
  backupsError: string | null
  /** The most recent saved drift comparison, read through the desktop fetch bridge. */
  lastDriftCheck: { time: Date; succeeded: boolean } | null
}

async function fetchBackupHistory(tenant: any): Promise<BackupHistoryResult> {
  if (!tenant.credentials || !tenant.resources) return { items: [], error: "Backup storage is not configured." }
  
  try {
    const response = await fetch("/api/list-backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: true,
        tenantId: tenant.credentials.tenantId,
        appId: tenant.credentials.appId,
        clientSecret: tenant.credentials.clientSecret,
        subscriptionId: tenant.resources.subscriptionId,
        resourceGroupName: tenant.resources.resourceGroupName,
        storageAccountName: tenant.resources.storageAccountName,
      }),
    })
    
    if (!response.ok) {
      console.error("Failed to fetch backups:", response.status)
      const body = await response.json().catch(() => null) as { error?: string } | null
      return { items: [], error: body?.error ?? "Backups could not be loaded." }
    }
    
    const data = await response.json()
    debugLog("backup history fetched", { tenant: tenant.name, count: Array.isArray(data) ? data.length : data?.backups?.length })
    
    // Handle both array and object with backups property
    const backups = Array.isArray(data) ? data : (data.backups || [])
    
    const items: DashboardBackup[] = backups.map((backup: any) => ({
      id: backup.name,
      tenantId: tenant.id,
      tenantName: tenant.name,
      timestamp: new Date(backup.lastModified || backup.properties?.lastModified || backup.timestamp),
      status: normalizeBackupStatus(backup),
      policiesBackedUp: backup.metadata?.policyCount || backup.policyCount || backup.totalPolicies || 0, // Use actual count from backup
      duration: backup.duration || 0,
      size: backup.size || backup.properties?.contentLength || 0,
      error: backup.error || backup.errorMessage || backup.properties?.errorMessage,
      policies: backup.policies,
    })).sort((a: BackupHistoryItem, b: BackupHistoryItem) => 
      b.timestamp.getTime() - a.timestamp.getTime() // Sort by newest first
    )
    return { items, error: null }
  } catch (error) {
    console.error("Error fetching backup history for", tenant.name, ":", error)
    return { items: [], error: "Backups could not be loaded." }
  }
}

/** Failed attempts are kept by the app on this device, for every plan. */
async function fetchFailedAttempts(tenant: any): Promise<FailedAttemptItem[]> {
  const tenantId = tenant.credentials?.tenantId
  if (!tenantId) return []
  try {
    const attempts = await bridge.backups.failedAttempts(tenantId)
    return attempts.map((attempt) => ({ tenantId: tenant.id, timestamp: new Date(attempt.at), message: attempt.message }))
  } catch (error) {
    console.error("Error reading failed backup attempts for", tenant.name, ":", error)
    return []
  }
}

/** Reads saved scan time independently of audit history and the current plan. */
async function fetchDriftCheck(tenant: any): Promise<TenantDashboardStats["lastDriftCheck"]> {
  if (!tenant.credentials?.tenantId) return null
  try {
    const response = await fetch("/api/drift-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "result", tenantId: tenant.credentials.tenantId }),
    })
    if (!response.ok) return null
    const { result } = await response.json()
    const time = typeof result?.lastScan === "string" ? new Date(result.lastScan) : null
    return time && Number.isFinite(time.getTime()) ? { time, succeeded: true } : null
  } catch {
    return null
  }
}

async function fetchAuditLogs(tenant: any, limit: number = 10): Promise<any[]> {
  if (!tenant.credentials || !tenant.resources) return []
  
  try {
    const response = await fetch("/api/audit/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: tenant.credentials.tenantId,
        appId: tenant.credentials.appId,
        clientSecret: tenant.credentials.clientSecret,
        storageAccountName: tenant.resources.storageAccountName,
        filter: {
          limit,
          sortBy: 'timestamp',
          sortOrder: 'desc'
        }
      }),
    })
    
    if (!response.ok) return []
    
    const data = await response.json()
    return data.data || []
  } catch (error) {
    console.error("Error fetching audit logs:", error)
    return []
  }
}

/** Backup schedules run by the app (see Backup & Restore, Schedule tab). */
async function fetchSchedules(tenant: any): Promise<ScheduleInfo[]> {
  const tenantId = tenant.credentials?.tenantId?.toLowerCase()
  if (!tenantId) return []
  const schedules = await bridge.schedules.list()
  return schedules
    .filter((schedule) => schedule.tenantId === tenantId)
    .map((schedule) => ({
      id: schedule.tenantId,
      tenantId: tenant.id,
      tenantName: tenant.name,
      frequency: schedule.frequency,
      nextRun: schedule.nextRunAt ? new Date(schedule.nextRunAt) : new Date(),
      lastRun: schedule.lastRunAt ? new Date(schedule.lastRunAt) : null,
      isEnabled: schedule.enabled,
      time: schedule.time,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }))
}

/**
 * Backup, schedule and activity stats. With `tenantId` only that tenant is loaded, which is
 * what the per-tenant dashboard shows; without it all connected tenants are combined.
 */
export function useDashboardStats(selectedPeriod: string = "7d", tenantId?: number) {
  const allTenants = useTenants()
  const { status: license } = useLicense()
  const tenants = tenantId === undefined ? allTenants : allTenants.filter(t => t.id === tenantId)
  
  const auditAllowed = tenants.map((tenant) => {
    const plan = tenantPlan(tenantLicense(license, tenant.credentials?.tenantId))
    return plan !== null && allows(plan, "auditLog")
  })
  return useQuery({
    queryKey: ["dashboard-stats", tenants.map(t => t.id), selectedPeriod, auditAllowed],
    queryFn: async (): Promise<TenantDashboardStats> => {
      // Fetch data for all tenants in parallel
      const backupPromises = tenants.map(tenant => fetchBackupHistory(tenant))
      const schedulePromises = tenants.map(tenant => fetchSchedules(tenant))
      const auditPromises = tenants.map((tenant, index) => auditAllowed[index] ? fetchAuditLogs(tenant, 20) : Promise.resolve([]))
      
      const [allBackups, allSchedules, allAuditLogs, driftChecks, allFailedAttempts] = await Promise.all([
        Promise.all(backupPromises),
        Promise.all(schedulePromises),
        Promise.all(auditPromises),
        Promise.all(tenants.map(fetchDriftCheck)),
        Promise.all(tenants.map(fetchFailedAttempts)),
      ])
      
      // Flatten arrays
      const backupHistory = allBackups.flatMap(result => result.items)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      const backupsError = allBackups.find(result => result.error)?.error ?? null
      const schedules = allSchedules.flat()
      const auditLogs = allAuditLogs.flat()
      
      // Calculate time range based on selected period
      const now = new Date()
      const periodMs = selectedPeriod === "24h" ? 24 * 60 * 60 * 1000 :
                      selectedPeriod === "7d" ? 7 * 24 * 60 * 60 * 1000 :
                      30 * 24 * 60 * 60 * 1000
      const periodStart = new Date(now.getTime() - periodMs)
      
      // Filter backups within period
      const backupsInPeriod = backupHistory.filter(b => b.timestamp >= periodStart)
      const failedAttempts = allFailedAttempts.flat()
      const tenantHealth = tenants.map((tenant, index) => backupHealth(
        backupHistory.filter((backup) => backup.tenantId === tenant.id), now, !!allBackups[index]?.error,
      ))

      const healthyTenants = tenantHealth.filter(h => h === "healthy").length
      const warningTenants = tenantHealth.filter(h => h === "warning").length
      const criticalTenants = tenantHealth.filter(h => h === "critical").length
      
      // Find next scheduled backup
      const enabledSchedules = schedules.filter(s => s.isEnabled)
      const nextSchedule = enabledSchedules.length > 0 
        ? enabledSchedules.reduce((prev, curr) => 
            curr.nextRun < prev.nextRun ? curr : prev
          )
        : null
      
      // Calculate trend (compare to previous period)
      const prevPeriodStart = new Date(periodStart.getTime() - periodMs)
      const successRate = backupSummary(backupHistory, failedAttempts, { since: periodStart }).successRate
      const prevSuccessRate = backupSummary(backupHistory, failedAttempts, { since: prevPeriodStart, until: periodStart }).successRate
      const trend = successRate !== null && prevSuccessRate !== null ? successRate - prevSuccessRate : 0
      
      // Create recent activity from audit logs and backups
      const auditActivity = auditLogs
        .filter((log: any) => log.timestamp)
        .map((log: any) => ({
          id: log.id || `audit-${log.timestamp}`,
          type: log.eventType?.includes('BACKUP') ? "backup" as const : 
                log.eventType?.includes('SCHEDULE') ? "schedule" as const :
                log.eventType?.includes('POLICY') ? "policy" as const :
                log.eventType?.includes('AUTH') ? "auth" as const :
                "backup" as const,
          status: log.result === 'SUCCESS' ? "success" as const : 
                  log.result === 'FAILURE' ? "failed" as const : 
                  log.severity === 'WARNING' ? "warning" as const : 
                  "info" as const,
          tenant: log.resource?.name || log.user?.name || "System",
          tenantId: 0, // Audit logs don't have tenant ID
          time: new Date(log.timestamp),
          message: log.action || log.eventType || "Activity logged",
          details: log,
        }))
      
      const backupActivity = backupsInPeriod
        .map(backup => ({
          id: backup.id,
          type: "backup" as const,
          status: backup.status === "success" ? "success" as const : backup.status === "failed" ? "failed" as const : backup.status === "running" ? "info" as const : "warning" as const,
          tenant: backup.tenantName,
          tenantId: backup.tenantId,
          time: backup.timestamp,
          message: backup.status === "failed"
            ? `Backup failed${backup.error ? `: ${truncateMessage(backup.error)}` : ""}`
            : backup.status === "partial"
              ? `Backup completed with warnings - ${backup.policiesBackedUp} policies`
              : backup.status === "success" ? `Backup completed successfully - ${backup.policiesBackedUp} policies`
              : backup.status === "running" ? "Backup is still running"
              : backup.status === "incomplete" ? "Backup is incomplete" : "Backup status is unknown",
          details: backup,
        }))
      
      // Combine and sort all activities
      const recentActivity = [...auditActivity, ...backupActivity]
        .sort((a, b) => b.time.getTime() - a.time.getTime())
        .slice(0, 10)
      
      return {
        tenants: {
          total: tenants.length,
          healthy: healthyTenants,
          warning: warningTenants,
          critical: criticalTenants,
        },
        backups: {
          scheduled: enabledSchedules.length,
          trend,
        },
        nextBackup: nextSchedule ? {
          tenantName: nextSchedule.tenantName,
          tenantId: nextSchedule.tenantId,
          scheduledTime: nextSchedule.nextRun,
          type: nextSchedule.frequency,
        } : null,
        recentActivity,
        latestBackup: backupHistory[0] ?? null,
        latestCompleteBackup: latestComplete(backupHistory),
        backupHistory,
        failedAttempts,
        periodStart,
        backupsError,
        lastDriftCheck: driftChecks.filter(check => check !== null)
          .sort((a, b) => b.time.getTime() - a.time.getTime())[0] ?? null,
      }
    },
    enabled: tenants.length > 0,
    refetchInterval: 30000, // Refetch every 30 seconds
  })
}
