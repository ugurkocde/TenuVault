/**
 * "Alert me about this policy": opens the Alerts page with a new alert for one policy,
 * prefilled to send each of its changes. Conditional Access objects get a Conditional Access
 * alert; everything else an Intune one. `type` is a backup folder or a Graph type name.
 */
export function alertForPolicyHref(name: string, type: string | null | undefined): string {
  // Folders ("ConditionalAccessPolicies") and display labels ("Named locations") alike.
  const service = /conditional\s*access|named\s*location|authentication\s*strength/i.test(type ?? "") ? "conditionalAccess" : "intune"
  return `/portal/alerts/alerts?${new URLSearchParams({ alertFor: name.slice(0, 200), service }).toString()}`
}
