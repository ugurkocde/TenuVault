import { completeHalf, largeRunProblems, matchingCompanions, ordinaryOnlyManifest, withRunRecord } from "../../../../shared/backup-companion"
import { backupStoragePath, isLargeBackup } from "../../../../shared/backup-storage"
import { exportLargeArchive, exportMixedArchive } from "../../../../main/backup/large-archive"
import { Readable } from "node:stream"
import { readJsonCapped } from "../../../../shared/capped-body"
import { decodeXml } from "~/lib/storage/list"
import { isSafeArchivePath } from "../../../../shared/security"
import { isBackupName } from "../../../../shared/intune/backup-names"
import { BACKUP_OWNER_FILE, BACKUP_RUN_RECORD_FILE, MAX_BACKUP_ARCHIVE_BYTES, MAX_BACKUP_ARCHIVE_FILES, MAX_BACKUP_ARCHIVE_TOTAL_BYTES } from "../../../../shared/constants"
import { readBytesCapped } from "../../../../shared/capped-body"
import { type NextRequest, NextResponse } from "next/server"
import { readOwnedBackup, type BackupOwnerRead } from "~/lib/policies/backup-owner"

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

/** How long a split run's record may take before the early manifest stands. */
const RUN_RECORD_TIMEOUT_MS = 10_000

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

    const readFile = (name: string, signal?: AbortSignal) => fetch(`https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(name)}`, {
      headers: { "x-ms-version": "2021-12-02", Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    })
    const readJson = async (name: string, signal?: AbortSignal) => {
      const response = await readFile(name, signal)
      if (!response.ok) throw new Error(`A backup file could not be read (${response.status})`)
      const content = await readJsonCapped(response, 8 * 1024 * 1024)
      if (content.kind !== "json") throw new Error("A backup file is invalid or oversized")
      return content.value as Record<string, any>
    }
    const readLarge = (name: string) => readJson(`${backupId}/${name}`)
    // Ownership is checked before either archive path reads snapshots.
    let ordinaryExport: Record<string, any> | null = null
    const archiveResponse = async (largeOwner: BackupOwnerRead): Promise<NextResponse | null> => {
      if (!largeOwner.ok) return NextResponse.json({ error: largeOwner.error }, { status: largeOwner.status })
      let metadata = largeOwner.metadata
      // A record that exists but could not be read in time says nothing about the run, so the full
      // download is offered again instead of being refused as incomplete.
      let recordUnavailable = false
      // A record that is absent or not valid JSON names no run, the same way history reads it.
      const missing = (error: unknown) => error instanceof Error && (error.message.includes("(404)") || error.message.includes("invalid or oversized"))
      // An ordinary-only copy needs neither the run record nor the companion, so large storage never delays it.
      const ordinaryOnlyRequest = body.ordinaryOnly === true && !isLargeBackup(backupId)
      // A split run whose early manifest could not be replaced keeps its final result in its own record.
      if (metadata && !ordinaryOnlyRequest && !isLargeBackup(backupId) && metadata.CompanionBackup !== undefined && typeof metadata.RunStatus !== "string") {
        let record: Record<string, any> | null = null
        try { record = await readJson(`${backupId}/${BACKUP_RUN_RECORD_FILE}`, AbortSignal.timeout(RUN_RECORD_TIMEOUT_MS)) } catch (error) { recordUnavailable = !missing(error) }
        metadata = withRunRecord(backupId, metadata, record) ?? metadata
      }
      if (metadata && (metadata.CompanionBackup !== undefined || metadata.LargeBackupOutcomes !== undefined)) {
        const otherId = metadata.CompanionBackup
        let other: Record<string, any> | null = null
        if (!ordinaryOnlyRequest && typeof otherId === "string" && isBackupName(otherId)) {
          try { other = await readJson(`${otherId}/metadata.json`) } catch { /* The ordinary subset remains exportable. */ }
          if (other && isLargeBackup(backupId) && typeof other.RunStatus !== "string") {
            let record: Record<string, any> | null = null
            try { record = await readJson(`${otherId}/${BACKUP_RUN_RECORD_FILE}`, AbortSignal.timeout(RUN_RECORD_TIMEOUT_MS)) } catch (error) { recordUnavailable = !missing(error) }
            other = withRunRecord(otherId, other, record) ?? other
          }
        }
        const matches = matchingCompanions(backupId, metadata, otherId, other) && metadata.TenantId?.toLowerCase() === String(tenantId).toLowerCase()
        if (matches && completeHalf(metadata) && completeHalf(other) && !largeRunProblems(isLargeBackup(backupId) ? other! : metadata).length && body.ordinaryOnly !== true) {
          const ordinaryId = isLargeBackup(backupId) ? otherId : backupId, largeId = isLargeBackup(backupId) ? backupId : otherId
          const ordinary = isLargeBackup(backupId) ? other! : metadata, large = isLargeBackup(backupId) ? metadata : other!
          const stream = Readable.from(exportMixedArchive(tenantId, ordinaryId, ordinary, largeId, large, readJson))
          return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
            headers: { "content-type": "application/x-tar", "content-disposition": `attachment; filename="${ordinaryId}.tar"` },
          })
        }
        if (recordUnavailable && body.ordinaryOnly !== true) return NextResponse.json({ error: "The run's final result could not be read in time, so the full download did not start. Try again in a moment, or download the ordinary items only.", ordinaryOnlyAvailable: !isLargeBackup(backupId) }, { status: 503 })
        if (isLargeBackup(backupId) || body.ordinaryOnly !== true) return NextResponse.json({ error: "The mixed run is incomplete or its companion does not match. Choose Download ordinary only to export the ordinary snapshots.", ordinaryOnlyAvailable: !isLargeBackup(backupId) }, { status: 409 })
        ordinaryExport = ordinaryOnlyManifest(metadata, ordinaryOnlyRequest ? "An ordinary-only copy was requested." : matches ? "Large companion is incomplete, or an ordinary-only copy was requested." : "Large companion is missing, unreadable or does not match.")
        // Without the run's record an early manifest's placeholders say nothing about the large types, so
        // the copy names them as left out without claiming why.
        if (ordinaryOnlyRequest && typeof metadata.RunStatus !== "string") {
          const export_ = ordinaryExport.Export as { omittedLargeTypes: Array<Record<string, unknown>> }
          ordinaryExport = { ...ordinaryExport, Export: { ...export_, omittedLargeTypes: export_.omittedLargeTypes.map(problem => ({ ...problem, reason: "Not included in this ordinary-only copy." })) } }
        }
      }
      if (largeOwner?.ok && largeOwner.metadata?.LargeItems) {
        const stream = Readable.from(exportLargeArchive(tenantId, backupId, largeOwner.metadata, readLarge))
        return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
          headers: { "content-type": "application/x-tar", "content-disposition": `attachment; filename="${backupId}.tar"` },
        })
      }

      if (isLargeBackup(backupId)) return NextResponse.json({ error: "Only complete large backups can be downloaded" }, { status: 409 })
      return null
    }
    // Preserve legacy listing, path and size refusals before any file GET. Large declarations
    // or a history hint select streaming before those ordinary ZIP limits are applied.
    const earlyOwner = isLargeBackup(backupId) || body.largeInventory === true
      ? await readOwnedBackup(readFile, backupId, tenantId, storageAccountName) : null
    if (earlyOwner) {
      const response = await archiveResponse(earlyOwner)
      if (response) return response
    }

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
            if (blobName && !blobName.endsWith('/') && blobName !== `${backupId}/${BACKUP_OWNER_FILE}` && blobName !== `${backupId}/${BACKUP_RUN_RECORD_FILE}`) {
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
    if (totalBytes > MAX_BACKUP_ARCHIVE_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Download refused: this backup totals ${totalBytes} bytes, more than the 128 MiB limit for a backup download. Restore the backup from Backup Details instead of downloading it, or choose a smaller backup.` },
        { status: 413 }
      )
    }

    // Archive entries must stay inside the folder they are extracted to.
    const unsafe = filePaths.find((path) => !isSafeArchivePath(path.replace(`${backupId}/`, '')))
    if (unsafe !== undefined) {
      return NextResponse.json({ error: "Download failed: the backup contains a file name that is not a safe archive path." }, { status: 502 })
    }

    if (!earlyOwner) {
      const response = await archiveResponse(await readOwnedBackup(readFile, backupId, tenantId, storageAccountName))
      if (response) return response
    }

    // Import JSZip dynamically
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()

    // Process files in batches to avoid overwhelming the system
    const batchSize = 20 // Increased batch size for better performance
    const results: Array<{success: boolean, path: string}> = []
    let processedFiles = 0

    // Ownership is settled by the shared resolver before any file is read: a shared container can
    // hold other tenants' backups, and those are refused, as are backups whose metadata or
    // ownership marker cannot be read.
    const batches: string[][] = []
    for (let i = 0; i < filePaths.length; i += batchSize) batches.push(filePaths.slice(i, i + batchSize))
    // Actual fetched bytes, rechecked against the cap: listed lengths can be
    // missing or understated, and the archive is built in memory.
    let fetchedBytes = 0
    let oversized = false

    for (const batch of batches) {
      const batchPromises = batch.map(async (filePath) => {
        try {
          const fileUrl = `https://${storageAccountName}.blob.core.windows.net/${backupStoragePath(filePath)}`

          const fileResponse = await fetch(fileUrl, {
            headers: {
              'x-ms-version': '2021-12-02',
              'Authorization': `Bearer ${accessToken}`,
            },
          })

          if (fileResponse.ok) {
            const content = await readBytesCapped(fileResponse, Math.min(MAX_BACKUP_ARCHIVE_BYTES, Math.max(0, MAX_BACKUP_ARCHIVE_TOTAL_BYTES - fetchedBytes)))
            if (content === null) {
              oversized = true
              return { success: false, path: filePath }
            }
            fetchedBytes += content.byteLength
            if (fetchedBytes > MAX_BACKUP_ARCHIVE_TOTAL_BYTES) oversized = true
            // Remove the backup folder prefix from the path in the zip
            const zipPath = filePath.replace(`${backupId}/`, '')

            // Add file to zip with folder structure
            zip.file(zipPath, zipPath === "metadata.json" && ordinaryExport ? JSON.stringify(ordinaryExport) : content)

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
      if (oversized) {
        return NextResponse.json(
          { error: `Download refused: this backup's files are larger than a backup download allows (32 MiB per file, 128 MiB in total), although the listing reported less. Restore the backup from Backup Details instead of downloading it, or choose a smaller backup.` },
          { status: 413 }
        )
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
        'Content-Disposition': `attachment; filename="${backupId}${ordinaryExport ? "-ordinary-only" : ""}.zip"`,
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
