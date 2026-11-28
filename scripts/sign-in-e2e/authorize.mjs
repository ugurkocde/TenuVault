import { AUTHORIZE_FORM_HEADER } from "./stand-in.mjs"

export async function visitAuthorize(page, url) {
  // Firefox can commit the navigation without associating its request with goto(). The
  // authorize form also posts on load, so listen for its own response before navigating.
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url() === url.href && response.request().resourceType() === "document"),
    page.goto(url.href, { waitUntil: "commit" }),
  ])
  if (!response.ok() || response.headers()[AUTHORIZE_FORM_HEADER] !== "1") {
    throw new Error(`the authorize request did not receive a form from the local stand-in (HTTP ${response.status()})`)
  }
}
