import { isGuid } from "../../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"
import { AuditStorageService } from "~/lib/audit/storage"
import { AuditLogFilter, AuditEventType, AuditSeverity, AuditResult, type AuditLogEntry } from "~/lib/audit/types"
import { actorLabel, auditExportCSV, auditExportJSON, outcomeLabel, OWN_OPERATION_NOTICE, redactAuditEntry } from "~/lib/audit/export"
import { pendingEvents } from "~/lib/audit/outbox"

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

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

function generatePDFContent(logs: AuditLogEntry[]): string {
  // For now, return a simple HTML that can be converted to PDF client-side
  // In production, you might want to use a proper PDF generation library
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Audit Log Export</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 12px; }
        h1 { color: #333; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        tr:nth-child(even) { background-color: #f9f9f9; }
        .metadata { margin-bottom: 20px; color: #666; }
        .severity-ERROR { color: #dc2626; }
        .severity-WARNING { color: #f59e0b; }
        .severity-INFO { color: #3b82f6; }
        .severity-CRITICAL { color: #7c3aed; }
        .result-SUCCESS { color: #10b981; }
        .result-FAILURE { color: #ef4444; }
      </style>
    </head>
    <body>
      <h1>TenuVault Audit Log Export</h1>
      <div class="metadata">
        <p>Generated: ${new Date().toISOString()}</p>
        <p>Total Records: ${logs.length}</p>
        <p>${escape(OWN_OPERATION_NOTICE)}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Event Type</th>
            <th>Severity</th>
            <th>User</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Result</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(log => `
            <tr>
              <td>${escape(new Date(log.timestamp).toLocaleString())}</td>
              <td>${escape(log.eventType)}</td>
              <td class="severity-${escape(log.severity)}">${escape(log.severity)}</td>
              <td>${escape(actorLabel(log))}</td>
              <td>${escape(log.action)}</td>
              <td>${escape(log.resource.type)}: ${escape(log.resource.name)}</td>
              <td class="result-${escape(log.result)}">${escape(outcomeLabel(log.result))}</td>
              <td>${log.duration ? `${log.duration}ms` : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </body>
    </html>
  `
  return html
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret, 
      storageAccountName,
      exportOptions
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !exportOptions) {
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

    // Parse filter from export options
    const filter = exportOptions.filter || {}
    const auditFilter: AuditLogFilter = {
      tenantId,
      startDate: filter.startDate ? new Date(filter.startDate) : undefined,
      endDate: filter.endDate ? new Date(filter.endDate) : undefined,
      eventTypes: filter.eventTypes as AuditEventType[],
      severities: filter.severities as AuditSeverity[],
      userIds: filter.userIds,
      userEmails: filter.userEmails,
      resourceTypes: filter.resourceTypes,
      resourceIds: filter.resourceIds,
      results: filter.results as AuditResult[],
      searchQuery: filter.searchQuery,
      ipAddress: filter.ipAddress,
      tags: filter.tags,
      sortBy: filter.sortBy || 'timestamp',
      sortOrder: filter.sortOrder || 'desc',
    }

    // Every matching entry of this tenant only, independent of UI pagination.
    const logs = await storageService.queryAllLogs(auditFilter)
    let pendingCount: number | null = null
    try { pendingCount = pendingEvents(storageAccountName).length } catch { /* Reported as unknown in the export. */ }
    const meta = { tenantId, exportedAt: new Date().toISOString(), filter: auditFilter, pendingCount }

    // Generate export based on format
    let content: string
    let contentType: string
    let filename: string

    switch (exportOptions.format) {
      case 'csv':
        content = `\uFEFF${auditExportCSV(logs, meta)}`
        contentType = 'text/csv; charset=utf-8'
        filename = `tenuvault-operation-history-${new Date().toISOString().split('T')[0]}.csv`
        break

      case 'json':
        content = auditExportJSON(exportOptions.includeDetails === false ? logs.map(({ details: _details, ...log }) => log) : logs, meta)
        contentType = 'application/json'
        filename = `tenuvault-operation-history-${new Date().toISOString().split('T')[0]}.json`
        break

      case 'pdf':
        content = generatePDFContent(logs.map(redactAuditEntry))
        contentType = 'text/html' // Return HTML for client-side PDF generation
        filename = `audit-logs-${new Date().toISOString().split('T')[0]}.html`
        break

      default:
        return NextResponse.json(
          { error: "Invalid export format" },
          { status: 400 }
        )
    }

    // Return the file content with appropriate headers
    return new NextResponse(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache',
      },
    })

  } catch (error) {
    console.error("Export audit logs error:", error)
    return NextResponse.json(
      { error: "Internal server error while exporting audit logs" },
      { status: 500 }
    )
  }
}