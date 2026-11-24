import { namedSignInCode } from "../../shared/sign-in-errors"
import { registerStorageToken } from "../storage/azure-seal"
import { FetchPreconditionError } from "./network-error"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN, LOCAL_STORAGE_PREFIX } from "../../shared/constants"
import { currentRouteTenant, localAccountFromUrl, routeUsesLocalStorage } from "../storage/blob-emulator"

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
  authorizeRequest?: (url: URL, input: RequestInfo | URL, init: RequestInit | undefined, tenant: string | null) => Promise<void>
  authorizeResource?: (tenant: string, scope: string) => void
  bindOwnClientCredentials?: (tenant: string, clientId: string, scope: string, token: string, expiresIn?: number) => void
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
  const networkFetch = options.fetch ?? globalThis.fetch

  return async function bridgedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let networkAttempted = false
    const realFetch: typeof fetch = (input, init) => {
      networkAttempted = true
      return networkFetch(input, init)
    }
    try {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)

      if (url.origin === INTERNAL_API_ORIGIN) {
        return await options.dispatch(new Request(input, init))
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
        return await options.handleLocalBlob(new Request(input, init))
      }

      const tokenPath = url.hostname === "login.microsoftonline.com" ? TOKEN_PATH.exec(url.pathname) : null
      if (tokenPath?.[1]) {
        // The tenant must be named as written: a path that URL parsing rewrites (such as
        // `x/../<tenant>/...`) could otherwise be licensed and signed in as another tenant
        // than the one the route checked.
        if (typeof input === "string" && rawPath(input) !== url.pathname) {
          return Response.json({ error: "invalid_request", error_description: "The tenant in the token URL is not a plain tenant ID." }, { status: 400 })
        }
        const request = new Request(input, init)
        const form = request.method === "POST" ? new URLSearchParams(await request.clone().text()) : null
        if (form) {
          const tenant = decodeURIComponent(tokenPath[1])
          if (form.get("grant_type") === "client_credentials") {
            try {
              await options.authorizeTenant?.(tenant)
            } catch (error) {
              return tokenError(403, "unauthorized_client", error)
            }
            if (form.get("client_secret") === DELEGATED_CLIENT_SECRET) {
              return await delegatedTokenResponse(options, tenant, form)
            }
            try {
              options.authorizeResource?.(tenant, form.get("scope") ?? "")
            } catch (error) {
              return tokenError(403, "unauthorized_client", error)
            }
          }
        }
        const response = await realFetch(request)
        if (form && response.ok) {
          const scope = form.get("scope")
          const client = form.get("client_id")
          const storage = scope?.includes("storage.azure.com")
          const ownCredentials = client && scope && form.get("grant_type") === "client_credentials" && form.has("client_secret")
          if (storage || ownCredentials) {
            // A captive portal response still goes to MSAL, which reports a response it could not parse.
            const token = await response.clone().json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null
            if (typeof token?.access_token === "string") {
              const tenant = decodeURIComponent(tokenPath[1])
              if (storage) registerStorageToken(token.access_token, tenant)
              if (ownCredentials) {
                options.bindOwnClientCredentials?.(tenant, client, scope, token.access_token,
                  typeof token.expires_in === "number" && Number.isFinite(token.expires_in) ? token.expires_in : undefined)
              }
            }
          }
        }
        return response
      }

      await options.authorizeRequest?.(url, input, init, currentRouteTenant())
      return realFetch(input, init)
    } catch (error) {
      if (networkAttempted || error instanceof FetchPreconditionError) throw error
      throw new FetchPreconditionError(error)
    }
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
    options.authorizeResource?.(tenant, scope)
  } catch (error) {
    return tokenError(403, "unauthorized_client", error)
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
    const code = error && typeof error === "object" && "errorNo" in error ? error.errorNo : undefined
    const normalized = typeof code === "string" || typeof code === "number" ? `AADSTS${code}`
      : error instanceof Error ? namedSignInCode(error.message) : undefined
    console.error("[auth] Delegated token request refused", normalized && /^AADSTS\d{4,8}$/.test(normalized) ? normalized : "interaction_required")
    return tokenError(401, "interaction_required", error)
  }
}

/** The path of an absolute URL exactly as written, before URL parsing resolves dot segments. */
function rawPath(href: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(href)?.[1] || "/"
}

/** An error in the shape of a Microsoft identity platform token response. */
function tokenError(status: number, code: string, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: code, error_description: message }, { status })
}
