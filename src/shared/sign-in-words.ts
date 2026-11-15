/**
 * The Entra roles that can run the setup: each can both create the app registration and grant
 * tenant-wide admin consent for delegated permissions. A Privileged Role Administrator can grant
 * the consent, but creates an app registration only where every user may, so it is not listed.
 */
export const CONSENT_ROLES = ["Global Administrator", "Cloud Application Administrator", "Application Administrator"] as const
/** The roles in a sentence: "A, B or C". */
export const CONSENT_ROLES_TEXT = `${CONSENT_ROLES.slice(0, -1).join(", ")} or ${CONSENT_ROLES.at(-1)}`

/**
 * The route that works when the tenant blocks Microsoft Graph Command Line Tools, which the setup
 * and the setup script both sign in through. Setup errors that need it say these words, and the
 * Connect step then offers the manual guide next to the error.
 */
export const CREATE_BY_HAND = "create the app registration by hand"
