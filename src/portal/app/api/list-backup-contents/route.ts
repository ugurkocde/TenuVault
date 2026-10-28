import { decodeXml, listBlobPages } from "~/lib/storage/list"
import { INTUNE_TYPES, typeForFolder } from "../../../../shared/intune/registry"
import { blobPath, isSafeArchivePath } from "../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"
import { readOwnedBackup } from "~/lib/policies/backup-owner"

interface PolicyFile {
  name: string
  path: string
  size: number
  type: string
  displayName?: string
}

/** One Intune type in a backup, in registry order. */
interface BackupGroup {
  folder: string
  label: string
  area: string
  /** Why this type cannot be recreated, when it is kept for reference only. */
  limitation?: string
  policies: PolicyFile[]
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      tenantId,
      appId,
      clientSecret,
      subscriptionId,
      resourceGroupName,
      storageAccountName,
      backupId
    } = body

    if (!tenantId || !appId || !clientSecret || !subscriptionId || !resourceGroupName || !storageAccountName || !backupId) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    if (typeof backupId !== "string" || !isSafeArchivePath(backupId)) {
      return NextResponse.json({ error: "Invalid backup ID" }, { status: 400 })
    }

    // Get access token for Azure Storage data plane operations
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
      const errorData = await tokenResponse.text()
      console.error("Azure auth error:", errorData)
      return NextResponse.json(
        { error: "Failed to authenticate with Azure", details: errorData },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token

    // List all files in the backup folder
    const listUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${backupId}/`)}`

    const xmlText = await listBlobPages(listUrl, accessToken)

    const groups = new Map<string, BackupGroup>()
    const blobPattern = /<Blob>[\s\S]*?<Name>(.*?)<\/Name>[\s\S]*?<Content-Length>(\d+)<\/Content-Length>[\s\S]*?<\/Blob>/g
    for (const match of xmlText.matchAll(blobPattern)) {
      const blobName = decodeXml(match[1] ?? "")
      const [, folder = "", fileName = ""] = blobName.split("/")
      // Backups from older app versions stored compliance policies under this name.
      const type = typeForFolder(folder === "DeviceCompliancePolicies" ? "CompliancePolicies" : folder)
      if (!type || !fileName.endsWith(".json") || blobName.split("/").length !== 3) continue
      const group = groups.get(type.folder) ?? { folder: type.folder, label: type.label, area: type.area, ...(type.restore === "metadata" ? { limitation: type.limitation } : {}), policies: [] }
      group.policies.push({ name: fileName, path: blobName, size: parseInt(match[2]!), type: type.folder, displayName: fileName.replace(/\.json$/, "") })
      groups.set(type.folder, group)
    }

    // The backup's metadata, refused when the backup belongs to another tenant.
    const owned = await readOwnedBackup((name) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${blobPath(name)}`, {
      headers: { 'x-ms-version': '2021-12-02', 'Authorization': `Bearer ${accessToken}` },
    }), backupId, tenantId)
    if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    const metadata = owned.metadata ?? undefined

    const ordered = INTUNE_TYPES.map((type) => groups.get(type.folder)).filter((group): group is BackupGroup => !!group)
    for (const group of ordered) group.policies.sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""))

    return NextResponse.json({
      backupId,
      content: { groups: ordered, metadata },
      totalPolicies: ordered.reduce((sum, group) => sum + group.policies.length, 0),
    })
  } catch (error) {
    console.error("List backup contents error:", error)
    return NextResponse.json(
      { error: "Internal server error while listing backup contents" },
      { status: 500 }
    )
  }
}