import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  MAX_PROXY_AUTH_ATTEMPTS,
  PROXY_CREDENTIALS_KEY,
  PROXY_PROMPT_QUIET_MS,
  ProxyAuth,
  ProxyPrompts,
  type ProxyAuthOptions,
  type ProxyChallenge,
} from "../src/main/proxy-auth"
import { SecureStore } from "../src/main/storage/secure-store"
import type { ProxySignInAnswer } from "../src/shared/ipc"

const cipher = { encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
const storePath = () => join(mkdtempSync(join(tmpdir(), "tv-proxy-")), "app-state.bin")

const PROXY: ProxyChallenge = { isProxy: true, scheme: "basic", host: "Proxy.Contoso.example", port: 8080, realm: "Contoso proxy" }
const SERVER: ProxyChallenge = { isProxy: false, scheme: "basic", host: "graph.microsoft.com", port: 443, realm: "" }
const answer = (username = "contoso\\backup", password = "correct", remember = true): ProxySignInAnswer => ({ username, password, remember })

function setup(options: Partial<ProxyAuthOptions> & { answers?: Array<ProxySignInAnswer | null> } = {}) {
  const store = options.store ?? new SecureStore(storePath(), cipher)
  const answers = options.answers ?? [answer()]
  const prompt = vi.fn(async (): Promise<ProxySignInAnswer | null> => (answers.length > 1 ? answers.shift()! : answers[0]!))
  const auth = new ProxyAuth({ store, persist: true, prompt: options.prompt ?? prompt, now: options.now })
  return { auth, store, prompt }
}

describe("ProxyAuth", () => {
  it("answers proxy challenges and never server challenges", async () => {
    const { auth, prompt } = setup()
    expect(await auth.attempt().login(SERVER)).toBeNull()
    expect(prompt).not.toHaveBeenCalled()
    expect(await auth.attempt().login(PROXY)).toEqual({ username: "contoso\\backup", password: "correct" })
    expect(prompt).toHaveBeenCalledWith({ proxy: "proxy.contoso.example:8080", scheme: "basic", realm: "Contoso proxy", rejected: false, persistent: true })
  })

  it("opens one prompt for concurrent challenges of the same proxy", async () => {
    let resolve!: (value: ProxySignInAnswer | null) => void
    const prompt = vi.fn(() => new Promise<ProxySignInAnswer | null>((done) => { resolve = done }))
    const { auth } = setup({ prompt })
    const waiting = [auth.attempt().login(PROXY), auth.attempt().login(PROXY), auth.attemptFor("app:https://example.invalid/").login(PROXY)]
    await Promise.resolve()
    expect(prompt).toHaveBeenCalledTimes(1)
    resolve(answer())
    expect(await Promise.all(waiting)).toEqual(Array(3).fill({ username: "contoso\\backup", password: "correct" }))
    // Later requests use the answer without asking again.
    expect(await auth.attempt().login(PROXY)).toEqual({ username: "contoso\\backup", password: "correct" })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("asks separately for a different proxy", async () => {
    const { auth, prompt } = setup()
    await auth.attempt().login(PROXY)
    await auth.attempt().login({ ...PROXY, port: 3128 })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it("remembers credentials in the encrypted store across a restart", async () => {
    const path = storePath()
    const first = setup({ store: new SecureStore(path, cipher) })
    await first.auth.attempt().login(PROXY)
    expect(JSON.parse(first.store.get(PROXY_CREDENTIALS_KEY)!)).toEqual({ "proxy.contoso.example:8080": { username: "contoso\\backup", password: "correct" } })

    const restarted = setup({ store: new SecureStore(path, cipher) })
    expect(await restarted.auth.attempt().login(PROXY)).toEqual({ username: "contoso\\backup", password: "correct" })
    expect(restarted.prompt).not.toHaveBeenCalled()
    expect(restarted.auth.list()).toEqual([{ proxy: "proxy.contoso.example:8080", username: "contoso\\backup", saved: true }])
  })

  it("keeps credentials for the session only without Remember or without OS encryption", async () => {
    const path = storePath()
    const unticked = setup({ store: new SecureStore(path, cipher), answers: [answer(undefined, undefined, false)] })
    await unticked.auth.attempt().login(PROXY)
    expect(await unticked.auth.attempt().login(PROXY)).not.toBeNull()
    expect(unticked.prompt).toHaveBeenCalledTimes(1)
    expect(unticked.store.get(PROXY_CREDENTIALS_KEY)).toBeNull()
    expect(unticked.auth.list()).toEqual([{ proxy: "proxy.contoso.example:8080", username: "contoso\\backup", saved: false }])

    const store = new SecureStore(storePath(), cipher)
    const prompt = vi.fn(async () => answer())
    const plain = new ProxyAuth({ store, persist: false, prompt })
    await plain.attempt().login(PROXY)
    expect(await plain.attempt().login(PROXY)).not.toBeNull()
    expect(store.get(PROXY_CREDENTIALS_KEY)).toBeNull()
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ persistent: false }))
    // A restart without OS encryption asks again.
    const restartedPrompt = vi.fn(async () => answer())
    await new ProxyAuth({ store, persist: false, prompt: restartedPrompt }).attempt().login(PROXY)
    expect(restartedPrompt).toHaveBeenCalledTimes(1)
  })

  it("clears rejected stored credentials and asks again", async () => {
    const store = new SecureStore(storePath(), cipher)
    store.set(PROXY_CREDENTIALS_KEY, JSON.stringify({ "proxy.contoso.example:8080": { username: "contoso\\backup", password: "expired" } }))
    const { auth, prompt } = setup({ store, answers: [answer(undefined, "new")] })
    const request = auth.attempt()
    expect(await request.login(PROXY)).toEqual({ username: "contoso\\backup", password: "expired" })
    expect(prompt).not.toHaveBeenCalled()
    // The proxy challenges the same request again: the stored password was refused.
    expect(await request.login(PROXY)).toEqual({ username: "contoso\\backup", password: "new" })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ rejected: true }))
    expect(JSON.parse(store.get(PROXY_CREDENTIALS_KEY)!)["proxy.contoso.example:8080"].password).toBe("new")
  })

  it("stops after a bounded number of wrong answers, so a loop is impossible", async () => {
    let now = 0
    const { auth, prompt, store } = setup({ answers: [answer(undefined, "wrong")], now: () => now })
    const request = auth.attempt()
    const answers = []
    for (let i = 0; i < 10; i++) answers.push(await request.login(PROXY))
    expect(answers.filter(Boolean)).toHaveLength(MAX_PROXY_AUTH_ATTEMPTS)
    expect(answers.at(-1)).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(MAX_PROXY_AUTH_ATTEMPTS)
    // The last refused answer is not kept either.
    expect(store.get(PROXY_CREDENTIALS_KEY)).toBeNull()

    // Every other request refused the same way stops the prompts too, for a quiet period.
    for (let i = 0; i < 5; i++) {
      const next = auth.attempt()
      while (await next.login(PROXY)) { /* the proxy keeps refusing */ }
    }
    expect(prompt).toHaveBeenCalledTimes(MAX_PROXY_AUTH_ATTEMPTS)
    const quiet = prompt.mock.calls.length
    expect(await auth.attempt().login(PROXY)).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(quiet)
    now += PROXY_PROMPT_QUIET_MS + 1
    await auth.attempt().login(PROXY)
    expect(prompt).toHaveBeenCalledTimes(quiet + 1)
  })

  it("resets the wrong answer count once the proxy accepts", async () => {
    const { auth, prompt } = setup({ answers: [answer(undefined, "wrong"), answer(undefined, "right")] })
    const request = auth.attempt()
    await request.login(PROXY)
    expect(await request.login(PROXY)).toEqual({ username: "contoso\\backup", password: "right" })
    request.responded()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(await auth.attempt().login(PROXY)).toEqual({ username: "contoso\\backup", password: "right" })
  })

  it("does not ask again right after Cancel", async () => {
    let now = 0
    const { auth, prompt, store } = setup({ answers: [null], now: () => now })
    expect(await auth.attempt().login(PROXY)).toBeNull()
    expect(await auth.attempt().login(PROXY)).toBeNull()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(store.get(PROXY_CREDENTIALS_KEY)).toBeNull()
    now += PROXY_PROMPT_QUIET_MS + 1
    await auth.attempt().login(PROXY)
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it("bounds challenges reported without their request", async () => {
    const { auth, prompt } = setup({ answers: [answer(undefined, "wrong")] })
    const answers = []
    for (let i = 0; i < 10; i++) answers.push(await auth.attemptFor("updates").login(PROXY))
    expect(answers.filter(Boolean)).toHaveLength(MAX_PROXY_AUTH_ATTEMPTS)
    expect(prompt).toHaveBeenCalledTimes(MAX_PROXY_AUTH_ATTEMPTS)
  })

  it("forgets remembered credentials", async () => {
    const { auth, prompt, store } = setup()
    await auth.attempt().login(PROXY)
    auth.forget()
    expect(store.get(PROXY_CREDENTIALS_KEY)).toBeNull()
    expect(auth.list()).toEqual([])
    await auth.attempt().login(PROXY)
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})

describe("ProxyPrompts", () => {
  it("keeps prompts until answered and treats anything malformed as Cancel", async () => {
    const notify = vi.fn()
    const prompts = new ProxyPrompts(notify)
    const first = prompts.ask({ proxy: "proxy.contoso.example:8080", scheme: "basic", realm: "", rejected: false, persistent: true })
    const second = prompts.ask({ proxy: "proxy.fabrikam.example:3128", scheme: "basic", realm: "", rejected: false, persistent: true })
    const [a, b] = prompts.pending() as [ReturnType<ProxyPrompts["pending"]>[number], ReturnType<ProxyPrompts["pending"]>[number]]
    expect(notify).toHaveBeenLastCalledWith([a, b])
    prompts.answer(a.id, { username: " admin ", password: "secret", remember: false })
    prompts.answer(b.id, { username: 42 })
    prompts.answer(999, answer())
    expect(await first).toEqual({ username: "admin", password: "secret", remember: false })
    expect(await second).toBeNull()
    expect(prompts.pending()).toEqual([])
    expect(notify).toHaveBeenLastCalledWith([])
  })
})
