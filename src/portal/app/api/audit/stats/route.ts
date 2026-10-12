import { isGuid } from "../../../../../shared/security"
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

    // Get access token for Azure Storage
    const accessToken = await getAccessToken(tenantId, appId, clientSecret)

    // Create storage service
    const storageService = new AuditStorageService({
      storageAccountName,
      accessToken,
    })

    // Parse filter parameters (stats might use a different date range)
    const auditFilter: AuditLogFilter = {
      tenantId,
      startDate: filter?.startDate ? new Date(filter.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Default: last 30 days
      endDate: filter?.endDate ? new Date(filter.endDate) : new Date(),
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
    }

    // Get statistics
    const stats = await storageService.getStats(auditFilter)

    // Add additional computed stats
    const enhancedStats = {
      ...stats,
      recentFailures: stats.recentFailures.map(redactAuditEntry),
      securityEvents: stats.securityEvents.map(redactAuditEntry),
      summary: {
        totalEvents: stats.totalEvents,
        successRate: stats.totalEvents > 0 
          ? ((stats.eventsByResult.SUCCESS || 0) / stats.totalEvents * 100).toFixed(2) + '%'
          : '0%',
        failureRate: stats.totalEvents > 0
          ? ((stats.eventsByResult.FAILURE || 0) / stats.totalEvents * 100).toFixed(2) + '%'
          : '0%',
        criticalEvents: stats.eventsBySeverity.CRITICAL || 0,
        securityAlerts: stats.securityEvents.length,
        mostActiveUser: stats.topUsers[0] || null,
        mostAccessedResource: stats.topResources[0] || null,
      },
      trends: {
        hourlyAverage: stats.eventsByHour.length > 0
          ? (stats.eventsByHour.reduce((sum, h) => sum + h.count, 0) / stats.eventsByHour.length).toFixed(2)
          : 0,
        peakHour: stats.eventsByHour.reduce((peak, current) => 
          current.count > (peak?.count || 0) ? current : peak, 
          stats.eventsByHour[0]
        ),
      },
    }

    return NextResponse.json({
      success: true,
      data: enhancedStats,
      filter: auditFilter,
    })

  } catch (error) {
    if (error instanceof AuditRangeError) return NextResponse.json({ error: error.message }, { status: 400 })
    console.error("Audit stats error:", error)
    return NextResponse.json(
      { error: "Internal server error while fetching audit statistics" },
      { status: 500 }
    )
  }
}