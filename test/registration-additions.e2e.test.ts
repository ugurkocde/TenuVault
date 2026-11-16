import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { PublicClientApplication } from "@azure/msal-node"
import { AddPermissionsFlow, signInForPermissionAddition } from "../src/main/auth/add-permissions-flow"
import { loopbackSignIn } from "../src/main/auth/loopback-sign-in"
import { ERROR_PAGE, page } from "../src/main/auth/msal"
import { isGuid, isMicrosoftLoginUrl } from "../src/shared/security"
import { knownPermissions } from "../src/shared/services/manifest"

/**
 * PREPARED ONLY. Do not run without the lab owner's explicit approval for writes to a named public
 * client with existing tenant-wide consent. Uses two real delegated sign-ins, never a lab secret.
 * Supply TENUVAULT_ADDITIONS_TENANT_ID, TENUVAULT_ADDITIONS_CLIENT_ID and
 * TENUVAULT_ADDITIONS_SCOPES (space-separated approved additions), then set
 * TENUVAULT_ADDITIONS_WRITE_APPROVED=yes and run this file with Vitest --mode e2e.
 * This adds real delegated declarations and consent. It does not remove them afterwards.
 */
it.skipIf(process.env.TENUVAULT_ADDITIONS_WRITE_APPROVED !== "yes")("adds the approved permissions through real delegated sign-ins and verifies the refreshed token", async () => {
  const tenantId = process.env.TENUVAULT_ADDITIONS_TENANT_ID ?? ""
  const clientId = process.env.TENUVAULT_ADDITIONS_CLIENT_ID ?? ""
  const additions = (process.env.TENUVAULT_ADDITIONS_SCOPES ?? "").split(/\s+/).filter(Boolean)
  expect(isGuid(tenantId) && isGuid(clientId)).toBe(true)
  expect(additions.length).toBeGreaterThan(0)
  const allowed = knownPermissions("delegated")[0]!.permissions
  for (const name of additions) expect(allowed).toContain(name)
  const openBrowser = async (url: string) => {
    if (!isMicrosoftLoginUrl(url)) throw new Error("Unexpected login address")
    await promisify(execFile)(process.platform === "darwin" ? "open" : "xdg-open", [url])
  }
  const client = new PublicClientApplication({ auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` } })
  const signal = AbortSignal.timeout(15 * 60_000)
  const original = await loopbackSignIn({ app: client, scopes: ["https://graph.microsoft.com/.default"], prompt: "select_account", openBrowser, successPage: page("Go back to the test", "The target connection is signed in."), errorPage: ERROR_PAGE, signal })
  expect(original.account?.tenantId.toLowerCase()).toBe(tenantId.toLowerCase())
  const connection = { tenantId, clientId, username: original.account!.username, homeAccountId: original.account!.homeAccountId, scopes: original.scopes, allowed }
  const flow = new AddPermissionsFlow({ fetch, connection: async () => connection, signIn: (c, s) => signInForPermissionAddition(c, fetch, openBrowser, s), refresh: async () => {
    const token = await client.acquireTokenSilent({ account: original.account!, scopes: ["https://graph.microsoft.com/.default"], forceRefresh: true })
    for (const name of additions) expect(token.scopes).toContain(name)
  } })
  try {
    const preview = await flow.preview(tenantId, additions)
    expect([...preview.declare, ...preview.consent].every(name => additions.includes(name))).toBe(true)
    expect((await flow.confirm(tenantId, preview.id)).state).toBe("complete")
  } finally { flow.cancel(tenantId); await client.clearCache() }
}, 20 * 60_000)
