import { assertStorageAccountName } from "../../shared/storage-account"

export type BlobVersion = { etag: string; serverTime?: number; modifiedAt?: number }
export type BlobRecord = BlobVersion & { value: unknown }
export interface ApprovalBlobs {
  get(name: string): Promise<BlobRecord | null>
  match?(name: string, etag: string): Promise<BlobVersion | null>
  put(name: string, value: unknown, etag?: string): Promise<boolean>
  list(prefix: string): Promise<string[]>
  delete?(name: string, etag: string): Promise<boolean>
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
}

export function approvalBlobs(account: string, token: string, fetchImpl: typeof fetch): ApprovalBlobs {
  assertStorageAccountName(account)
  const root = `https://${account}.blob.core.windows.net/intune-backups`
  const url = (name: string) => `${root}/${name.split("/").map(encodeURIComponent).join("/")}`
  const headers = { authorization: `Bearer ${token}`, "x-ms-version": "2023-11-03" }
  const request = (target: string, init?: RequestInit) => fetchImpl(target, {
    ...init, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { ...headers, ...init?.headers },
  })
  const fail = (status: number) => new Error(`The tenant approval store could not be verified (HTTP ${status}).`)
  const version = (response: Response): BlobVersion => {
    const etag = response.headers.get("etag")
    if (!etag) throw fail(response.status)
    const time = (header: string) => {
      const parsed = Date.parse(response.headers.get(header) ?? "")
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return { etag, serverTime: time("date"), modifiedAt: time("last-modified") }
  }
  return {
    async get(name) {
      const response = await request(url(name))
      if (response.status === 404 && response.headers.get("x-ms-error-code") === "BlobNotFound") {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw fail(response.status)
      return { ...version(response), value: await response.json().catch(() => null) }
    },
    async match(name, etag) {
      const response = await request(url(name), { method: "HEAD", headers: { "if-match": etag } })
      if (response.status === 412 || response.status === 404 && response.headers.get("x-ms-error-code") === "BlobNotFound") return null
      if (!response.ok) throw fail(response.status)
      return version(response)
    },
    async put(name, value, etag) {
      const response = await request(url(name), {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "content-type": "application/json",
          ...(etag === undefined ? { "if-none-match": "*" } : { "if-match": etag }),
        },
        body: JSON.stringify(value),
      })
      await response.body?.cancel()
      if (response.status === 412) return false
      if (!response.ok) throw fail(response.status)
      return true
    },
    async delete(name, etag) {
      const response = await request(url(name), { method: "DELETE", headers: { "if-match": etag } })
      await response.body?.cancel()
      if (response.status === 412 || response.status === 404) return false
      if (!response.ok) throw fail(response.status)
      return true
    },
    async list(prefix) {
      const names: string[] = []
      const seen = new Set<string>()
      let marker = ""
      do {
        const query = new URLSearchParams({ restype: "container", comp: "list", prefix, marker })
        const response = await request(`${root}?${query}`)
        if (!response.ok) throw fail(response.status)
        const xml = await response.text()
        if (!xml.includes("<EnumerationResults") || !xml.includes("</EnumerationResults>")) throw new Error("The tenant approval list is invalid.")
        names.push(...Array.from(xml.matchAll(/<Name>([^<]*)<\/Name>/g), match => unescapeXml(match[1]!)).filter(name => name.startsWith(prefix)))
        marker = unescapeXml(/<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? "")
        if (marker && seen.has(marker)) throw new Error("The tenant approval list did not finish.")
        seen.add(marker)
      } while (marker)
      return names
    },
  }
}
