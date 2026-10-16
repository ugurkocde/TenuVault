import { AuthError, ClientAuthErrorCodes, ConfidentialClientApplication, InteractionRequiredAuthError } from "@azure/msal-node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBridgedFetch } from "../src/main/api/fetch-bridge"
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
  vi.unstubAllGlobals()
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

  describe("with the default concurrency", () => {
    const only = (...folders: string[]) => ({ excluded: INTUNE_TYPES.filter((type) => !folders.includes(type.folder)).map((type) => type.folder) })
    const twoTypes = { ...request, scope: only("DeviceConfigurations", "CompliancePolicies") }
    type Answer = (url: URL, init?: RequestInit) => Response | Promise<Response> | null
    // Graph and storage answer through `graph` and `storage`; `null` stands for a request that gets no response.
    const run = async (backup: typeof request, graph: Answer, options: { storage?: Answer; concurrency?: number } = {}) => {
      vi.useFakeTimers()
      const storage = options.storage ?? (() => new Response(null, { status: 201 }))
      const engine = new BackupEngine({
        getToken: async () => "token",
        concurrency: options.concurrency,
        fetch: withNetworkErrors(async (input, init) => {
          const url = new URL(String(input))
          const response = (url.hostname === "graph.microsoft.com" ? graph : storage)(url, init)
          if (!response) throw new TypeError("net::ERR_INTERNET_DISCONNECTED")
          return response
        }),
      })
      const done = engine.waitForJob(engine.start(backup))
      await vi.advanceTimersByTimeAsync(300_000)
      return done
    }

    it("marks a one-type backup whose Graph requests all got no response, below the circuit threshold", async () => {
      const job = await run(request, () => null)
      expect(job).toMatchObject({ status: "Failed", failures: 1, unreachable: true, progressMessage: "Backup failed: no policies could be saved" })
      expect(job.exception).toBeUndefined()
      expect(scheduledResult(job)).toEqual({ status: "Failed", message: "Backup failed: no policies could be saved", unreachable: true })
    })

    it("marks a full backup stopped by the circuit while every request got no response", async () => {
      const job = await run({ ...request, scope: { excluded: [] } }, () => null)
      expect(job).toMatchObject({ status: "Failed", unreachable: true })
      expect(job.exception).toContain("Microsoft Graph did not respond for 24 consecutive requests")
    })

    it("counts a backup stopped by the circuit after it saved a policy", async () => {
      const items = Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, displayName: `Item ${index}` }))
      const job = await run({ ...request, scope: { excluded: [] } }, (url) => url.pathname.endsWith("/deviceConfigurations")
        ? Response.json({ value: items })
        : url.pathname.endsWith("/deviceConfigurations/item-0") ? Response.json({ id: "item-0" })
          : url.pathname.includes("/deviceConfigurations/") ? null : Response.json({ value: [] }))
      expect(job).toMatchObject({ status: "Failed" })
      expect(job.exception).toContain("Microsoft Graph did not respond for 24 consecutive requests")
      expect(job.unreachable).toBeUndefined()
    })

    it("counts a listing timeout that ends the job before a concurrent 401", async () => {
      // Device configurations: no response, then two requests that time out after 90 seconds each (183 s).
      // Compliance policies: two timeouts, then a 401 that arrives 30 seconds into the third request (213 s).
      const attempts = { configurations: 0, compliance: 0 }
      const hang = () => new Promise<Response>(() => {})
      const job = await run(twoTypes, (url) => {
        if (url.pathname.endsWith("/deviceConfigurations")) return ++attempts.configurations === 1 ? null : hang()
        if (++attempts.compliance < 3) return hang()
        return new Promise((resolve) => setTimeout(() => resolve(Response.json({ error: { message: "Unauthorized" } }, { status: 401 })), 30_000))
      })
      expect(attempts).toEqual({ configurations: 3, compliance: 3 })
      expect(job).toMatchObject({ status: "Failed", exception: "Backup request timed out after 90 seconds. Check your connection and retry." })
      expect(job.unreachable).toBeUndefined()
    })

    it("counts a 401 whose body was still arriving when the circuit stopped the job", async () => {
      // Two readers trip the circuit after six failures. Compliance policies get a 401 on their third
      // request, at 3 s, and its body takes 500 ms. Other requests fail 1 ms late, so the third listing's
      // first failure, the sixth, trips the circuit while that body is still arriving.
      let compliance = 0
      const lateFailure = () => new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new TypeError("net::ERR_INTERNET_DISCONNECTED")), 1))
      const slowBody = () => new ReadableStream<Uint8Array>({ start(controller) {
        setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"error":{"message":"Unauthorized"}}')); controller.close() }, 500)
      } })
      const job = await run({ ...request, scope: only("DeviceConfigurations", "CompliancePolicies", "ComplianceSettingsPolicies") }, (url) =>
        !url.pathname.endsWith("/deviceCompliancePolicies") ? lateFailure() : ++compliance === 3 ? new Response(slowBody(), { status: 401 }) : null, { concurrency: 2 })
      expect(compliance).toBe(3)
      expect(job).toMatchObject({ status: "Failed" })
      expect(job.exception).toContain("Microsoft Graph did not respond for 6 consecutive requests")
      expect(job.unreachable).toBeUndefined()
    })

    // Two readers trip the circuit after six failures. The compliance reader's sign-in is refused
    // `delay` microtasks after the sixth transport failure, so the refusal reaches the request layer
    // only after the circuit stopped the job and its abort reason has replaced the refusal there.
    it.each(Array.from({ length: 13 }, (_, delay) => delay))("counts a sign-in refusal racing the circuit (%i microtasks late)", async (delay) => {
      vi.useFakeTimers()
      let tokens = 0
      let graphRequests = 0
      let refuse!: (error: Error) => void
      const engine = new BackupEngine({
        concurrency: 2,
        // The second token request is the compliance reader's first; the device configurations reader's tokens are cached.
        getToken: () => ++tokens === 2 ? new Promise<string>((_resolve, reject) => { refuse = reject }) : Promise.resolve("token"),
        fetch: withNetworkErrors(async (input) => {
          if (new URL(String(input)).hostname !== "graph.microsoft.com") return new Response(null, { status: 201 })
          if (++graphRequests === 6) {
            let left = delay
            const later = (): unknown => left-- > 0 ? Promise.resolve().then(later) : refuse(new SignInRequiredError(TENANT, "app", "Sign in again to continue."))
            void later()
          }
          throw new TypeError("net::ERR_INTERNET_DISCONNECTED")
        }),
      })
      const done = engine.waitForJob(engine.start({ ...request, scope: only("DeviceConfigurations", "CompliancePolicies", "ComplianceSettingsPolicies") }))
      await vi.advanceTimersByTimeAsync(60_000)
      const job = await done
      expect(graphRequests).toBe(6)
      expect(job).toMatchObject({ status: "Failed", exception: expect.stringContaining("Microsoft Graph did not respond for 6 consecutive requests") })
      expect(job.unreachable).toBeUndefined()
    })

    // Chromium's net.fetch rejects a request with AbortError when its signal aborts. Such a rejection
    // follows the job's own abort (the circuit or a request timeout) and is not another cause.
    const abortable = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true })
    })

    it("marks a backup whose in-flight request was aborted when the circuit stopped the job", async () => {
      let pending = 0
      const job = await run({ ...request, scope: only("DeviceConfigurations", "CompliancePolicies", "ComplianceSettingsPolicies") }, (url, init) => {
        if (!url.pathname.endsWith("/deviceCompliancePolicies")) return null
        pending++
        return abortable(init)
      }, { concurrency: 2 })
      expect(pending).toBe(1)
      expect(job).toMatchObject({ status: "Failed", unreachable: true, exception: expect.stringContaining("Microsoft Graph did not respond for 6 consecutive requests") })
    })

    it("marks a backup whose requests were aborted by their timeout", async () => {
      let requests = 0
      const job = await run(request, (_url, init) => {
        requests++
        return abortable(init)
      })
      expect(requests).toBe(3)
      expect(job).toMatchObject({ status: "Failed", unreachable: true, exception: "Backup request timed out after 90 seconds. Check your connection and retry." })
    })

    it("marks a backup whose Azure storage request ended in a network error response", async () => {
      const job = await run({ ...request, storageAccountName: "contoso" }, () => null, { storage: () => Response.error() })
      expect(job).toMatchObject({ status: "Failed", exception: "Storage account contoso could not be reached.", unreachable: true })
    })

    it("marks a backup to Azure storage when neither storage nor Graph answers", async () => {
      const job = await run({ ...request, storageAccountName: "contoso" }, () => null, { storage: () => null })
      expect(job).toMatchObject({ status: "Failed", unreachable: true })
      expect(job.exception).toContain("contoso.blob.core.windows.net could not be reached")
    })

    it.each([201, 403])("counts a backup whose Azure storage answered %s while Graph got no response", async (status) => {
      const job = await run({ ...request, storageAccountName: "contoso" }, () => null, { storage: () => new Response(null, { status }) })
      expect(job.status).toBe("Failed")
      expect(job.unreachable).toBeUndefined()
      if (status === 403) expect(job.exception).toContain("write access to storage account contoso")
      else expect(job).toMatchObject({ failures: 1, progressMessage: "Backup failed: no policies could be saved" })
    })

    it("counts a backup that also had an HTTP failure", async () => {
      const job = await run(twoTypes, (url) => url.pathname.endsWith("/deviceCompliancePolicies") ? Response.json({ error: { message: "Forbidden" } }, { status: 403 }) : null)
      expect(job).toMatchObject({ status: "Failed", failures: 2 })
      expect(job.unreachable).toBeUndefined()
      expect(scheduledResult(job).unreachable).toBeUndefined()
    })

    it("counts a partial backup that saved some policies", async () => {
      const job = await run(twoTypes, (url) => url.pathname.includes("/deviceCompliancePolicies")
        ? null
        : url.pathname.endsWith("/deviceConfigurations") ? Response.json({ value: [{ id: "saved", displayName: "Saved" }] }) : Response.json({ id: "saved" }))
      expect(job).toMatchObject({ status: "Completed", failures: 1 })
      expect(job.unreachable).toBeUndefined()
      expect(scheduledResult(job)).toEqual({ status: "Failed", message: job.progressMessage })
    })
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

describe("token requests through the fetch bridge and MSAL", () => {
  // MSAL sends token requests with the global fetch, which the app replaces with the bridge.
  const tokenError = async (scope: string, network: typeof fetch) => {
    vi.stubGlobal("fetch", createBridgedFetch({ dispatch: vi.fn(), getDelegatedToken: vi.fn(), fetch: withNetworkErrors(network) }))
    const client = new ConfidentialClientApplication({ auth: { clientId: request.clientId, authority: `https://login.microsoftonline.com/${TENANT}`, clientSecret: "secret" } })
    return client.acquireTokenByClientCredential({ scopes: [scope] }).then(() => null, (error: unknown) => error)
  }
  const portal: typeof fetch = async () => new Response("<html><body>Sign in to the network</body></html>", { status: 200, headers: { "content-type": "text/html" } })

  it.each(["https://storage.azure.com/.default", "https://graph.microsoft.com/.default"])("counts a network sign-in page answering a token request for %s", async scope => {
    const error = await tokenError(scope, portal)
    expect(error).toMatchObject({ errorCode: "token_parsing_error" })
    expect(isUnreachable(error)).toBe(false)
    expect(isUnreachable(new TokenError("Failed to parse response", { cause: error }))).toBe(false)
  })

  it("treats a token request that got no response as unreachable", async () => {
    const error = await tokenError("https://storage.azure.com/.default", async () => { throw new TypeError("net::ERR_INTERNET_DISCONNECTED") })
    expect(error).toMatchObject({ errorCode: "network_error" })
    expect(isUnreachable(error)).toBe(true)
  })
})
