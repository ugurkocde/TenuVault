import { registerStorageToken } from "../storage/azure-seal"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN, LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { localAccountFromUrl, routeUsesLocalStorage } from "../storage/blob-emulator"

export interface DelegatedToken {
  accessToken: string
  expiresOn: Date | null
}

export interface FetchBridgeOptions {
  /** Handles calls the route code makes to its own API. */
  dispatch: (request: Request) => Promise<Response>
  /** Returns a delegated token for the signed-in admin of `tenant`. */
  getDelegatedToken: (tenant: string, clientId: string, scope: string, forceRefresh?: boolean) => Promise<DelegatedToken>
  /**
   * Throws when `tenant` may not be used (license check). Runs for every client
   * credentials token request, delegated or not, and for every request to a tenant's
   * local backup store, so no path skips licensing.
   */
  authorizeTenant?: (tenant: string) => unknown
  /** Serves Blob requests for local (`tvlocal-...`) storage accounts from the encrypted store. */
  handleLocalBlob?: (request: Request) => Promise<Response>
  fetch?: typeof fetch
}

/** Answers Azure Storage token requests of routes on local storage. Never valid at Azure. */
const LOCAL_STORAGE_TOKEN = "tenuvault-local-storage"

const TOKEN_PATH = /^\/([^/]+)\/oauth2\/v2\.0\/token$/

/**
 * Creates the `fetch` used by the main process.
 *
 * The shared route code authenticates with the client credentials grant. For desktop
 * tenant profiles the client secret is the DELEGATED_CLIENT_SECRET placeholder, and this
 * bridge answers those token requests with a delegated token for the signed-in admin
 * instead of sending them to Microsoft. Requests with a real secret (for example while
 * validating the unattended backup app registration during onboarding) go to Microsoft
 * unchanged. Blob requests for local storage accounts are served from the encrypted
 * store on this device. All other traffic goes straight to Microsoft Graph and Azure;
 * no tenant data is sent to TenuVault servers (license checks use their own requests,
 * see main/license/service.ts).
 */
export function createBridgedFetch(options: FetchBridgeOptions): typeof fetch {
  const realFetch = options.fetch ?? globalThis.fetch

  return async function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

    if (url.origin === INTERNAL_API_ORIGIN) {
      return options.dispatch(new Request(input, init))
    }

    const localAccount = options.handleLocalBlob ? localAccountFromUrl(url) : null
    if (options.handleLocalBlob && localAccount) {
      try {
        await options.authorizeTenant?.(localAccount.slice(LOCAL_STORAGE_PREFIX.length))
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/[<>&]/g, "")
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationFailure</Code><Message>${message}</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml", "x-ms-error-code": "AuthorizationFailure" } },
        )
      }
      const response = await options.handleLocalBlob(new Request(input, init))
      if (response.ok) response.headers.set("x-tenuvault-authenticated", "true")
      return response
    }

    const tokenPath = url.hostname === "login.microsoftonline.com" ? TOKEN_PATH.exec(url.pathname) : null
    if (tokenPath?.[1]) {
      const request = new Request(input, init)
      if (request.method === "POST") {
        const tenant = decodeURIComponent(tokenPath[1])
        const form = new URLSearchParams(await request.clone().text())
        if (form.get("grant_type") === "client_credentials") {
          try {
            await options.authorizeTenant?.(tenant)
          } catch (error) {
            return tokenError(403, "unauthorized_client", error)
          }
          if (form.get("client_secret") === DELEGATED_CLIENT_SECRET) {
            return delegatedTokenResponse(options, tenant, form)
          }
        }
      }
      const requestForm = request.method === "POST" ? await request.clone().text() : ""
      const response = await realFetch(request)
      if (request.method === "POST" && response.ok) {
        const form = new URLSearchParams(requestForm)
        if (form.get("scope")?.includes("storage.azure.com")) {
          const token = await response.clone().json() as { access_token?: unknown }
          if (typeof token.access_token === "string") registerStorageToken(token.access_token, decodeURIComponent(tokenPath[1]))
        }
      }
      return response
    }

    return realFetch(input, init)
  }
}

async function delegatedTokenResponse(
  options: FetchBridgeOptions,
  tenant: string,
  form: URLSearchParams,
): Promise<Response> {
  const clientId = form.get("client_id")
  const scope = form.get("scope")
  if (!clientId || !scope) {
    return Response.json({ error: "invalid_request", error_description: "client_id and scope are required" }, { status: 400 })
  }
  // Local blob requests need no token, so a route on this device's backups must not depend
  // on Azure Storage consent (the backup engine skips this token the same way).
  if (scope.includes("storage.azure.com") && routeUsesLocalStorage(tenant)) {
    return Response.json({ token_type: "Bearer", access_token: LOCAL_STORAGE_TOKEN, expires_in: 3600, ext_expires_in: 3600 })
  }
  try {
    const token = await options.getDelegatedToken(tenant, clientId, scope, form.get("force_refresh") === "true")
    const expiresIn = token.expiresOn ? Math.max(0, Math.floor((token.expiresOn.getTime() - Date.now()) / 1000)) : 3600
    return Response.json({
      token_type: "Bearer",
      access_token: token.accessToken,
      expires_in: expiresIn,
      ext_expires_in: expiresIn,
    })
  } catch (error) {
    console.error(`[auth] Delegated token for ${tenant} (${scope}) failed:`, error)
    return tokenError(401, "interaction_required", error)
  }
}

/** An error in the shape of a Microsoft identity platform token response. */
function tokenError(status: number, code: string, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: code, error_description: message }, { status })
}
