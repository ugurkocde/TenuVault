import { graphDispatchGuard } from "../../src/main/write-approvals/dispatch"
import { approvalBlobs } from "../../src/main/write-approvals/blob"
import { WriteApprovals, type ApprovalDependencies } from "../../src/main/write-approvals/service"
import { memoryStore } from "../helpers"

export const approvalTenant = "44444444-4444-4444-8444-444444444444"
export const secondTenant = "55555555-5555-4555-8555-555555555555"
export const requester = { oid: "11111111-1111-4111-8111-111111111111", label: "Admin" }
export const reviewer = { oid: "22222222-2222-4222-8222-222222222222", label: "Admin" }
export const approvalAccount = "sharedapprovals"
export const writeApprovalFixture = () => {
  const values = new Map<string, { body: string; etag: string }>()
  const audits: Array<Parameters<ApprovalDependencies["audit"]>[0]> = []
  let counter = 0
  const state = {
    time: Date.now(), online: true, account: approvalAccount, hasProfile: true, auditAvailable: true, serverTime: 0,
    containerMissing: false, blockedAccounts: new Set<string>(), failedReads: new Set<string>(), policyReads: 0, conditionalReads: 0, policyChecks: 0, beforeAudit: undefined as ((event: Parameters<ApprovalDependencies["audit"]>[0]) => void) | undefined,
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!state.online) return new Response(null, { status: 403 })
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (state.blockedAccounts.has(url.hostname.split(".")[0]!)) return new Response(null, { status: 403 })
    if (state.containerMissing) return new Response(null, { status: 404, headers: { "x-ms-error-code": "ContainerNotFound" } })
    const date = new Date(state.serverTime || state.time).toUTCString()
    const prefix = "/intune-backups/"
    const name = decodeURIComponent(url.pathname.slice(prefix.length))
    if (url.searchParams.get("comp") === "list") {
      const names = [...values.keys()].filter(key => key.startsWith(url.searchParams.get("prefix")!))
      return new Response(`<EnumerationResults><Blobs>${names.map(key => `<Blob><Name>${key}</Name></Blob>`).join("")}</Blobs><NextMarker /></EnumerationResults>`)
    }
    if (state.failedReads.has(name)) throw new Error("Injected transport failure")
    const existing = values.get(name)
    if (request.method === "GET" && name.endsWith("/policy.json")) {
      if (request.headers.has("if-none-match")) {
        state.conditionalReads++
        if (existing && request.headers.get("if-none-match") === existing.etag) return new Response(null, { status: 304, headers: { date } })
      }
      state.policyReads++
    }
    if (request.method === "HEAD") {
      state.policyChecks++
      if (!existing || request.headers.get("if-match") !== existing.etag) return new Response(null, { status: 412 })
      return new Response(null, { headers: { etag: existing.etag, date } })
    }
    if (request.method === "DELETE") {
      if (!existing || request.headers.get("if-match") !== existing.etag) return new Response(null, { status: 412 })
      values.delete(name)
      return new Response(null, { status: 202 })
    }
    if (request.method === "GET") return existing
      ? new Response(existing.body, { headers: { etag: existing.etag, date } })
      : new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } })
    const body = await request.text()
    const current = values.get(name)
    const match = request.headers.get("if-match"), absent = request.headers.get("if-none-match")
    if (request.method !== "PUT" || ((match === null) === (absent === null))) throw new Error("Expected conditional Azure PUT")
    if ((absent === "*" && current) || (match && current?.etag !== match)) return new Response(null, { status: 412 })
    values.set(name, { body, etag: `"${++counter}"` })
    return new Response(null, { status: 201 })
  }
  const profile = (actor = requester, store = memoryStore(), version = "0.6.0") => {
    const session = { actor }
    const deps: ApprovalDependencies = {
      version, store, profile: () => state.hasProfile ? { clientId: requester.oid, storageAccountName: state.account } : null,
      open: async (_tenant, _client, account) => ({ actor: session.actor, blobs: approvalBlobs(account, "fixture", fetch) }),
      current: (_tenant, expected) => expected.oid === session.actor.oid,
      audit: async event => {
        if (!state.auditAvailable) throw new Error("Audit receipt unavailable")
        state.beforeAudit?.(event)
        audits.push(event)
      },
    }
    return { service: new WriteApprovals(deps), store, session }
  }
  return { profile, values, audits, state }
}


/** Legacy inventory tests exercise their existing entry points with the approval service installed. */
export function unenrolledApprovals(storage: "none" | "device" | "azure") {
  const { state, profile } = writeApprovalFixture()
  if (storage === "none") state.hasProfile = false
  if (storage === "device") state.account = `tvlocal-${approvalTenant}`
  return profile().service
}


/** Put the production dispatch check in front of a feature suite's fixture network. */
export async function approvalGraphFixture(tenant: string, enabled: boolean) {
  const { profile } = writeApprovalFixture()
  const { service } = profile()
  if (enabled) await service.enable(tenant)
  const guard = graphDispatchGuard(service, () => ({ tenant, actor: requester, current: () => true }))
  return (method: string, path: string) => guard(`https://graph.microsoft.com/beta/${path}`, {
    method, headers: { authorization: "Bearer signed-in" },
  })
}
