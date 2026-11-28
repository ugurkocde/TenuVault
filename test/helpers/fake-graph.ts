import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeCollection { count: number; members?: { object: number; count: number }; bytes?: number; object?: (index: number, relation?: string) => Record<string, unknown> }
export interface FakeGraphOptions {
  seed?: number
  pageSize?: number
  collections: Record<string, FakeCollection>
  throttleEvery?: number
  retryAfter?: number
  expireAt?: number
  dropAt?: number
  onRequest?: (count: number, url: URL) => void
}

/** Local HTTP fixture only. Objects are generated per page, with no resident synthetic tenant. */
export async function fakeGraph(options: FakeGraphOptions) {
  let requests = 0, throttles = 0
  const counts = new Map<string, number>()
  const seed = options.seed ?? 7
  const id = (index: number) => `${seed.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
  const server = createServer((request, response) => {
    requests++
    const url = new URL(request.url!, "http://fixture")
    options.onRequest?.(requests, url)
    const key = url.pathname + url.search
    const attempt = (counts.get(key) ?? 0) + 1
    counts.set(key, attempt)
    if (requests === options.dropAt) { request.socket.destroy(); return }
    if (options.throttleEvery && requests % options.throttleEvery === 0 && attempt === 1) {
      throttles++
      response.writeHead(429, { "Retry-After": String(options.retryAfter ?? 1), "content-type": "application/json" })
      response.end(JSON.stringify({ error: { code: "TooManyRequests", message: "Fixture throttle" } })); return
    }
    response.setHeader("content-type", "application/json")
    const [, , collection, objectId, relation] = url.pathname.split("/")
    const shape = options.collections[collection!]
    if (!shape) { response.end(JSON.stringify({ value: [] })); return }
    const offset = Number(url.searchParams.get("$skiptoken") ?? 0)
    if (options.expireAt !== undefined && offset >= options.expireAt) {
      response.statusCode = 410
      response.end(JSON.stringify({ error: { code: "DirectoryPageTokenNotFoundException", message: "Paging token expired" } })); return
    }
    const total = relation ? ((!shape.object || relation === "members") && objectId === id(shape.members?.object ?? -1) ? shape.members?.count ?? 0 : 0) : shape.count
    const top = Math.min(Number(url.searchParams.get("$top")) || options.pageSize || 999, options.pageSize || 999)
    const select = url.searchParams.get("$select")?.split(",")
    const object = (index: number) => {
      const value: Record<string, unknown> = shape.object ? { ...shape.object(index, relation), id: collection === "oauth2PermissionGrants" ? Buffer.from(`${id(index)}:grant`).toString("base64url") : id(index) } : { id: id(index), displayName: `Synthetic ${index}`, accountEnabled: true, payload: "x".repeat(shape.bytes ?? 256) }
      return select ? { ...Object.fromEntries(select.map(key => [key, value[key]])), ...(shape.object && url.searchParams.get("$expand") === "manager($select=id)" ? { manager: { id: id((index + 1) % shape.count) } } : {}) } : value
    }
    if (objectId && !relation) { response.end(JSON.stringify(object(Number.parseInt(objectId.slice(-12), 16)))); return }
    const value = Array.from({ length: Math.max(0, Math.min(top, total - offset)) }, (_, i) => object(offset + i))
    const next = new URL(`https://graph.microsoft.com${url.pathname}${url.search}`)
    next.searchParams.set("$skiptoken", String(offset + value.length))
    response.end(JSON.stringify({ value, ...(offset + value.length < total ? { "@odata.nextLink": next.href } : {}) }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    id, origin,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
      return fetch(origin + target.pathname + target.search, init)
    }) as typeof fetch,
    stats: () => ({ requests, throttles }),
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }),
  }
}
