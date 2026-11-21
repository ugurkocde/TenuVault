import { expect, it, vi } from "vitest"
import { DIRECTORY_RETRIES, directoryRetryAt, waitForDirectoryRetry } from "../src/main/restore/directory-retry"

it("honors numeric and HTTP-date Retry-After and uses exponential fallback", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-20T12:00:00Z"))
  try {
    expect(DIRECTORY_RETRIES).toBe(4)
    for (const header of ["2", "Fri, 20 Nov 2026 12:00:02 GMT"]) {
      const retryAt = directoryRetryAt(new Response(null, { status: 429, headers: { "Retry-After": header } }), 0)
      expect(retryAt).toBe(Date.now() + 2000)
      const wait = vi.fn(async (_ms: number) => {})
      await waitForDirectoryRetry(retryAt, undefined, wait)
      expect(wait).toHaveBeenCalledExactlyOnceWith(2000)
    }
    for (const header of [undefined, "invalid"]) {
      for (let attempt = 0; attempt < 4; attempt++) expect(directoryRetryAt(new Response(null, { status: 429, ...(header ? { headers: { "Retry-After": header } } : {}) }), attempt)).toBe(Date.now() + 1000 * 2 ** attempt)
    }
    const wait = vi.fn(async (_ms: number) => {})
    await expect(waitForDirectoryRetry(directoryRetryAt(new Response(null, { status: 429, headers: { "Retry-After": "120" } }), 0), undefined, wait)).rejects.toThrow("deferred")
    expect(wait).not.toHaveBeenCalled()
  } finally { now.mockRestore() }
})
