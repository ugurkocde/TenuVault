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
  return pages.join('\n')
}
