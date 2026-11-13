import type { AuthorizationUrlRequest } from "@azure/msal-node"

/** The Microsoft sign-in address a fake getAuthCodeUrl returns: the request's own parameters on the login host. */
export function authCodeUrl(request: AuthorizationUrlRequest): string {
  const params = new URLSearchParams({
    redirect_uri: request.redirectUri,
    state: request.state ?? "",
    code_challenge: request.codeChallenge ?? "",
    code_challenge_method: request.codeChallengeMethod ?? "",
    response_mode: request.responseMode ?? "",
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.loginHint ? { login_hint: request.loginHint } : {}),
  })
  return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params}`
}

/** The loopback address of a sign-in address, on 127.0.0.1 where the listener is bound. */
export function loopbackOf(url: string): string {
  const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!)
  return `http://127.0.0.1:${redirect.port}`
}

/**
 * Plays the browser coming back from Microsoft: the form Microsoft's page posts to the redirect
 * address (response_mode form_post) with `params`.
 */
export async function answer(url: string, params: Record<string, string> | URLSearchParams, init: { path?: string; contentType?: string } = {}): Promise<Response> {
  return fetch(`${loopbackOf(url)}${init.path ?? "/"}`, {
    method: "POST",
    headers: { "Content-Type": init.contentType ?? "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  })
}

/** The answer Microsoft sends for a successful sign-in, with the state of `url`. */
export function codeAnswer(url: string, code = "auth-code"): Record<string, string> {
  return { code, state: new URL(url).searchParams.get("state")!, client_info: "eyJ1aWQiOiJ1In0" }
}

/** Whether the loopback listener of `url` is closed: nothing accepts a connection there. */
export async function listenerClosed(url: string): Promise<boolean> {
  try {
    await fetch(`${loopbackOf(url)}/`, { signal: AbortSignal.timeout(2000) })
    return false
  } catch {
    return true
  }
}
