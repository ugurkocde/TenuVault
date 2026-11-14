import { retryDelay, retryableStatus, sleep } from "../graph-retry"
import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { GRAPH, MAX_LIST_PAGES, REQUEST_ATTEMPTS, GraphError, GraphPauseError, GraphUnansweredError, RequestTimeoutError, TokenError, graphFailure, requestFailure, withRequestTimeout } from "./request"

export type GraphItem = Record<string, unknown> & { id: string }

export interface GraphSessionOptions {
  /** The service the session reads for. Its auth failures are counted apart from other services'. */
  service?: string
  /**
   * The session of a service that isolates its failures (see ServiceModule.isolated). A pause longer
   * than the bound fails the request that got it and leaves the other readers of the service alone.
   * Requests that get no answer count for this service only: too many in a row stop the service,
   * never the job. Without it, the pause stops every reader of the session and unanswered requests
   * count toward the job's circuit, as they always have.
   */
  isolated?: boolean
}

export interface ListOptions {
  /** Headers of the type the list belongs to, sent with every page. */
  headers?: Readonly<Record<string, string>>
  /** The type's mandatory $filter. A continuation link that left it out gets it back; one with another filter is refused. */
  filter?: string
}

/** The Graph versions a list may be read from. */
const VERSION = /^\/(beta|v1\.0)\//

/** The filters a link carries. Microsoft Graph also reads the option without its $ and in any case. */
const filtersOf = (link: URL) => [...link.searchParams].filter(([name]) => /^\$?filter$/i.test(name)).map(([, value]) => value)

/**
 * Graph reads of one service for one backup. A throttled request (429) pauses every reader of the
 * service until Graph allows requests again; other services have their own session and read on.
 */
export class GraphSession {
  private resumeAt = 0
  private throttleError: Error | undefined
  /** A service that isolates its failures: its requests in a row without an answer, and the error once they stopped it. */
  private unanswered = 0
  private stopped: GraphUnansweredError | undefined

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
    // Microsoft Graph repeats the path of the request in its continuation links, so a link stays on the collection
    // (and with it the version) the list started on. Anything else would merge another collection's objects into this one.
    const collection = new URL(url).pathname.toLowerCase()
    while (next) {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Graph listing did not finish after ${MAX_LIST_PAGES} pages`)
      const parsed = new URL(next)
      if (parsed.origin !== GRAPH || !VERSION.test(collection) || parsed.pathname.toLowerCase() !== collection || seen.has(next)) throw new Error("Invalid Graph continuation link")
      const filters = filtersOf(parsed)
      // A link with another filter would list what the type's filter leaves out, such as objects that are not the tenant's own.
      if (options.filter !== undefined && filters.some((filter) => filter !== options.filter)) throw new Error("Invalid Graph continuation link")
      seen.add(next)
      // Appended as text: rewriting the query would re-encode the paging token Graph issued.
      const request: string = options.filter !== undefined && !filters.length ? `${next}${parsed.search ? "&" : "?"}$filter=${encodeURIComponent(options.filter)}` : next
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
      if (this.stopped) throw this.stopped
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
            this.answered()
            return result
          }
          throw await graphFailure(response)
        }, this.network.signal)
      } catch (error) {
        this.network.signal.throwIfAborted()
        const unanswered = (attempted || error instanceof RequestTimeoutError) && requestFailure(error) === "network"
        if (unanswered) this.notAnswered(error)
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
          // Named, so the backup ends the type this request belongs to instead of asking for each of its objects in vain.
          if (this.options.isolated && unanswered) throw new GraphUnansweredError(error instanceof Error ? error.message : String(error), { cause: error })
          throw error
        }
        await sleep(delay, this.network.signal)
      }
    }
  }

  /** A request was answered: the streak of unanswered ones is over, for the job or for this service alone. */
  private answered(): void {
    if (!this.options.isolated) return this.network.succeeded("Microsoft Graph", this.options.service)
    this.network.signal.throwIfAborted()
    this.unanswered = 0
  }

  /**
   * A request got no answer. For a service that isolates its failures it counts for that service
   * only, with the job's own limit: at the limit the service stops and its remaining requests are
   * not sent, while the other services read on. For any other service it counts toward the job's circuit.
   */
  private notAnswered(error: unknown): void {
    if (!this.options.isolated) return this.network.failed("Microsoft Graph", error)
    if (++this.unanswered < this.network.threshold) return
    this.stopped ??= new GraphUnansweredError(`Microsoft Graph did not respond for ${this.unanswered} consecutive requests of this service, so the rest of the service was not read.`, { cause: error })
    throw this.stopped
  }
}
