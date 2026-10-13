import { queueEvent } from './outbox'
import { 
  type AuditLogEntry, 
  type CreateAuditLogInput,
  type AuditUser,
  type AuditContext,
  AuditSeverity,
  AuditResult,
  getDefaultSeverity
} from './types'
import { AuditStorageService } from './storage'
import { headers } from 'next/headers'
import { randomUUID } from 'node:crypto'

interface AuditLoggerConfig {
  storageAccountName: string
  accessToken: string
  enableConsoleLogging?: boolean
  enableAsyncWrite?: boolean
}

interface SessionInfo {
  user: AuditUser
  sessionId: string
  correlationId?: string
}

class AuditLogger {
  private storageService: AuditStorageService
  private config: AuditLoggerConfig
  private sessionInfo: SessionInfo | null = null
  private writeQueue: AuditLogEntry[] = []
  private flushInterval: NodeJS.Timeout | null = null

  constructor(config: AuditLoggerConfig) {
    this.config = config
    this.storageService = new AuditStorageService({
      storageAccountName: config.storageAccountName,
      accessToken: config.accessToken,
    })

    // Start flush interval if async write is enabled
    if (config.enableAsyncWrite) {
      this.startFlushInterval()
    }
  }

  setSession(sessionInfo: SessionInfo): void {
    this.sessionInfo = sessionInfo
  }

  clearSession(): void {
    this.sessionInfo = null
  }

  private async getContext(): Promise<AuditContext> {
    const headersList = await headers()
    const ipAddress = headersList.get('x-forwarded-for') || 
                     headersList.get('x-real-ip') || 
                     'unknown'
    const userAgent = headersList.get('user-agent') || 'unknown'
    
    return {
      ipAddress: ipAddress.split(',')[0]?.trim() || 'unknown', // Handle multiple IPs
      userAgent,
      sessionId: this.sessionInfo?.sessionId,
      correlationId: this.sessionInfo?.correlationId || randomUUID(),
      requestId: randomUUID(),
    }
  }

  private async createLogEntry(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    const context = await this.getContext()
    const user = this.sessionInfo?.user || {
      id: 'system',
      email: 'system@tenuvault.com',
      name: 'System',
    }

    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      severity: input.severity || getDefaultSeverity(input.eventType),
      user,
      action: input.action,
      resource: input.resource,
      result: input.result || AuditResult.SUCCESS,
      context,
      details: input.details,
      duration: input.duration,
      tags: input.tags,
    }
  }

  async queue(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    const entry = await this.createLogEntry(input)
    queueEvent(this.config.storageAccountName, entry)
    return entry
  }

  async log(input: CreateAuditLogInput): Promise<void> {
    const entry = await this.queue(input)

    // Console logging for debugging
    if (this.config.enableConsoleLogging) {
      console.log('[AUDIT]', {
        timestamp: entry.timestamp,
        eventType: entry.eventType,
        user: entry.user.email,
        action: entry.action,
        resource: `${entry.resource.type}:${entry.resource.name}`,
        result: entry.result,
      })
    }

    // Write to storage
    if (this.config.enableAsyncWrite) {
      this.writeQueue.push(entry)
    } else {
      await this.writeToStorage(entry)
    }
  }

  private async writeToStorage(entry: AuditLogEntry): Promise<void> {
    await this.storageService.writeLog(entry)
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      void this.flush().catch((error) => console.error("[AUDIT] Events remain queued:", error))
    }, 5000) // Flush every 5 seconds
  }

  async flush(): Promise<void> {
    if (this.writeQueue.length === 0) return

    const entries = [...this.writeQueue]
    this.writeQueue = []

    // Write entries in parallel
    const results = await Promise.allSettled(entries.map(entry => this.writeToStorage(entry)))
    const failed = entries.filter((_entry, index) => results[index]?.status === 'rejected')
    this.writeQueue.unshift(...failed)
    if (failed.length) throw new Error(`${failed.length} audit event(s) remain unsaved and queued for retry`)
  }

  async destroy(): Promise<void> {
    // Clear the timer even when flushing fails.
    // Clear the flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
    await this.flush()
  }

  // Convenience methods for common operations
  async logSuccess(action: string, resource: any, details?: any): Promise<void> {
    await this.log({
      eventType: this.getEventTypeFromAction(action),
      action,
      resource,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      details,
    })
  }

  async logFailure(action: string, resource: any, error: any, details?: any): Promise<void> {
    await this.log({
      eventType: this.getEventTypeFromAction(action),
      action,
      resource,
      result: AuditResult.FAILURE,
      severity: AuditSeverity.ERROR,
      details: {
        ...details,
        error: {
          code: error.code || 'UNKNOWN',
          message: error.message || String(error),
          stack: error.stack,
        },
      },
    })
  }

  async logWarning(action: string, resource: any, details?: any): Promise<void> {
    await this.log({
      eventType: this.getEventTypeFromAction(action),
      action,
      resource,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      details,
    })
  }

  async logSecurity(action: string, resource: any, details?: any): Promise<void> {
    await this.log({
      eventType: this.getEventTypeFromAction(action),
      action,
      resource,
      result: AuditResult.FAILURE,
      severity: AuditSeverity.CRITICAL,
      details,
    })
  }

  private getEventTypeFromAction(action: string): any {
    // Map common actions to event types
    const actionMap: Record<string, any> = {
      // Auth
      'user.login': 'AUTH_LOGIN',
      'user.logout': 'AUTH_LOGOUT',
      'user.login.failed': 'AUTH_FAILED',
      
      // Tenant
      'tenant.create': 'TENANT_CREATED',
      'tenant.update': 'TENANT_UPDATED',
      'tenant.delete': 'TENANT_DELETED',
      'tenant.select': 'TENANT_SELECTED',
      
      // Backup
      'backup.start': 'BACKUP_STARTED',
      'backup.complete': 'BACKUP_COMPLETED',
      'backup.fail': 'BACKUP_FAILED',
      'backup.download': 'BACKUP_DOWNLOADED',
      
      // Schedule
      'schedule.create': 'SCHEDULE_CREATED',
      'schedule.update': 'SCHEDULE_UPDATED',
      'schedule.delete': 'SCHEDULE_DELETED',
      'schedule.enable': 'SCHEDULE_ENABLED',
      'schedule.disable': 'SCHEDULE_DISABLED',
      'schedule.trigger': 'SCHEDULE_TRIGGERED',
      
      // Policy
      'policy.revert': 'POLICY_REVERTED',
      'policy.restore': 'POLICY_RESTORED',
      'policy.drift.detect': 'POLICY_DRIFT_DETECTED',
      
      // Security
      'security.permission.denied': 'SECURITY_PERMISSION_DENIED',
      'security.suspicious': 'SECURITY_SUSPICIOUS_ACTIVITY',
    }

    return actionMap[action] || 'CONFIG_UPDATED'
  }
}

// Singleton instance management
let loggerInstance: AuditLogger | null = null

export function initializeAuditLogger(config: AuditLoggerConfig): AuditLogger {
  if (loggerInstance) {
    void loggerInstance.destroy().catch((error) => console.error("[AUDIT] Pending events remain in the retry queue:", error))
  }
  loggerInstance = new AuditLogger(config)
  return loggerInstance
}

export function getAuditLogger(): AuditLogger {
  if (!loggerInstance) {
    throw new Error('Audit logger not initialized. Call initializeAuditLogger first.')
  }
  return loggerInstance
}

// Helper function to create logger for API routes
export async function createAuditLogger(
  storageAccountName: string,
  accessToken: string,
  user?: AuditUser
): Promise<AuditLogger> {
  const logger = new AuditLogger({
    storageAccountName,
    accessToken,
    enableConsoleLogging: process.env.NODE_ENV === 'development',
    enableAsyncWrite: false,
  })

  if (user) {
    logger.setSession({
      user,
      sessionId: randomUUID(),
    })
  }


  return logger
}

// Export types for convenience
export type { AuditLogger, AuditLoggerConfig, SessionInfo }