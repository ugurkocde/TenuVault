// A provider response cannot claim that this process authenticated a backup.
const authenticated = new WeakSet<Response>()

export function authenticatedBackupRead(response: Response): Response {
  authenticated.add(response)
  return response
}

export function wasBackupReadAuthenticated(response: Response): boolean {
  return authenticated.has(response)
}
