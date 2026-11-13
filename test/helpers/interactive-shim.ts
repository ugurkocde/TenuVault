import type { LoopbackSignInRequest } from "../../src/main/auth/loopback-sign-in"

/**
 * Stands in for loopbackSignIn in tests of its callers: `interactive` plays the browser and
 * Microsoft (it may call request.openBrowser and resolves with the token result). It keeps the
 * contract the callers rely on: an abort rejects with its reason and redeems nothing, and
 * onAnswer runs before a result is returned.
 */
export function interactiveShim(interactive: (request: LoopbackSignInRequest) => unknown) {
  return (request: LoopbackSignInRequest) => new Promise((resolve, reject) => {
    const signal = request.signal
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    let started: unknown
    try {
      started = interactive(request)
    } catch (error) {
      return reject(error)
    }
    Promise.resolve(started)
      .then((result) => {
        if (signal?.aborted) return
        request.onAnswer?.()
        resolve(result)
      }, reject)
  })
}
