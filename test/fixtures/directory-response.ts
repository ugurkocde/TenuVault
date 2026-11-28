/** Explicit nulls model selected, unset Graph fields on complete object fixtures. */
export const unsetUserFields = { userPrincipalName: null, mailNickname: null, givenName: null, surname: null, jobTitle: null, department: null, officeLocation: null, usageLocation: null, assignedLicenses: null, onPremisesSyncEnabled: null, onPremisesImmutableId: null, onPremisesLastSyncDateTime: null }
export const unsetGroupFields = { description: null, membershipRule: null, membershipRuleProcessingState: null, onPremisesSyncEnabled: null }

/** A genuine Graph not-found response, distinct from proxy and storage 404s. */
export const graphNotFound = () => Response.json({ error: { code: "Request_ResourceNotFound", message: "Resource not found." } }, { status: 404, headers: { "request-id": "00000000-0000-4000-8000-000000000001" } })
