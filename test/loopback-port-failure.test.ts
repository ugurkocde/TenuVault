import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"

// A computer where nothing may listen on 127.0.0.1, for example because security software blocks it.
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>()
  const createServer = () => {
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      listen: () => { queueMicrotask(() => server.emit("error", Object.assign(new Error("listen EACCES: permission denied 127.0.0.1"), { code: "EACCES" }))) },
      close: vi.fn(),
      closeAllConnections: vi.fn(),
    })
    return server
  }
  return { ...actual, createServer, default: { ...actual, createServer } }
})

const { loopbackSignIn } = await import("../src/main/auth/loopback-sign-in")

it("says clearly that the local sign-in port could not be opened, before anything opens", async () => {
  const getAuthCodeUrl = vi.fn()
  const openBrowser = vi.fn()
  const outcome = loopbackSignIn({ app: { getAuthCodeUrl } as never, scopes: ["s"], openBrowser, successPage: "ok", errorPage: "no" })
  await expect(outcome).rejects.toThrow("TenuVault could not open a local port for the Microsoft sign-in (EACCES). Check that no security software blocks connections to 127.0.0.1 on this computer, then sign in again.")
  expect(getAuthCodeUrl).not.toHaveBeenCalled()
  expect(openBrowser).not.toHaveBeenCalled()
})
