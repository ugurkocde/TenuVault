import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { GRAPH, MAX_LIST_PAGES, REQUEST_ATTEMPTS, GraphError, GraphPauseError, RequestTimeoutError, TokenError, graphFailure, requestFailure, withRequestTimeout } from "./request"

export type GraphItem = Record<string, unknown> & { id: string }

export interface GraphSessionOptions {
  /** The service the session reads for. Its auth failures are counted apart from other services'. */
  service?: string
  /**
   * A pause longer than the bound fails the request that got it and leaves the other readers of
   * the service alone. Without it, the pause stops every reader of the session, as it always has.
   */
  isolated?: boolean
}

export interface ListOptions {
  /** Headers of the type the list belongs to, sent with every page. */
  headers?: Readonly<Record<string, string>>
  /** The type's mandatory $filter. A continuation link that left it out gets it back. */
  filter?: string
}

/** The Graph versions a list may be read from; a continuation link stays within the version its list started in. */
const VERSION = /^\/(beta|v1\.0)\//

/**
 * Graph reads of one service for one backup. A throttled request (429) pauses every reader of the
 * service until Graph allows requests again; other services have their own session and read on.
 */
export class GraphSession {
  private resumeAt = 0
  private throttleError: Error | undefined

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly token: () => Promise<string>,
    private readonly network: NetworkCircuit,
    private readonly options: GraphSessionOptions = {},
  ) {}

  async list(url: string, options: ListOptions = {}): Promise<GraphItem[]> {
    const items: GraphItem[] = []
    let next: string | undefined = url
    const seen = new Set<string>()
    const version = VERSION.exec(new URL(url).pathname)?.[0]
    while (next) {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Graph listing did not finish after ${MAX_LIST_PAGES} pages`)
      const parsed = new URL(next)
      if (parsed.origin !== GRAPH || !version || !parsed.pathname.startsWith(version) || seen.has(next)) throw new Error("Invalid Graph continuation link")
      seen.add(next)
      // Appended as text: rewriting the query would re-encode the paging token Graph issued.
      const request: string = options.filter !== undefined && !parsed.searchParams.has("$filter") ? `${next}${parsed.search ? "&" : "?"}$filter=${encodeURIComponent(options.filter)}` : next
      const page: { value?: GraphItem[]; "@odata.nextLink"?: string } = await this.get(request, options.headers)
      if (!Array.isArray(page.value)) throw new Error("Graph returned an invalid policy collection")
      items.push(...page.value)
      next = page["@odata.nextLink"]
    }
    return items
  }

  /** GET with bounded retries for throttling, transient status codes and network failures. */
  async get<T = Record<string, unknown>>(url: string, headers?: Readonly<Record<string, string>>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.network.signal.throwIfAborted()
      while (this.resumeAt > Date.now() && !this.throttleError) await sleep(this.resumeAt - Date.now(), this.network.signal)
      if (this.throttleError) throw this.throttleError
      let response: Response | undefined
      let attempted = false
      try {
        return await withRequestTimeout(async (signal) => {
          const token = await this.token()
          signal.throwIfAborted()
          if (this.throttleError) throw this.throttleError
          if (this.resumeAt > Date.now()) throw new GraphPauseError()
          attempted = true
          // The sign-in comes last, so no type can replace it.
          response = await this.fetchImpl(url, { signal, headers: { ...headers, Authorization: `Bearer ${token}` } })
          if (response.ok) {
            const result = (await response.json()) as T
            signal.throwIfAborted()
            this.network.succeeded("Microsoft Graph", this.options.service)
            return result
          }
          throw await graphFailure(response)
        }, this.network.signal)
      } catch (error) {
        this.network.signal.throwIfAborted()
        if ((attempted || error instanceof RequestTimeoutError) && requestFailure(error) === "network") this.network.failed("Microsoft Graph", error)
        if (error instanceof GraphPauseError) {
          attempt--
          continue
        }
        if (this.throttleError && error === this.throttleError) throw error
        if (error instanceof FetchApplicationError || error instanceof TokenError || (error instanceof GraphError && !retryableStatus(error.status))) throw error
        let delay: number
        try {
          delay = retryDelay(response, attempt)
        } catch (delayError) {
          // A pause beyond our bound stops readers instead of sending requests before Graph permits them.
          if (response?.status === 429 && delayError instanceof Error && !this.options.isolated) this.throttleError = delayError
          throw delayError
        }
        if (response?.status === 429) this.resumeAt = Math.max(this.resumeAt, Date.now() + delay)
        if (attempt >= REQUEST_ATTEMPTS - 1) {
          if (!attempted && error instanceof RequestTimeoutError) throw new TokenError(error.message, { cause: error })
          throw error
        }
        await sleep(delay, this.network.signal)
      }
    }
  }
}
