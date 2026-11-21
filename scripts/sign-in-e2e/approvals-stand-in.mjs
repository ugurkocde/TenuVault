import { randomUUID } from "node:crypto"

export const GRAPH_HOST = "graph.microsoft.com"
export const APPROVAL_ACCOUNT = "tenuvaultapprovale2e"
export const BLOB_HOST = `${APPROVAL_ACCOUNT}.blob.core.windows.net`
export const SOURCE_ID = "6d109622-3d78-4653-8958-2e56b26c8774"
export const BACKUP_ID = "backup-2026-11-20-010203"
export const SNAPSHOT_PATH = `${BACKUP_ID}/DeviceCategories/source.json`

const asXml = (value) => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c])

export function approvalEndpoints(tenant, issued, json) {
  const blobs = new Map()
  const policies = new Map()
  let etag = 0
  let writes = 0
  const snapshot = { id: SOURCE_ID, displayName: "Fixture category" }
  blobs.set(`/intune-backups/${BACKUP_ID}/metadata.json`, { body: JSON.stringify({ TenantId: tenant, Status: "Success" }), etag: '"backup"' })
  blobs.set(`/intune-backups/${SNAPSHOT_PATH}`, { body: JSON.stringify(snapshot), etag: '"snapshot"' })
  return {
    writes: () => writes,
    changeTarget: () => { const id = randomUUID(); policies.set(id, { id, displayName: "[Restored] Fixture category", description: "External edit" }) },
    async handle(host, url, request, response) {
      const actor = issued.get(request.headers.authorization?.replace(/^Bearer /, ""))
      const audience = host === GRAPH_HOST ? `https://${GRAPH_HOST}` : "https://storage.azure.com"
      if (!actor || actor.audience !== audience) return json(response, 403, { error: "fixture_access_refused" })
      if (host === GRAPH_HOST) {
        const path = url.pathname
        if (path === "/beta/deviceManagement/deviceCategories") {
          if (request.method === "GET") return json(response, 200, { value: [...policies.values()] })
          if (request.method === "POST") {
            const chunks = []
            for await (const chunk of request) chunks.push(chunk)
            const id = randomUUID()
            const policy = { ...JSON.parse(Buffer.concat(chunks).toString("utf8")), id }
            policies.set(id, policy)
            writes++
            return json(response, 201, policy)
          }
        }
        if (request.method === "GET" && path.startsWith("/beta/deviceManagement/deviceCategories/")) {
          const policy = policies.get(path.split("/").at(-1))
          return json(response, policy ? 200 : 404, policy ?? { error: { code: "ResourceNotFound" } })
        }
        return json(response, 404, { error: { code: "ResourceNotFound" } })
      }
      const name = decodeURIComponent(url.pathname)
      if (name.startsWith("/audit-logs") && url.searchParams.get("restype") === "container") {
        response.writeHead(200).end()
        return
      }
      if (url.searchParams.get("comp") === "list") {
        const prefix = `${name}/${url.searchParams.get("prefix") ?? ""}`
        const names = [...blobs.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(name.length + 1))
        response.writeHead(200, { "content-type": "application/xml" }).end(`<EnumerationResults><Blobs>${names.map(key => `<Blob><Name>${asXml(key)}</Name></Blob>`).join("")}</Blobs><NextMarker /></EnumerationResults>`)
      } else if (request.method === "HEAD") {
        const existing = blobs.get(name)
        if (!existing || request.headers["if-match"] !== existing.etag) response.writeHead(412).end()
        else response.writeHead(200, { etag: existing.etag }).end()
      } else if (request.method === "GET") {
        const existing = blobs.get(name)
        if (existing) response.writeHead(200, { etag: existing.etag, "content-type": "application/json" }).end(existing.body)
        else response.writeHead(404, { "x-ms-error-code": "BlobNotFound" }).end()
      } else if (request.method === "PUT") {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const existing = blobs.get(name)
        const match = request.headers["if-match"], absent = request.headers["if-none-match"]
        if ((name.includes("/.tenuvault-controls/") && !match && absent !== "*") || (match && match !== existing?.etag) || (absent === "*" && existing)) {
          response.writeHead(412).end()
        } else {
          const next = { etag: `"fixture-${++etag}"`, body: Buffer.concat(chunks).toString("utf8") }
          blobs.set(name, next)
          response.writeHead(201, { etag: next.etag }).end()
        }
      } else response.writeHead(405).end()
    },
  }
}
