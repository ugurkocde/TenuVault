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
  const state = { time: Date.now(), online: true, account: approvalAccount, auditAvailable: true }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!state.online) return new Response(null, { status: 403 })
    const request = new Request(input, init)
    const url = new URL(request.url)
    const prefix = "/intune-backups/"
    const name = decodeURIComponent(url.pathname.slice(prefix.length))
    if (url.searchParams.get("comp") === "list") {
      const names = [...values.keys()].filter(key => key.startsWith(url.searchParams.get("prefix")!))
      return new Response(`<EnumerationResults><Blobs>${names.map(key => `<Blob><Name>${key}</Name></Blob>`).join("")}</Blobs><NextMarker /></EnumerationResults>`)
    }
    const existing = values.get(name)
    if (request.method === "GET") return existing
      ? new Response(existing.body, { headers: { etag: existing.etag } })
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
      version, store, profile: () => ({ clientId: requester.oid, storageAccountName: state.account }),
      open: async (_tenant, _client, account) => ({ actor: session.actor, blobs: approvalBlobs(account, "fixture", fetch) }),
      current: (_tenant, expected) => expected.oid === session.actor.oid,
      audit: async event => {
        if (!state.auditAvailable) throw new Error("Audit receipt unavailable")
        audits.push(event)
      },
      now: () => state.time,
    }
    return { service: new WriteApprovals(deps), store, session }
  }
  return { profile, values, audits, state }
}
