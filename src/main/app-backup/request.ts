import { verify, type KeyObject } from "node:crypto"

/** Contract foundation only. No transport, elevation or content execution is implemented. */
export interface ContentRequest {
  v: 1
  jobId: string
  contentFileId: string
  tenantId: string
  intuneAccountId: string
  deviceId: string
  appId: string
  contentVersion: string
  requesterTenantId: string
  requesterObjectId: string
  challenge: string
  roleCheckedAt: number
  issuedAt: number
  expiresAt: number
  appVersion: string
  appType: "#microsoft.graph.win32LobApp"
  permission: "update-app"
}
export interface RequestContext {
  jobId: string
  contentFileId: string
  tenantId: string
  intuneAccountId: string
  deviceId: string
  appId: string
  contentVersion: string
  requesterObjectId: string
  challenge: string
  appVersion: string
}
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const FIELDS = new Set(["v", "jobId", "contentFileId", "tenantId", "intuneAccountId", "deviceId", "appId", "contentVersion", "requesterTenantId", "requesterObjectId", "challenge", "roleCheckedAt", "issuedAt", "expiresAt", "appVersion", "appType", "permission"])
export const CONTENT_REQUEST_DOMAIN = "TenuVault/intune-content-request/v1\0"

/** One verifier per authenticated helper challenge. Never exported through renderer IPC. */
export class ContentRequestVerifier {
  private consumed = false
  constructor(private readonly publicKey: KeyObject, private readonly context: RequestContext, private readonly now: () => number = Date.now) {
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Content requests require an Ed25519 verification key.")
  }
  consume(payload: string, signature: string): ContentRequest {
    if (this.consumed) throw new Error("This content request challenge has already been used.")
    if (typeof payload !== "string" || typeof signature !== "string" || payload.length > 8192 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new Error("Invalid content request.")
    if (Buffer.from(signature, "base64url").toString("base64url") !== signature) throw new Error("Invalid signature encoding.")
    const bytes = Buffer.from(CONTENT_REQUEST_DOMAIN + payload, "utf8")
    if (!verify(null, bytes, this.publicKey, Buffer.from(signature, "base64url"))) throw new Error("Content request signature could not be verified.")
    this.consumed = true
    const r: unknown = JSON.parse(payload)
    // Require compact JSON serialization to reject duplicate keys and parser ambiguity.
    if (JSON.stringify(r) !== payload) throw new Error("Content requests require unambiguous compact JSON.")
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== FIELDS.size || Object.keys(r).some(k => !FIELDS.has(k))) throw new Error("Invalid content request fields.")
    const request = r as ContentRequest, c = this.context, now = this.now()
    if (request.v !== 1 || request.appType !== "#microsoft.graph.win32LobApp" || request.permission !== "update-app" || ![request.jobId, request.contentFileId, request.tenantId, request.intuneAccountId, request.deviceId, request.appId, request.requesterTenantId, request.requesterObjectId].every(id => typeof id === "string" && GUID.test(id)) || typeof request.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.challenge) || !/^\d{1,20}$/.test(request.contentVersion)) throw new Error("Unsupported content request.")
    if (![request.issuedAt, request.expiresAt, request.roleCheckedAt].every(Number.isSafeInteger) || request.issuedAt > now || request.expiresAt <= now || request.expiresAt <= request.issuedAt || request.expiresAt - request.issuedAt > 300_000 || request.roleCheckedAt > request.issuedAt || request.issuedAt - request.roleCheckedAt > 60_000) throw new Error("Content request or role check has expired.")
    for (const k of ["jobId", "contentFileId", "tenantId", "intuneAccountId", "deviceId", "appId", "contentVersion", "requesterObjectId", "challenge", "appVersion"] as const) if (request[k] !== c[k]) throw new Error("Content request does not match this job and device.")
    if (request.requesterTenantId !== c.tenantId) throw new Error("Requester belongs to a different tenant.")
    return request
  }
}
