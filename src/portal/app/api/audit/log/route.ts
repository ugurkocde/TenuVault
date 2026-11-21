import { mainAuditSink } from "../../../../../main/api/audit-sink"
import { isGuid } from "../../../../../shared/security"
import { AuditStorageService } from "~/lib/audit/storage"
import { type NextRequest, NextResponse } from "next/server"
import { createAuditLogger } from "~/lib/audit/logger"
import { CreateAuditLogInput, AuditUser } from "~/lib/audit/types"

interface AuditLogRequest {
  tenantId: string
  appId: string
  clientSecret: string
  storageAccountName: string
  user: AuditUser
  logEntry: CreateAuditLogInput
}

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
    const body: AuditLogRequest = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret, 
      storageAccountName,
      user,
      logEntry
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !user || !logEntry) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    if (!isGuid(tenantId)) {
      return NextResponse.json({ error: "Invalid tenant ID" }, { status: 400 })
    }

    const sink = mainAuditSink()
    if (sink) {
      const binding = sink.bind(tenantId)
      if (!binding) return NextResponse.json({ error: "Audit storage is unavailable" }, { status: 400 })
      await sink.record(binding, logEntry)
      return NextResponse.json({ success: true })
    }

    // Preserve the event before token acquisition or any remote storage request.
    // Each entry records its tenant, so reads return only that tenant's history even when
    // several tenants share one storage account.
    const logger = await createAuditLogger(storageAccountName, '', { id: String(user.id), email: String(user.email), name: String(user.name), tenantId: tenantId.toLowerCase() })
    const entry = await logger.queue(logEntry)
    const accessToken = await getAccessToken(tenantId, appId, clientSecret)
    const storageService = new AuditStorageService({ storageAccountName, accessToken })
    await storageService.writeLog(entry)

    return NextResponse.json({
      success: true,
      message: "Audit log entry created successfully"
    })

  } catch {
    console.error("Audit event could not be saved")
    return NextResponse.json(
      { error: "Audit event could not be saved. Pending events are kept on this device and retried when audit history is refreshed." },
      { status: 500 }
    )
  }
}