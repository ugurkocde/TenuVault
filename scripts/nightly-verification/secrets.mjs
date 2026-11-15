/**
 * What the nightly verification harness must not show in public logs and screenshots, and how
 * it recognizes the test account (scripts/nightly-verification/sign-in.mjs).
 */

/** The secrets a screenshot or message must not show: the account and the tenant and app ids. */
export const hidden = (secrets) => [secrets.TENUVAULT_E2E_USERNAME, secrets.TENUVAULT_E2E_TENANT_ID, secrets.TENUVAULT_E2E_CLIENT_ID, secrets.TENUVAULT_E2E_PASSWORD]

/** `text` with every secret replaced. */
export function hide(text, secrets) {
  let out = String(text)
  for (const secret of hidden(secrets).filter(Boolean)) out = out.split(secret).join("[hidden]").replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[hidden]")
  return out
}

/** In the browser: replaces every text and field value that contains one of `parts`. */
export function maskPage(parts) {
  const lower = parts.filter(Boolean).map((part) => part.toLowerCase())
  const hit = (text) => lower.some((part) => String(text).toLowerCase().includes(part))
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (hit(node.nodeValue)) node.nodeValue = "[hidden]"
  for (const field of document.querySelectorAll("input, textarea")) if (hit(field.value) || field.type === "password") field.value = "[hidden]"
}

/** The signed-in account is the test user, in the test tenant, through the test app registration. */
export function matchesTestAccount(account, secrets) {
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase()
  return same(account?.tenantId, secrets.TENUVAULT_E2E_TENANT_ID) &&
    same(account?.username, secrets.TENUVAULT_E2E_USERNAME) &&
    same(account?.clientId, secrets.TENUVAULT_E2E_CLIENT_ID)
}
