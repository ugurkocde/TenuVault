import { MODULES, type ServiceSelection } from "../../shared/services/modules"

/**
 * Proves that an account can read a service the tenant backs up, with that service's one small
 * read. The check follows the tenant's services, so a tenant without Intune is not asked for Intune
 * access: the first service that is on and has such a read decides. A tenant with no such service
 * is refused, because nothing could show that the account manages it.
 *
 * `read` makes the request for a Microsoft Graph beta path with the account's token.
 */
export async function requireServiceAccess(selection: ServiceSelection, read: (path: string) => Promise<Response>, what: string): Promise<void> {
  const module = MODULES.find((candidate) => candidate.accessProbe && selection.services.includes(candidate.id))
  if (!module?.accessProbe) throw new Error(`Turn on a service for this tenant in Settings before opening ${what}.`)
  const response = await read(module.accessProbe)
  if (!response.ok || !Array.isArray((await response.json()).value)) throw new Error(`${module.label} management access is required for ${what}.`)
}
