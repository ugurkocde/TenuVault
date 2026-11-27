export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000

export class RetentionClockError extends Error {}

/** Observes time from the Microsoft requests the backup already sends. */
export class RetentionClock {
  private sample?: { time: number; observed: number }

  constructor(private readonly graph: string, private readonly azure: string | null) {}

  wrap(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const response = await fetchImpl(input, init)
      const origin = new URL(input instanceof Request ? input.url : input).origin
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      // Azure writes have the original HTTPS response, outside the sealed-read compatibility path.
      if (response.ok && !response.redirected && (!response.url || new URL(response.url).origin === origin)
        && (origin === this.graph || (origin === this.azure && method === "PUT"))) {
        const time = Date.parse(response.headers.get("date") ?? "")
        if (Number.isFinite(time)) this.sample = { time, observed: performance.now() }
      }
      return response
    }
  }

  get hasTime(): boolean { return this.sample !== undefined }

  trustedTime(wall: number): number {
    if (!this.sample) throw new RetentionClockError("no server time was available from Microsoft")
    const time = this.sample.time + Math.max(0, performance.now() - this.sample.observed)
    if (Math.abs(wall - time) > HOUR_MS) throw new RetentionClockError("the device clock differs from Microsoft's time by more than one hour")
    return time
  }
}
