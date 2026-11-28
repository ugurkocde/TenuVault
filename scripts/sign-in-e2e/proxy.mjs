import { createServer } from "node:http"
import { connect } from "node:net"
import { LICENSE_HOST, LOGIN_HOST } from "./stand-in.mjs"

/** Pins HTTPS for the test hosts to the local stand-in, preserving TLS and the requested host. */
export async function startStandInProxy(standInPort) {
  const targets = new Set([`${LOGIN_HOST}:443`, `${LICENSE_HOST}:443`])
  const clients = new Set()
  const server = createServer((_request, response) => response.writeHead(403).end())
  server.on("connection", (socket) => {
    clients.add(socket)
    socket.once("close", () => clients.delete(socket))
  })
  server.on("connect", (request, client, head) => {
    if (!targets.has(request.url)) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return
    }
    const upstream = connect(standInPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    client.on("error", () => client.destroy())
    client.once("close", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => {
      server.close(resolve)
      for (const client of clients) client.destroy()
    }),
  }
}
