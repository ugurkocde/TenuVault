import { AsyncLocalStorage } from "node:async_hooks"
import { hasClaimedDestination, hasWriteApproval, WriteApprovalError, type WriteApprovals } from "./service"
import { canonicalJson } from "../features/change-sets/model"
import type { ApprovalActor } from "../../shared/write-approvals"

type Check = () => Promise<void>
const checkpoint = new AsyncLocalStorage<Check>()
const exemptCaller = new AsyncLocalStorage<"registration" | "watcher-roles" | "email" | "restore-withdraw">()

/** Only main's provisioning and delivery adapters can mark their own dispatches exempt. */
export function withExemptGraphCaller<T>(caller: "registration" | "watcher-roles" | "email" | "restore-withdraw", send: () => Promise<T>): Promise<T> {
  return exemptCaller.run(caller, send)
}
let uploadGuard: ((tenant: string) => Promise<void>) | undefined

/** Rechecks an operation-specific live observation immediately before each dispatch and retry. */
export function withWriteCheckpoint<T>(check: Check, work: () => Promise<T>): Promise<T> {
  const outer = checkpoint.getStore()
  return checkpoint.run(outer ? async () => { await outer(); await check() } : check, work)
}

export function sameObservation(expected: unknown, observe: () => Promise<unknown>): Check {
  const before = canonicalJson(expected)
  return async () => {
    if (canonicalJson(await observe()) !== before) throw new WriteApprovalError("The destination changed after review. No further writes were sent. Refresh and request a new approval.")
  }
}

export function setRestoreUploadGuard(guard: typeof uploadGuard): void { uploadGuard = guard }
export async function authorizeRestoreUpload(tenant: string | undefined): Promise<void> {
  if (uploadGuard && hasClaimedDestination()) {
    if (!tenant || !hasWriteApproval(tenant)) throw new WriteApprovalError("The installer upload has no approved destination.")
    await checkpoint.getStore()?.()
    await uploadGuard(tenant)
  }
}

const graphHosts = new Set(["graph.microsoft.com", "graph.microsoft.us", "dod-graph.microsoft.us", "microsoftgraph.chinacloudapi.cn", "graph.microsoft.de"])
const getOnly = new Set(["GET", "HEAD", "OPTIONS"])

function batchTargets(body: unknown, version: string, graphOrigin: string): Array<{ method: string; url: URL }> {
  if (!body || typeof body !== "object" || !("requests" in body) || !Array.isArray(body.requests) || !body.requests.length || body.requests.length > 20) {
    throw new WriteApprovalError("Microsoft Graph batch requests must identify each operation.")
  }
  return body.requests.map(part => {
    if (!part || typeof part.method !== "string" || typeof part.url !== "string" || !part.url.startsWith("/") || part.url.startsWith("//")
      || Object.keys(part.headers ?? {}).some(name => name.toLowerCase() === "authorization")) throw new WriteApprovalError("The Microsoft Graph batch contains an invalid operation.")
    const url = new URL(`${graphOrigin}/${version}${part.url}`)
    if (url.origin !== graphOrigin || !url.pathname.startsWith(`/${version}/`) || url.pathname.toLowerCase().endsWith("/$batch")) throw new WriteApprovalError("The Microsoft Graph batch contains an invalid destination.")
    return { method: part.method.toUpperCase(), url }
  })
}

export function graphDispatchGuard(
  approvals: WriteApprovals,
  sessionFor: (token: string) => { tenant: string; actor: ApprovalActor | null; current: () => boolean } | undefined,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<void> {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== "https:" || !graphHosts.has(url.hostname)) return
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (getOnly.has(method)) return
    const request = new Request(input instanceof Request ? input.clone() : input, init)
    const batch = /^\/(beta|v1\.0)\/(?:\$|%24)batch\/?$/i.exec(url.pathname)
    const targets = batch && method === "POST"
      ? batchTargets(await request.clone().json().catch(() => null), batch[1]!, url.origin)
      : [{ method, url }]
    if (!batch && exemptCaller.getStore()) return
    for (const child of targets) {
      if (getOnly.has(child.method)) continue
      const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const session = token && sessionFor(token)
      if (!session || !session.current()) throw new WriteApprovalError("A signed-in delegated destination account is required for this Graph write.")
      approvals.checkDestination(session.tenant)
      await checkpoint.getStore()?.()
      if (session.actor) await approvals.authorize(session.tenant, session.actor)
      else if (await approvals.active(session.tenant)) throw new WriteApprovalError("Microsoft did not return a verified tenant and object ID for this account.")
      approvals.checkDeadline(session.tenant)
      if (!session.current()) throw new WriteApprovalError("The signed-in destination account changed before the write.")
    }
  }
}
