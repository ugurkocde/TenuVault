import { isGuid } from "../../../../../shared/security"
import { pendingEvents, auditOutboxIsDurable } from "~/lib/audit/outbox"
import { type NextRequest, NextResponse } from "next/server"
import { AuditStorageService, AuditRangeError } from "~/lib/audit/storage"
import { redactAuditEntry } from "~/lib/audit/export"
import { AuditLogFilter, AuditEventType, AuditSeverity, AuditResult } from "~/lib/audit/types"

async function getAccessToken(tenantId: string, appId: string, clientSecret: string): Promise<string> {
  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: clientSecret,
        scope: "https://storage.azure.com/.default",
        grant_type: "client_credentials",
      }),
    }
  )

  if (!tokenResponse.ok) {
    throw new Error("Failed to authenticate")
  }

  const tokenData = await tokenResponse.json()
  return tokenData.access_token
}

export async function POST(request: NextRequest) {
  let account = ""
  try {
    const body = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret, 
      storageAccountName,
      filter
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    if (!isGuid(tenantId)) {
      return NextResponse.json({ error: "Invalid tenant ID" }, { status: 400 })
    }

    account = storageAccountName
    // Get access token for Azure Storage
    const accessToken = await getAccessToken(tenantId, appId, clientSecret)

    // Create storage service
    const storageService = new AuditStorageService({
      storageAccountName,
      accessToken,
    })

    // Parse filter parameters
    const auditFilter: AuditLogFilter = {
      tenantId,
      startDate: filter?.startDate ? new Date(filter.startDate) : undefined,
      endDate: filter?.endDate ? new Date(filter.endDate) : undefined,
      eventTypes: filter?.eventTypes as AuditEventType[],
      severities: filter?.severities as AuditSeverity[],
      userIds: filter?.userIds,
      userEmails: filter?.userEmails,
      resourceTypes: filter?.resourceTypes,
      resourceIds: filter?.resourceIds,
      results: filter?.results as AuditResult[],
      searchQuery: filter?.searchQuery,
      ipAddress: filter?.ipAddress,
      tags: filter?.tags,
      limit: filter?.limit ?? 100,
      offset: filter?.offset ?? 0,
      sortBy: filter?.sortBy,
      sortOrder: filter?.sortOrder,
    }

    // Query logs
    const pendingCount = await storageService.retryPending()
    const logs = await storageService.queryLogs(auditFilter)

    return NextResponse.json({
      success: true,
      data: logs.map(redactAuditEntry),
      count: logs.length,
      pendingCount,
      pendingDurable: auditOutboxIsDurable(),
      filter: auditFilter,
    })

  } catch (error) {
    if (error instanceof AuditRangeError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("Query audit logs error:", error)
    let pendingCount: number | null = null
    try { if (account) pendingCount = pendingEvents(account).length } catch { /* Preserve unknown pending state. */ }
    return NextResponse.json(
      { error: "Internal server error while querying audit logs", pendingCount, pendingDurable: auditOutboxIsDurable() },
      { status: 500 }
    )
  }
}