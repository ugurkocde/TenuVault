// The no-card Pro trial: the licensing service emails a 30 day trial key to the address.
// The key is never returned here, so the address has to be the admin's own.

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

export async function requestTrialKey(
  apiBase: string,
  email: unknown,
  source: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const address = typeof email === "string" ? email.trim() : ""
  if (address.length > 254 || !EMAIL.test(address)) throw new Error("Enter a valid email address.")
  const body: Record<string, string> = { email: address }
  if (typeof source === "string" && /^[a-z0-9-]{1,40}$/.test(source)) body.source = `app-${source}`
  let response: Response
  try {
    response = await fetchImpl(`${apiBase}/api/desktop-trial`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    })
  } catch {
    throw new Error("The TenuVault service could not be reached. Check your internet connection and try again.")
  }
  const data = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null
  if (response.ok && data?.ok === true) return
  const message = typeof data?.error === "string" ? data.error.slice(0, 300) : null
  throw new Error(message ?? "The trial could not be started. Try again, or email support@tenuvault.com.")
}
