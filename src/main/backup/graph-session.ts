import { FetchApplicationError } from "../api/network-error"
import type { NetworkCircuit } from "./engine"
import { GRAPH, MAX_LIST_PAGES, REQUEST_ATTEMPTS, GraphError, GraphPauseError, RequestTimeoutError, TokenError, graphError, requestFailure, retryDelay, retryableStatus, sleep, withRequestTimeout } from "./request"

export type GraphItem = Record<string, unknown> & { id: string }

/** Graph reads for one backup. A throttled request (429) pauses every reader until Graph allows requests again. */
export class GraphSession {
  private resumeAt = 0
  private throttleError: Error | undefined

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly token: () => Promise<string>,
    private readonly network: NetworkCircuit,
  ) {}

  async list(url: string): Promise<GraphItem[]> {
    const items: GraphItem[] = []
    let next: string | undefined = url
    const seen = new Set<string>()
    while (next) {
      if (seen.size >= MAX_LIST_PAGES) throw new Error(`Graph listing did not finish after ${MAX_LIST_PAGES} pages`)
      const parsed = new URL(next)
      if (parsed.origin !== GRAPH || !parsed.pathname.startsWith("/beta/") || seen.has(next)) throw new Error("Invalid Graph continuation link")
      seen.add(next)
      const page: { value?: GraphItem[]; "@odata.nextLink"?: string } = await this.get(next)
      if (!Array.isArray(page.value)) throw new Error("Graph returned an invalid policy collection")
      items.push(...page.value)
      next = page["@odata.nextLink"]
    }
    return items
  }

  /** GET with bounded retries for throttling, transient status codes and network failures. */
  async get<T = Record<string, unknown>>(url: string): Promise<T> {
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
          response = await this.fetchImpl(url, { signal, headers: { Authorization: `Bearer ${token}` } })
          if (response.ok) {
            const result = (await response.json()) as T
            signal.throwIfAborted()
            this.network.succeeded("Microsoft Graph")
            return result
          }
          throw new GraphError(await graphError(response), response.status)
        }, this.network.signal)
      } catch (error) {
        this.network.signal.throwIfAborted()
        if ((attempted || error instanceof RequestTimeoutError) && requestFailure(error) === "network") this.network.failed("Microsoft Graph")
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
          if (response?.status === 429 && delayError instanceof Error) this.throttleError = delayError
          throw delayError
        }
        if (response?.status === 429) this.resumeAt = Math.max(this.resumeAt, Date.now() + delay)
        if (attempt >= REQUEST_ATTEMPTS - 1) {
          if (!attempted && error instanceof RequestTimeoutError) throw new TokenError(error.message)
          throw error
        }
        await sleep(delay, this.network.signal)
      }
    }
  }
}

