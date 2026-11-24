import { randomBytes } from "node:crypto"
import { isGuid } from "../../shared/security"
import { TENUVAULT_CLIENT_ID } from "../../shared/tenant-connection"
import { PACK_CONSENT_ERRORS, type PackConsentCode, type PackConsentIssue, type PackConsentResult } from "../../shared/pack-consent"
import { resourceScopes, type PermissionPack } from "../../shared/services/permission-packs"
import { openLoopback, sameState } from "./loopback-sign-in"

export const HANDOFF_REDIRECT = "https://www.tenuvault.com/connect/consented"

export function buildConsentUrl(tenant: string, pack: PermissionPack, redirect: string, state: string): string {
  const port = /^http:\/\/localhost:([1-9]\d{0,4})$/.exec(redirect)?.[1]
  if (!isGuid(tenant) || !/^[\w-]{43}$/.test(state) ||
    (redirect !== HANDOFF_REDIRECT && (!port || Number(port) > 65_535))) {
    throw new Error("The permission request has an invalid tenant, redirect or state.")
  }
  const url = new URL(`https://login.microsoftonline.com/${tenant}/v2.0/adminconsent`)
  url.search = new URLSearchParams({
    client_id: TENUVAULT_CLIENT_ID, scope: resourceScopes(pack.resource, pack.scopes).join(" "), redirect_uri: redirect, state,
  }).toString()
  return url.toString()
}

export function consentIssue(detail: string): PackConsentIssue | undefined {
  const match = /\bAADSTS(\d{5,7})\b/i.exec(detail) ?? /^\s*\[?(\d{5,7})\]?\s*$/.exec(detail)
  const code = match ? `AADSTS${match[1]}` : /intune.{0,60}(?:licen[cs]e|subscription)|(?:licen[cs]e|subscription).{0,60}intune/i.test(detail)
    ? "intune_unlicensed" : /\b403\b/.test(detail) ? "graph_forbidden" : undefined
  return code && Object.hasOwn(PACK_CONSENT_ERRORS, code) ? { code, message: PACK_CONSENT_ERRORS[code as PackConsentCode] } : undefined
}

export type ConsentCallback = { status: "received"; scopes: string[] } | { status: "error"; issue: PackConsentIssue }

export function parseConsentCallback(query: URLSearchParams, tenant: string, state: string): ConsentCallback {
  const failure = (code: string, message: string): ConsentCallback => ({ status: "error", issue: { code, message } })
  if (["state", "tenant", "scope", "admin_consent", "error", "error_description", "error_codes"].some(key => query.getAll(key).length > 1) ||
    !sameState(state, query.get("state"))) return failure("invalid_callback", "The consent response did not match this request. Try again.")
  const returnedTenant = query.get("tenant")
  if ((returnedTenant !== null || !query.has("error")) && returnedTenant?.toLowerCase() !== tenant.toLowerCase()) {
    return failure("wrong_tenant", "Microsoft returned consent for a different tenant. Try again with an administrator from this tenant.")
  }
  const error = query.get("error")
  if (error) {
    const issue = consentIssue(query.get("error_description") ?? "") ?? consentIssue(query.get("error_codes") ?? "") ?? consentIssue(error)
    return issue ? { status: "error", issue } : failure("consent_refused", "Microsoft did not approve this pack. Try again or send it to your administrator.")
  }
  if (query.get("admin_consent")?.toLowerCase() !== "true" || query.has("error")) return failure("invalid_callback", "Microsoft did not return a consent confirmation. Try again.")
  return { status: "received", scopes: (query.get("scope") ?? "").split(/\s+/).filter(Boolean) }
}

const page = (message: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>TenuVault</title><p>${message}</p></html>`

export async function openPackConsent(tenant: string, pack: PermissionPack, openBrowser: (url: string) => Promise<void>, signal: AbortSignal): Promise<PackConsentResult> {
  signal.throwIfAborted()
  const state = randomBytes(32).toString("base64url")
  const listener = await openLoopback({
    successPage: page("Return to TenuVault and check the granted permissions."),
    errorPage: page("Return to TenuVault to review the consent result."),
  }, state, query => parseConsentCallback(query, tenant, state))
  let abort: () => void = () => undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
  try {
    await Promise.race([stopped, openBrowser(buildConsentUrl(tenant, pack, `http://localhost:${listener.port}`, state))])
    const reply = parseConsentCallback(await Promise.race([listener.answer, stopped]), tenant, state)
    return reply.status === "received" ? { status: "received" } : reply
  } finally {
    signal.removeEventListener("abort", abort)
    listener.close()
  }
}

export function handoffPack(tenant: string, pack: PermissionPack): PackConsentResult {
  const url = buildConsentUrl(tenant, pack, HANDOFF_REDIRECT, randomBytes(32).toString("base64url"))
  return { status: "handoff", url, message: `Please review the ${pack.label} permission pack for the TenuVault app in tenant ${tenant}. If you approve, open this Microsoft consent link, then let me know so I can check the granted permissions in TenuVault.\n\n${url}` }
}

export class PackConsentFlow {
  private readonly pending = new Map<string, AbortController>()

  constructor(private readonly host: {
    plan: (tenant: string) => Promise<readonly PermissionPack[] | null>
    openBrowser: (url: string) => Promise<void>
    signInForPack: (tenant: string, pack: PermissionPack, checkOnly: boolean) => Promise<void>
  }) {}

  async act(tenant: string, packId: unknown, action: unknown): Promise<PackConsentResult> {
    if (typeof packId !== "string" || (action !== "open" && action !== "handoff" && action !== "request" && action !== "check")) {
      return { status: "error", issue: { code: "invalid_request", message: "Choose a permission pack." } }
    }
    const pack = (await this.host.plan(tenant))?.find(pack => pack.id === packId)
    if (!pack) return { status: "error", issue: { code: "unavailable", message: "That permission pack is unavailable. Review your sign-in method and service choices." } }
    if (action === "handoff") return handoffPack(tenant, pack)
    if (this.pending.has(tenant)) return { status: "error", issue: { code: "conflict", message: "Finish the permission request already open for this tenant." } }

    const controller = new AbortController()
    this.pending.set(tenant, controller)
    try {
      if (action === "request" || action === "check") {
        await this.host.signInForPack(tenant, pack, action === "check")
        return { status: "verified" }
      }
      const result = await openPackConsent(tenant, pack, this.host.openBrowser, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]))
      return result.status === "error" && result.issue.code === "AADSTS90095" ? { status: "waiting", issue: result.issue } : result
    } catch (error) {
      const issue = consentIssue(error instanceof Error ? error.message : "")
      if (issue?.code === "AADSTS90095" || ((action === "request" || action === "check") && issue?.code === "AADSTS65001")) return { status: "waiting", issue }
      if (action === "check" && error instanceof Error && "code" in error && error.code === "sign_in_required") {
        return { status: "waiting", issue: { code: error.code, message: error.message } }
      }
      return { status: "error", issue: issue ?? { code: "consent_interrupted", message: "The permission request ended. Try again or send the pack to your administrator." } }
    } finally {
      this.pending.delete(tenant)
    }
  }

  cancel(): boolean {
    for (const controller of this.pending.values()) controller.abort()
    return this.pending.size > 0
  }
}
