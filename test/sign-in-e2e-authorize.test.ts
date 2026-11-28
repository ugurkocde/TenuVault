import { expect, it } from "vitest"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { visitAuthorize } from "../scripts/sign-in-e2e/authorize.mjs"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { AUTHORIZE_FORM_HEADER, LOGIN_HOST } from "../scripts/sign-in-e2e/stand-in.mjs"

const authorizeUrl = new URL(`https://${LOGIN_HOST}/tenant/oauth2/v2.0/authorize?state=test`)

function pageWithAuthorizeResponse(status: number, headers: Record<string, string>) {
  const makeResponse = (url: string, resourceType: string, status: number, headers: Record<string, string>) => ({
    url: () => url,
    request: () => ({ resourceType: () => resourceType }),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => headers,
  })
  type Response = ReturnType<typeof makeResponse>
  let onResponse: (response: Response) => void
  return {
    waitForResponse: (matches: (response: Response) => boolean) => new Promise<Response>((resolve) => {
      onResponse = (received) => { if (matches(received)) resolve(received) }
    }),
    async goto(url: string, options: { waitUntil: string }) {
      expect(url).toBe(authorizeUrl.href)
      expect(options.waitUntil).toBe("commit")
      onResponse(makeResponse("http://localhost:1234/", "document", 200, {}))
      onResponse(makeResponse(url, "fetch", 200, {}))
      onResponse(makeResponse(url, "document", status, headers))
      return null
    },
  }
}

it("verifies the authorize response even when Firefox reports no response from goto", async () => {
  const page = pageWithAuthorizeResponse(200, { [AUTHORIZE_FORM_HEADER]: "1" })
  await expect(visitAuthorize(page, authorizeUrl)).resolves.toBeUndefined()
})

it("still rejects an authorize response without the stand-in header", async () => {
  const page = pageWithAuthorizeResponse(200, {})
  await expect(visitAuthorize(page, authorizeUrl)).rejects.toThrow("from the local stand-in (HTTP 200)")
})

it("still rejects an unsuccessful authorize response with the stand-in header", async () => {
  const page = pageWithAuthorizeResponse(403, { [AUTHORIZE_FORM_HEADER]: "1" })
  await expect(visitAuthorize(page, authorizeUrl)).rejects.toThrow("from the local stand-in (HTTP 403)")
})
