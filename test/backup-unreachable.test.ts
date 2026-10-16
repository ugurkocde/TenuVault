import { AuthError, ClientAuthErrorCodes, InteractionRequiredAuthError } from "@azure/msal-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FetchApplicationError, NetworkUnreachableError, withNetworkErrors } from "../src/main/api/network-error"
import { SignInRequiredError } from "../src/main/auth/msal"
import { BackupEngine, NetworkCircuit } from "../src/main/backup/engine"
import { GraphError, RequestTimeoutError, StorageError, StorageUnreachableError, TokenError, isUnreachable, storageError } from "../src/main/backup/request"
import { scheduledResult } from "../src/main/backup/scheduler"
import { INTUNE_TYPES } from "../src/shared/intune/registry"
import { localStorageAccountName } from "../src/shared/constants"

const TENANT = "11111111-1111-1111-1111-111111111111"
const request = {
  tenantId: TENANT,
  clientId: "22222222-2222-2222-2222-222222222222",
  storageAccountName: localStorageAccountName(TENANT),
  scope: { excluded: INTUNE_TYPES.filter((type) => type.folder !== "DeviceConfigurations").map((type) => type.folder) },
}

// The error MSAL rethrows when its token request gets no HTTP response (msal-common Token.mjs rethrows NetworkError.error).
const msalNetworkError = () => new AuthError(ClientAuthErrorCodes.networkError, "", "Network request failed: login.microsoftonline.com could not be reached. The request timed out. (ERR_TIMED_OUT)")

async function unreachableFailure(): Promise<unknown> {
  const failing = withNetworkErrors(async () => { throw new TypeError("net::ERR_TIMED_OUT") })
  return failing("https://login.microsoftonline.com/contoso/oauth2/v2.0/token").catch((error: unknown) => error)
}

afterEach(() => {
  vi.useRealTimers()
})

describe("isUnreachable", () => {
  it("recognizes requests that got no HTTP response, including timeouts", async () => {
    const described = await unreachableFailure()
    expect(described).toBeInstanceOf(NetworkUnreachableError)
    expect(described).toMatchObject({ name: "NetworkUnreachableError", message: "login.microsoftonline.com could not be reached. The request timed out. Check your connection and retry. (ERR_TIMED_OUT)" })
    expect((described as Error).cause).toBeInstanceOf(TypeError)
    expect(isUnreachable(described)).toBe(true)
    expect(isUnreachable(msalNetworkError())).toBe(true)
    expect(isUnreachable(Object.assign(new Error("Request timeout"), { errorCode: "network_error" }))).toBe(true)
    expect(isUnreachable(new RequestTimeoutError("Backup request timed out after 90 seconds."))).toBe(true)
    expect(isUnreachable(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true)
    const storage = await storageError(Response.error(), "contoso").catch((error: unknown) => error)
    expect(storage).toBeInstanceOf(StorageUnreachableError)
    expect(storage).toBeInstanceOf(StorageError)
    expect(storage).toMatchObject({ message: "Storage account contoso could not be reached." })
    expect(isUnreachable(storage)).toBe(true)
  })

  it("follows the cause of sign-in and circuit errors", async () => {
    expect(isUnreachable(new TokenError("network_error: Network request failed", { cause: msalNetworkError() }))).toBe(true)
    expect(isUnreachable(new TokenError("timed out", { cause: new RequestTimeoutError("timed out") }))).toBe(true)
    expect(isUnreachable(new Error("outer", { cause: new Error("middle", { cause: await unreachableFailure() }) }))).toBe(true)
    const circuit = new NetworkCircuit(1)
    const failure = await unreachableFailure()
    expect(() => circuit.failed("Microsoft Graph", failure)).toThrow("did not respond")
    expect(isUnreachable(circuit.signal.reason)).toBe(true)
  })

  it("does not treat refusals, HTTP errors or other failures as unreachable", () => {
    const signIn = new SignInRequiredError(TENANT, "app", "Microsoft needs you to sign in again as admin@contoso.com (invalid_grant).")
    expect(isUnreachable(signIn)).toBe(false)
    expect(isUnreachable(new TokenError(signIn.message, { cause: signIn }))).toBe(false)
    expect(isUnreachable(new InteractionRequiredAuthError("interaction_required", "AADSTS50076"))).toBe(false)
    expect(isUnreachable(new AuthError(ClientAuthErrorCodes.tokenParsingError, "", "Failed to parse response"))).toBe(false)
    expect(isUnreachable(new GraphError("Access denied by Microsoft Graph.", 403))).toBe(false)
    expect(isUnreachable(new StorageError("You do not have write access to storage account contoso."))).toBe(false)
    expect(isUnreachable(new FetchApplicationError(new Error("Backup authentication failed.")))).toBe(false)
    expect(isUnreachable(new DOMException("The operation was aborted.", "AbortError"))).toBe(false)
    expect(isUnreachable(new Error("Network unavailable"))).toBe(false)
    expect(isUnreachable(new TypeError("Connection reset while reading body"))).toBe(false)
    expect(isUnreachable("login.microsoftonline.com could not be reached")).toBe(false)
    expect(isUnreachable(undefined)).toBe(false)
    const circuit = new NetworkCircuit(1)
    expect(() => circuit.failed("Microsoft Graph", new TypeError("Connection reset while reading body"))).toThrow("did not respond")
    expect(isUnreachable(circuit.signal.reason)).toBe(false)
    // A cause cycle ends at the depth bound.
    const cycle: Error & { cause?: unknown } = new Error("cycle")
    cycle.cause = cycle
    expect(isUnreachable(cycle)).toBe(false)
  })
})

describe("unreachable backup jobs", () => {
  const engineWith = (getToken: () => Promise<string>, fetchImpl: typeof fetch = async (input) => new URL(String(input)).hostname === "graph.microsoft.com" ? Response.json({ value: [] }) : new Response(null, { status: 201 })) =>
    new BackupEngine({ fetch: fetchImpl, getToken, concurrency: 1 })

  it("marks a job whose sign-in could not reach Microsoft", async () => {
    const engine = engineWith(async () => { throw msalNetworkError() })
    const job = await engine.waitForJob(engine.start(request))
    expect(job).toMatchObject({ status: "Failed", unreachable: true })
    expect(job.exception).toContain("network_error: Network request failed")
    expect(scheduledResult(job)).toEqual({ status: "Failed", message: job.exception, unreachable: true })
  })

  it("marks a job stopped because Microsoft Graph could not be reached", async () => {
    vi.useFakeTimers()
    const engine = engineWith(async () => "token", withNetworkErrors(async (input) => {
      if (new URL(String(input)).hostname === "graph.microsoft.com") throw new TypeError("fetch failed")
      return new Response(null, { status: 201 })
    }))
    const done = engine.waitForJob(engine.start(request))
    await vi.advanceTimersByTimeAsync(10_000)
    const job = await done
    expect(job).toMatchObject({ status: "Failed", unreachable: true })
    expect(job.exception).toContain("Microsoft Graph did not respond for 3 consecutive requests")
    expect(scheduledResult(job).unreachable).toBe(true)
  })

  it("leaves other failures and completed jobs unmarked", async () => {
    const signIn = engineWith(async () => { throw new SignInRequiredError(TENANT, "app", "Sign in again to continue.") })
    const refused = await signIn.waitForJob(signIn.start(request))
    expect(refused.status).toBe("Failed")
    expect(refused.unreachable).toBeUndefined()
    expect(scheduledResult(refused)).toEqual({ status: "Failed", message: "Sign in again to continue." })
    expect("unreachable" in scheduledResult(refused)).toBe(false)

    const denied = engineWith(async () => "token", async (input) => new URL(String(input)).hostname === "graph.microsoft.com"
      ? Response.json({ error: { message: "Forbidden" } }, { status: 403 })
      : new Response(null, { status: 201 }))
    const partial = await denied.waitForJob(denied.start(request))
    expect(partial).toMatchObject({ status: "Failed", failures: 1 })
    expect(partial.unreachable).toBeUndefined()
    expect(scheduledResult(partial)).toEqual({ status: "Failed", message: partial.progressMessage })

    const healthy = engineWith(async () => "token")
    const completed = await healthy.waitForJob(healthy.start(request))
    expect(completed.status).toBe("Completed")
    expect(completed.unreachable).toBeUndefined()
    expect(scheduledResult(completed)).toEqual({ status: "Completed", message: "Backup completed successfully" })
  })
})
