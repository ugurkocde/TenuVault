import { decodeXml } from "~/lib/storage/list"
import { blobPath, isSafeArchivePath } from "../../../../shared/security"
import { isBackupName } from "../../../../shared/intune/backup-names"
import { BACKUP_OWNER_FILE, MAX_BACKUP_ARCHIVE_BYTES, MAX_BACKUP_ARCHIVE_FILES } from "../../../../shared/constants"
import { type NextRequest, NextResponse } from "next/server"
import { OTHER_TENANT_BACKUP, ownedBy, readOwnedBackup } from "~/lib/policies/backup-owner"

interface ListedFile {
  path: string
  /** Content length from the listing, or null when storage did not report one. */
  size: number | null
}

async function getAccessToken(tenantId: string, appId: string, clientSecret: string) {
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
    throw new Error("Failed to get access token")
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
      backupId
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !backupId) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    // Only a real backup folder name may be listed: a multi-segment or reserved prefix such
    // as "metadata/<tenant-guid>" would otherwise zip another tenant's revert history.
    if (!isBackupName(backupId)) {
      return NextResponse.json({ error: "Invalid backup ID" }, { status: 400 })
    }

    // Get access token for Azure Storage
    const accessToken = await getAccessToken(tenantId, appId, clientSecret)

    // Function to fetch all files with pagination support
    const fetchAllFiles = async (): Promise<ListedFile[]> => {
      const allFiles: ListedFile[] = []
      const seenMarkers = new Set<string>()
      let marker: string | null = null
      let hasMore = true

      while (hasMore) {
        // Build URL with optional marker for pagination
        let listUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&prefix=${encodeURIComponent(`${backupId}/`)}&maxresults=5000`
        if (marker) {
          listUrl += `&marker=${encodeURIComponent(marker)}`
        }

        const listResponse = await fetch(listUrl, {
          headers: {
            'x-ms-version': '2021-12-02',
            'Authorization': `Bearer ${accessToken}`,
          },
        })

        if (!listResponse.ok) {
          throw new Error("Failed to list backup contents")
        }

        const xmlText = await listResponse.text()

        // More robust XML parsing - look for all Name elements within Blob elements
        const blobMatches = xmlText.match(/<Blob>[\s\S]*?<\/Blob>/g) || []

        for (const blobXml of blobMatches) {
          const nameMatch = blobXml.match(/<Name>(.*?)<\/Name>/)
          if (nameMatch && nameMatch[1]) {
            const blobName = decodeXml(nameMatch[1])
            // Include all files (skip directories which don't have content)
            if (blobName && !blobName.endsWith('/') && blobName !== `${backupId}/${BACKUP_OWNER_FILE}`) {
              const sizeMatch = blobXml.match(/<Content-Length>(\d+)<\/Content-Length>/)
              const size = sizeMatch ? Number(sizeMatch[1]) : null
              allFiles.push({ path: blobName, size: size !== null && Number.isSafeInteger(size) ? size : null })
            }
          }
        }

        // Check if there's a NextMarker indicating more results
        const nextMarkerMatch = xmlText.match(/<NextMarker>(.*?)<\/NextMarker>/)
        if (nextMarkerMatch && nextMarkerMatch[1]) {
          marker = decodeXml(nextMarkerMatch[1])
          if (seenMarkers.has(marker)) throw new Error("Storage returned a repeated continuation marker")
          seenMarkers.add(marker)
        } else {
          hasMore = false
        }
      }

      return allFiles
    }

    const listedFiles = await fetchAllFiles()
    const filePaths = listedFiles.map((file) => file.path)
    console.log(`Found ${filePaths.length} files to download from backup ${backupId}`)

    // Log file breakdown by folder for debugging
    const folderCounts: Record<string, number> = {}
    const sampleFiles: Record<string, string[]> = {}

    filePaths.forEach(path => {
      // Extract folder name (the part after backup-id/)
      const parts = path.split('/')
      const folder = parts[1] || 'root'

      // Count files per folder
      folderCounts[folder] = (folderCounts[folder] || 0) + 1

      // Keep sample files for each folder (first 2)
      if (!sampleFiles[folder]) sampleFiles[folder] = []
      if (sampleFiles[folder].length < 2) {
        sampleFiles[folder].push(path)
      }
    })

    console.log('Files per folder:', folderCounts)
    console.log('Sample files by folder:', sampleFiles)

    if (filePaths.length === 0) {
      return NextResponse.json(
        { error: "No files found in backup" },
        { status: 404 }
      )
    }

    // Refuse oversized backups before fetching any file body. The archive is
    // built in memory, so an unbounded backup could kill the app instead of
    // returning an actionable error. Files without a listed length fall back
    // to the file count cap below.
    if (listedFiles.length > MAX_BACKUP_ARCHIVE_FILES) {
      return NextResponse.json(
        { error: `Download refused: this backup has ${listedFiles.length} files, more than the ${MAX_BACKUP_ARCHIVE_FILES} file limit for a backup download. Restore the backup from Backup Details instead of downloading it, or choose a smaller backup.` },
        { status: 413 }
      )
    }
    const totalBytes = listedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0)
    if (totalBytes > MAX_BACKUP_ARCHIVE_BYTES) {
      return NextResponse.json(
        { error: `Download refused: this backup totals ${totalBytes} bytes, more than the 32 MiB limit for a backup download. Restore the backup from Backup Details instead of downloading it, or choose a smaller backup.` },
        { status: 413 }
      )
    }

    // Archive entries must stay inside the folder they are extracted to.
    const unsafe = filePaths.find((path) => !isSafeArchivePath(path.replace(`${backupId}/`, '')))
    if (unsafe !== undefined) {
      return NextResponse.json({ error: "Download failed: the backup contains a file name that is not a safe archive path." }, { status: 502 })
    }

    // Import JSZip dynamically
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()

    // Process files in batches to avoid overwhelming the system
    const batchSize = 20 // Increased batch size for better performance
    const results: Array<{success: boolean, path: string}> = []
    let processedFiles = 0

    // The backup's metadata is read first, on its own: a shared container can hold other
    // tenants' backups, and those are refused before any other file is read. A backup without
    // metadata is placed by its ownership marker.
    const metadataPath = `${backupId}/metadata.json`
    if (!filePaths.includes(metadataPath)) {
      const owned = await readOwnedBackup((name) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${blobPath(name)}`, {
        headers: { 'x-ms-version': '2021-12-02', 'Authorization': `Bearer ${accessToken}` },
      }), backupId, tenantId)
      if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
    }
    const others = filePaths.filter((path) => path !== metadataPath)
    const batches: string[][] = others.length === filePaths.length ? [] : [[metadataPath]]
    for (let i = 0; i < others.length; i += batchSize) batches.push(others.slice(i, i + batchSize))
    let ownership: string | null = null
    let untagged = false

    for (const batch of batches) {
      const batchPromises = batch.map(async (filePath) => {
        try {
          const fileUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups/${blobPath(filePath)}`

          const fileResponse = await fetch(fileUrl, {
            headers: {
              'x-ms-version': '2021-12-02',
              'Authorization': `Bearer ${accessToken}`,
            },
          })

          if (fileResponse.ok) {
            const content = await fileResponse.arrayBuffer()
            if (filePath === metadataPath) {
              let metadata: unknown
              try { metadata = JSON.parse(new TextDecoder().decode(content)) } catch { ownership = "The backup metadata could not be read." }
              if (!ownership && !ownedBy(metadata, tenantId)) ownership = OTHER_TENANT_BACKUP
              untagged = !ownership && typeof (metadata as { TenantId?: unknown } | null)?.TenantId !== "string"
            }
            // Remove the backup folder prefix from the path in the zip
            const zipPath = filePath.replace(`${backupId}/`, '')

            // Add file to zip with folder structure
            zip.file(zipPath, content)

            processedFiles++
            if (processedFiles % 10 === 0 || processedFiles === filePaths.length) {
              console.log(`Progress: ${processedFiles}/${filePaths.length} files processed`)
            }

            return { success: true, path: filePath }
          } else {
            console.error(`Failed to fetch file: ${filePath}, status: ${fileResponse.status}`)
            return { success: false, path: filePath }
          }
        } catch (error) {
          console.error(`Error fetching file ${filePath}:`, error)
          return { success: false, path: filePath }
        }
      })

      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)
      // Ownership is settled by the metadata batch before any other file is read.
      if (batch[0] === metadataPath && !ownership && !batchResults[0]?.success) ownership = "The backup metadata could not be read."
      if (ownership) return NextResponse.json({ error: ownership }, { status: ownership === OTHER_TENANT_BACKUP ? 403 : 502 })
      // Metadata that records no tenant is placed by the ownership marker, as the backup list does.
      if (batch[0] === metadataPath && untagged) {
        const owned = await readOwnedBackup((name) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${blobPath(name)}`, {
          headers: { 'x-ms-version': '2021-12-02', 'Authorization': `Bearer ${accessToken}` },
        }), backupId, tenantId)
        if (!owned.ok) return NextResponse.json({ error: owned.error }, { status: owned.status })
      }
    }

    const successCount = results.filter(r => r.success).length
    const failedCount = results.filter(r => !r.success).length

    console.log(`Download summary: ${successCount} successful, ${failedCount} failed out of ${filePaths.length} total files`)

    if (successCount === 0) {
      return NextResponse.json(
        { error: "Failed to fetch any files from backup" },
        { status: 500 }
      )
    }

    if (failedCount > 0) {
      return NextResponse.json({ error: `Download failed: ${failedCount} backup files could not be read. Retry to download a complete archive.` }, { status: 502 })
    }

    zip.file("tenuvault-manifest.json", JSON.stringify({ version: 1, sourceTenantId: tenantId, backupId }))

    // Generate zip file
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6
      }
    })

    // Return the zip file as a response
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${backupId}.zip"`,
        'Content-Length': zipBuffer.length.toString(),
      },
    })
  } catch (error) {
    console.error("Download backup error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error while downloading backup" },
      { status: 500 }
    )
  }
}
