import { backupBlobName, backupContainer, logicalBackupName, LARGE_STORAGE_UNAVAILABLE } from "../../../shared/backup-storage"
export function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export class BlobListError extends Error {
  constructor(readonly status: number, readonly body: string, readonly completedPages = 0) {
    super(`Backup storage could not be read (${status}). Check storage access and retry.`)
  }
}

/**
 * Keep continuation tokens intact and never turn a failed page into an empty listing. With a
 * signal, an aborted listing requests no further pages.
 */
export async function listBlobPages(url: string, token: string, signal?: AbortSignal): Promise<string> {
  const target = new URL(url)
  const prefix = target.searchParams.get('prefix') ?? ''
  const largePayload = prefix.startsWith('backup-large-') && prefix.includes('/')
  if (largePayload) {
    target.pathname = `/${backupContainer(prefix)}`
    target.searchParams.set('prefix', backupBlobName(prefix))
  }
  const pages: string[] = []
  const seen = new Set<string>()
  let marker = ''
  do {
    target.searchParams.set('marker', marker)
    signal?.throwIfAborted()
    const response = await fetch(target, { headers: { 'x-ms-version': '2021-12-02', Authorization: `Bearer ${token}` }, signal })
    if (!response.ok) throw new BlobListError(response.status, await response.text().catch(() => ''), pages.length)
    const xml = await response.text()
    pages.push(xml)
    marker = decodeXml(/<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? '')
    if (marker && seen.has(marker)) throw new Error('Storage returned a repeated continuation marker')
    seen.add(marker)
  } while (marker)
  return largePayload ? logicalBackupListing(pages.join('\n')) : pages.join('\n')
}

export function logicalBackupListing(xml: string): string {
  return xml.replace(/<Name>([^<]+)<\/Name>/g, (_, name: string) => `<Name>${logicalBackupName(name)}</Name>`)
}

/** Optional large discovery never makes ordinary inventory unavailable. */
export async function listLargeBackupPages(url: string, token: string, warnings: string[], signal?: AbortSignal): Promise<string> {
  try { return await listBlobPages(url, token, signal) }
  catch (error) {
    signal?.throwIfAborted()
    warnings.push(`${LARGE_STORAGE_UNAVAILABLE}${error instanceof BlobListError ? ` Storage returned ${error.status}.` : ""}`)
    return ""
  }
}

/** An imported large archive may be the only container on this device. */
export async function listOrdinaryBackupPages(url: string, token: string, signal?: AbortSignal): Promise<string> {
  try { return await listBlobPages(url, token, signal) }
  catch (error) {
    if (error instanceof BlobListError && error.status === 404) return ""
    throw error
  }
}
