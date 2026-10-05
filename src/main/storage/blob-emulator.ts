import { AsyncLocalStorage } from "node:async_hooks"
import { LOCAL_STORAGE_PREFIX, localStorageAccountName } from "../../shared/constants"
import { BlobAlreadyExistsError, BlobNotFoundError, type LocalBlobStore, type StoredBlob } from "./local-blob-store"

/**
 * Serves the subset of the Azure Blob REST API that the shared API routes use
 * (list containers, create/get container, list/get/put/delete blobs) from the
 * encrypted local store, for tenants whose backups stay on this device.
 *
 * Local accounts are named `tvlocal-<tenant id>`. The hyphen makes them invalid as
 * real Azure storage account names, so they can never collide with one.
 */

const HOST = /^(tvlocal-[a-z0-9-]+)\.blob\.core\.windows\.net$/i

export function localAccountFromUrl(url: URL): string | null {
  const match = HOST.exec(url.hostname)
  return match?.[1] ? match[1].toLowerCase() : null
}

/**
 * The tenant and storage account of the API route being handled (null for a route without
 * one). Work a route starts (such as a backup) keeps them. Outside any route (scheduled
 * backups) there is none.
 */
const routeContext = new AsyncLocalStorage<{ tenant: string | null; storageAccount: string | null }>()

const text = (value: unknown) => (typeof value === "string" && value ? value : null)

/** Runs a route handler so local storage only serves the tenant named in its request. */
export function withRouteTenant<T>(tenantId: unknown, run: () => T, storageAccountName?: unknown): T {
  return routeContext.run({ tenant: text(tenantId), storageAccount: text(storageAccountName)?.toLowerCase() ?? null }, run)
}

/**
 * Whether the route being handled keeps the backups of `tenantId` on this device. Such a
 * route needs no Azure Storage token: local blob requests are served without one.
 */
export function routeUsesLocalStorage(tenantId: string): boolean {
  return routeContext.getStore()?.storageAccount === localStorageAccountName(tenantId)
}

export function isLocalAccount(storageAccountName: string | undefined): boolean {
  return Boolean(storageAccountName?.toLowerCase().startsWith(LOCAL_STORAGE_PREFIX))
}

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function error(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`,
    { status, headers: { "content-type": "application/xml", "x-ms-error-code": code } },
  )
}

const etag = (blob: StoredBlob) => `"0x${blob.lastModified.getTime().toString(16).toUpperCase()}"`

function blobXml(blob: StoredBlob): string {
  return (
    `<Blob><Name>${xml(blob.name)}</Name><Properties>` +
    `<Creation-Time>${blob.created.toUTCString()}</Creation-Time>` +
    `<Last-Modified>${blob.lastModified.toUTCString()}</Last-Modified>` +
    `<Etag>${etag(blob)}</Etag>` +
    `<Content-Length>${blob.size}</Content-Length>` +
    `<Content-Type>${xml(blob.contentType)}</Content-Type>` +
    `<BlobType>BlockBlob</BlobType><LeaseStatus>unlocked</LeaseStatus><LeaseState>available</LeaseState>` +
    `</Properties></Blob>`
  )
}

async function listBlobs(store: LocalBlobStore, account: string, container: string, query: URLSearchParams) {
  const prefix = query.get("prefix") ?? ""
  const delimiter = query.get("delimiter") ?? ""
  const marker = query.get("marker") ?? ""
  const maxResults = Math.min(Number(query.get("maxresults")) || 5000, 5000)

  // Blobs and virtual folders in one lexicographic stream, like Azure.
  const items: Array<{ key: string; xml: string }> = []
  const prefixes = new Set<string>()
  for (const blob of await store.list(account, container)) {
    if (!blob.name.startsWith(prefix)) continue
    const rest = blob.name.slice(prefix.length)
    const cut = delimiter ? rest.indexOf(delimiter) : -1
    if (cut >= 0) {
      const folder = prefix + rest.slice(0, cut + delimiter.length)
      if (!prefixes.has(folder)) {
        prefixes.add(folder)
        items.push({ key: folder, xml: `<BlobPrefix><Name>${xml(folder)}</Name></BlobPrefix>` })
      }
    } else {
      items.push({ key: blob.name, xml: blobXml(blob) })
    }
  }
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const start = marker ? items.findIndex((item) => item.key >= marker) : 0
  const page = start < 0 ? [] : items.slice(start, start + maxResults)
  const next = start >= 0 ? items[start + maxResults] : undefined

  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<EnumerationResults ServiceEndpoint="https://${account}.blob.core.windows.net/" ContainerName="${xml(container)}">` +
      (prefix ? `<Prefix>${xml(prefix)}</Prefix>` : "<Prefix />") +
      (marker ? `<Marker>${xml(marker)}</Marker>` : "") +
      `<MaxResults>${maxResults}</MaxResults>` +
      (delimiter ? `<Delimiter>${xml(delimiter)}</Delimiter>` : "") +
      `<Blobs>${page.map((item) => item.xml).join("")}</Blobs>` +
      (next ? `<NextMarker>${xml(next.key)}</NextMarker>` : "<NextMarker />") +
      `</EnumerationResults>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  )
}

export async function handleLocalBlobRequest(store: LocalBlobStore, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const account = localAccountFromUrl(url)
  if (!account) return error(400, "InvalidUri", "Not a local TenuVault storage account.")
  const context = routeContext.getStore()
  if (context !== undefined && (context.tenant === null || localStorageAccountName(context.tenant) !== account)) {
    return error(403, "AuthorizationFailure", "This request may only use the local backups of its own tenant.")
  }

  const method = request.method.toUpperCase()
  const query = url.searchParams
  const [containerSegment, ...blobSegments] = url.pathname.replace(/^\//, "").split("/")
  const container = decodeURIComponent(containerSegment ?? "")
  const blobName = blobSegments.map(decodeURIComponent).join("/")

  try {
    // Account level: list containers.
    if (!container) {
      if (method === "GET" && query.get("comp") === "list") {
        const names = await store.listContainers(account)
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://${account}.blob.core.windows.net/">` +
            `<Containers>${names.map((n) => `<Container><Name>${xml(n)}</Name><Properties /></Container>`).join("")}</Containers>` +
            `<NextMarker /></EnumerationResults>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        )
      }
      return error(400, "UnsupportedHttpVerb", `${method} is not supported on the account.`)
    }

    // Container level.
    if (!blobName && query.get("restype") === "container") {
      if (method === "PUT") {
        return (await store.createContainer(account, container))
          ? new Response(null, { status: 201 })
          : error(409, "ContainerAlreadyExists", "The specified container already exists.")
      }
      if (!(await store.containerExists(account, container))) {
        return error(404, "ContainerNotFound", "The specified container does not exist.")
      }
      if (method === "GET" && query.get("comp") === "list") return await listBlobs(store, account, container, query)
      if (method === "GET" || method === "HEAD") return new Response(null, { status: 200 })
      return error(400, "UnsupportedHttpVerb", `${method} is not supported on containers.`)
    }

    if (!blobName) return error(400, "InvalidUri", "A blob name is required.")

    // Blob level.
    if (method === "PUT") {
      const data = new Uint8Array(await request.arrayBuffer())
      const blob = await store.put(account, container, blobName, data, request.headers.get("content-type") ?? "application/octet-stream", request.headers.get("if-none-match") === "*")
      return new Response(null, { status: 201, headers: { etag: etag(blob), "last-modified": blob.lastModified.toUTCString() } })
    }
    if (method === "GET" || method === "HEAD") {
      const { blob, data } = await store.get(account, container, blobName)
      const headers = {
        "content-type": blob.contentType,
        "content-length": String(blob.size),
        "last-modified": blob.lastModified.toUTCString(),
        etag: etag(blob),
        "x-ms-blob-type": "BlockBlob",
      }
      return new Response(method === "HEAD" ? null : new Uint8Array(data), { status: 200, headers })
    }
    if (method === "DELETE") {
      await store.delete(account, container, blobName)
      return new Response(null, { status: 202 })
    }
    return error(400, "UnsupportedHttpVerb", `${method} is not supported on blobs.`)
  } catch (caught) {
    if (caught instanceof BlobAlreadyExistsError) return error(412, "ConditionNotMet", "The blob already exists.")
    if (caught instanceof BlobNotFoundError) {
      return (await store.containerExists(account, container))
        ? error(404, "BlobNotFound", "The specified blob does not exist.")
        : error(404, "ContainerNotFound", "The specified container does not exist.")
    }
    console.error("[backups] Local storage request failed:", caught)
    return error(500, "InternalError", caught instanceof Error ? caught.message : String(caught))
  }
}
