// A provider response cannot claim that this process authenticated a backup.
const authenticated = new WeakMap<Response, string | undefined>()

export function authenticatedBackupRead(response: Response, keyFingerprint?: string): Response {
  authenticated.set(response, keyFingerprint)
  return response
}

export function wasBackupReadAuthenticated(response: Response): boolean {
  return authenticated.has(response)
}

export function backupReadKeyFingerprint(response: Response): string | undefined {
  return authenticated.get(response)
}
