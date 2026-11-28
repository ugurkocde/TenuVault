import { createServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { startStandInProxy } from "../scripts/sign-in-e2e/proxy.mjs"
// @ts-expect-error The CI harness is plain JavaScript without type declarations.
import { LICENSE_HOST, LOGIN_HOST } from "../scripts/sign-in-e2e/stand-in.mjs"

it("tunnels both sign-in hosts to the stand-in and rejects other destinations", async () => {
  // A local server on an ephemeral port makes it observable where the tunnel actually ends.
  const standIn = createServer((req, res) => res.end(req.headers.host))
  await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve))
  try {
    const proxy = await startStandInProxy((standIn.address() as AddressInfo).port)
    try {
      const connectThrough = (target: string) => new Promise<{ status: number | undefined; reply: string }>((resolve, reject) => {
        const tunnel = request(proxy.url, { method: "CONNECT", path: target })
        tunnel.on("error", reject)
        tunnel.on("connect", (response, socket) => {
          if (response.statusCode !== 200) {
            socket.destroy()
            resolve({ status: response.statusCode, reply: "" })
            return
          }
          let reply = ""
          socket.on("error", reject)
          socket.on("data", (chunk) => { reply += chunk })
          socket.on("end", () => resolve({ status: response.statusCode, reply }))
          socket.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`)
        })
        tunnel.end()
      })
      for (const host of [LOGIN_HOST, LICENSE_HOST]) {
        const target = `${host}:443`
        await expect(connectThrough(target)).resolves.toEqual({ status: 200, reply: expect.stringContaining(`\r\n\r\n${target}`) })
      }
      await expect(connectThrough("example.com:443")).resolves.toEqual({ status: 403, reply: "" })
      await expect(connectThrough(`${LOGIN_HOST}:80`)).resolves.toEqual({ status: 403, reply: "" })
    } finally {
      await proxy.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) => standIn.close((error) => error ? reject(error) : resolve()))
  }
})
