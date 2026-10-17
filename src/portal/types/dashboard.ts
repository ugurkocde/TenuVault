import type { BackupState } from "~/lib/backup-health"

export interface DashboardStats {
  tenants: {
    total: number
    healthy: number
    warning: number
    critical: number
  }
  /** Backup counts come from backupSummary; these are what it does not cover. */
  backups: {
    scheduled: number
    trend: number // Percentage change
  }
  nextBackup: {
    tenantName: string
    tenantId: number
    scheduledTime: Date
    type: string
  } | null
  recentActivity: DashboardActivity[]
}

export interface DashboardActivity {
  id: string
  type: "backup" | "restore" | "schedule" | "policy" | "auth"
  status: "success" | "warning" | "failed" | "info"
  tenant: string
  tenantId: number
  time: Date
  message: string
  details?: any
}

export interface TenantMetrics {
  id: number
  name: string
  health: number // 0-100
  policies: {
    total: number
    backedUp: number
    compliance: number
    configuration: number
    apps: number
  }
  lastBackup: Date | null
  lastBackupStatus: "success" | "failed" | "partial"
  trend: "up" | "down" | "stable"
  trendValue: number
  storageUsed: number // in bytes
  complianceRate: number
}

export interface BackupHistoryItem {
  id: string
  tenantId: number
  tenantName: string
  timestamp: Date
  status: BackupState
  policiesBackedUp: number
  duration: number // in seconds
  size: number // in bytes
  error?: string
}

export interface ScheduleInfo {
  id: string
  tenantId: number
  tenantName: string
  frequency: "daily" | "weekly" | "monthly"
  nextRun: Date
  lastRun: Date | null
  isEnabled: boolean
  time: string // e.g., "02:00"
  timezone: string
}