import type { KeyValueStore } from "./storage/secure-store"
import type { ProxyCredentialSummary, ProxySignInAnswer, ProxySignInPrompt } from "../shared/ipc"

/** Where remembered proxy sign-ins live in the encrypted app store, by proxy host:port. */
export const PROXY_CREDENTIALS_KEY = "network.proxy-credentials"

/** Answers one request gives a proxy before it fails, and prompts in a row for wrong credentials. */
export const MAX_PROXY_AUTH_ATTEMPTS = 3

/** After Cancel (or too many wrong answers) the proxy is not asked about again for this long. */
export const PROXY_PROMPT_QUIET_MS = 30_000

/** How long a challenge reported without its request (app and updater `login` events) counts as the same request. */
const UNTRACKED_ATTEMPT_MS = 60_000

/** The parts of Electron's AuthInfo this module reads. */
export interface ProxyChallenge {
  isProxy: boolean
  scheme: string
  host: string
  port: number
  realm: string
}

export interface ProxyCredentials {
  username: string
  password: string
}

/** One network request's challenges: a second challenge after an answer means the proxy refused it. */
export interface ProxyAuthAttempt {
  /** Credentials for a proxy challenge, or null to cancel it (always null for a server challenge). */
  login: (challenge: ProxyChallenge) => Promise<ProxyCredentials | null>
  /** The request got its response, so credentials it supplied were accepted. */
  responded: () => void
}

interface Known {
  credentials: ProxyCredentials
  /** Written to the encrypted store, so it survives a restart. */
  saved: boolean
}

export interface ProxyAuthOptions {
  store: KeyValueStore
  /** Whether OS encryption protects the store; without it credentials are kept for this session only. */
  persist: boolean
  /** Asks the admin; resolves null for Cancel. Called at most once at a time per proxy. */
  prompt: (request: Omit<ProxySignInPrompt, "id">) => Promise<ProxySignInAnswer | null>
  now?: () => number
  /** Called when the remembered sign-ins change. */
  onChange?: () => void
}

export function proxyKey(challenge: Pick<ProxyChallenge, "host" | "port">): string {
  const host = challenge.host.toLowerCase()
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${challenge.port}`
}

function isCredentials(value: unknown): value is ProxyCredentials {
  return !!value && typeof value === "object" &&
    typeof (value as ProxyCredentials).username === "string" && typeof (value as ProxyCredentials).password === "string"
}

/**
 * Answers proxy authentication challenges (HTTP 407) for the app's own requests, never a
 * server's 401: a server asking for a password gets the cancel Chromium would give it anyway.
 *
 * The admin is asked once per proxy host:port. Challenges for the same proxy that arrive while
 * the dialog is open wait for that one answer. Remembered credentials are kept in the encrypted
 * store, or for this session only when OS encryption is unavailable. When the proxy challenges
 * the same request again right after it got credentials, they were wrong: they are forgotten and
 * the admin is asked again, at most MAX_PROXY_AUTH_ATTEMPTS times, so a loop is impossible.
 */
export class ProxyAuth {
  private known: Map<string, Known> | null = null
  private readonly prompts = new Map<string, Promise<ProxyCredentials | null>>()
  private readonly refusals = new Map<string, number>()
  private readonly quietUntil = new Map<string, number>()
  private readonly untracked = new Map<string, { attempt: ProxyAuthAttempt; at: number }>()

  constructor(private readonly options: ProxyAuthOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Tracks the challenges of one request. */
  attempt(): ProxyAuthAttempt {
    let supplied: { key: string; credentials: ProxyCredentials } | null = null
    let answers = 0
    return {
      login: async (challenge) => {
        if (!challenge.isProxy) return null
        const key = proxyKey(challenge)
        if (supplied?.key === key) this.refused(key, supplied.credentials)
        supplied = null
        if (answers >= MAX_PROXY_AUTH_ATTEMPTS) return null
        answers += 1
        const credentials = await this.credentialsFor(key, challenge)
        if (credentials) supplied = { key, credentials }
        return credentials
      },
      responded: () => {
        if (supplied) this.refusals.delete(supplied.key)
      },
    }
  }

  /**
   * The attempt for a challenge Electron reports without its request object (the app `login`
   * event, the updater's). Challenges with the same `id` within a minute count as one request,
   * which keeps the attempt bound for them too.
   */
  attemptFor(id: string): ProxyAuthAttempt {
    const now = this.now()
    for (const [key, entry] of this.untracked) if (now - entry.at > UNTRACKED_ATTEMPT_MS) this.untracked.delete(key)
    const entry = this.untracked.get(id) ?? { attempt: this.attempt(), at: now }
    entry.at = now
    this.untracked.set(id, entry)
    return entry.attempt
  }

  /** Remembered proxy sign-ins, without passwords. */
  list(): ProxyCredentialSummary[] {
    return [...this.load()].map(([proxy, { credentials, saved }]) => ({ proxy, username: credentials.username, saved }))
  }

  /** Forgets every remembered proxy sign-in; the next challenge asks again. */
  forget(): void {
    this.load().clear()
    this.refusals.clear()
    this.quietUntil.clear()
    this.untracked.clear()
    this.writeSaved()
    this.options.onChange?.()
  }

  private load(): Map<string, Known> {
    if (this.known) return this.known
    const known = new Map<string, Known>()
    if (this.options.persist) {
      try {
        const parsed: unknown = JSON.parse(this.options.store.get(PROXY_CREDENTIALS_KEY) ?? "{}")
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (isCredentials(value)) known.set(key, { credentials: { username: value.username, password: value.password }, saved: true })
          }
        }
      } catch (error) {
        console.warn("[proxy] Could not read remembered proxy sign-ins:", error instanceof Error ? error.message : error)
      }
    }
    this.known = known
    return known
  }

  private writeSaved(): void {
    if (!this.options.persist) return
    const saved = Object.fromEntries([...this.load()].filter(([, entry]) => entry.saved).map(([key, entry]) => [key, entry.credentials]))
    try {
      if (Object.keys(saved).length) this.options.store.set(PROXY_CREDENTIALS_KEY, JSON.stringify(saved))
      else this.options.store.delete(PROXY_CREDENTIALS_KEY)
    } catch (error) {
      console.warn("[proxy] Could not save proxy sign-ins:", error instanceof Error ? error.message : error)
    }
  }

  /** The proxy refused these credentials; forget them unless another request already replaced them. */
  private refused(key: string, credentials: ProxyCredentials): void {
    const known = this.load()
    if (known.get(key)?.credentials !== credentials) return
    const wasSaved = known.get(key)?.saved === true
    known.delete(key)
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1)
    if (wasSaved) this.writeSaved()
    console.warn(`[proxy] The proxy ${key} did not accept the sign-in`)
    this.options.onChange?.()
  }

  private credentialsFor(key: string, challenge: ProxyChallenge): Promise<ProxyCredentials | null> {
    const known = this.load().get(key)
    if (known) return Promise.resolve(known.credentials)
    const pending = this.prompts.get(key)
    if (pending) return pending
    const now = this.now()
    if ((this.quietUntil.get(key) ?? 0) > now) return Promise.resolve(null)
    const refusals = this.refusals.get(key) ?? 0
    if (refusals >= MAX_PROXY_AUTH_ATTEMPTS) {
      this.refusals.delete(key)
      this.quietUntil.set(key, now + PROXY_PROMPT_QUIET_MS)
      return Promise.resolve(null)
    }
    const prompt = this.options
      .prompt({ proxy: key, scheme: challenge.scheme, realm: challenge.realm, rejected: refusals > 0, persistent: this.options.persist })
      .catch((error: unknown) => {
        console.warn("[proxy] Could not ask for the proxy sign-in:", error instanceof Error ? error.message : error)
        return null
      })
      .then((answer) => {
        this.prompts.delete(key)
        if (!answer || !answer.username) {
          this.quietUntil.set(key, this.now() + PROXY_PROMPT_QUIET_MS)
          return null
        }
        const credentials = { username: answer.username, password: answer.password }
        const saved = answer.remember && this.options.persist
        this.load().set(key, { credentials, saved })
        if (saved) this.writeSaved()
        this.options.onChange?.()
        return credentials
      })
    this.prompts.set(key, prompt)
    return prompt
  }
}

/**
 * The open proxy sign-in prompts, for the renderer: it reads them when it loads and answers by id,
 * so a prompt raised before the window exists, or while it reloads, is not lost.
 */
export class ProxyPrompts {
  private next = 1
  private readonly open = new Map<number, { prompt: ProxySignInPrompt; resolve: (answer: ProxySignInAnswer | null) => void }>()

  constructor(private readonly notify: (prompts: ProxySignInPrompt[]) => void) {}

  ask(request: Omit<ProxySignInPrompt, "id">): Promise<ProxySignInAnswer | null> {
    const prompt = { ...request, id: this.next++ }
    return new Promise((resolve) => {
      this.open.set(prompt.id, { prompt, resolve })
      this.notify(this.pending())
    })
  }

  pending(): ProxySignInPrompt[] {
    return [...this.open.values()].map((entry) => entry.prompt)
  }

  answer(id: unknown, answer: unknown): void {
    const entry = typeof id === "number" ? this.open.get(id) : undefined
    if (!entry) return
    this.open.delete(entry.prompt.id)
    entry.resolve(parseAnswer(answer))
    this.notify(this.pending())
  }
}

/** Answers come from the renderer: anything but a well formed one is a Cancel. */
function parseAnswer(value: unknown): ProxySignInAnswer | null {
  if (!value || typeof value !== "object") return null
  const { username, password, remember } = value as Record<string, unknown>
  if (typeof username !== "string" || typeof password !== "string" || !username.trim()) return null
  if (username.length > 512 || password.length > 1024) return null
  return { username: username.trim(), password, remember: remember !== false }
}
