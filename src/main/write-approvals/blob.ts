import { assertStorageAccountName } from "../../shared/storage-account"

export type BlobRecord = { value: unknown; etag: string }
export interface ApprovalBlobs {
  get(name: string): Promise<BlobRecord | null>
  put(name: string, value: unknown, etag?: string): Promise<boolean>
  list(prefix: string): Promise<string[]>
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
  return {
    async get(name) {
      const response = await request(url(name))
      if (response.status === 404 && response.headers.get("x-ms-error-code") === "BlobNotFound") {
        await response.body?.cancel()
        return null
      }
      const etag = response.headers.get("etag")
      if (!response.ok || !etag) throw fail(response.status)
      return { etag, value: await response.json() }
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
