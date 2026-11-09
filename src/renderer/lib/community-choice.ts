const OPEN_EVENT = "tenuvault:choose-community-tenant"

export function openCommunityTenantPicker() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function subscribeCommunityTenantPicker(open: () => void): () => void {
  window.addEventListener(OPEN_EVENT, open)
  return () => window.removeEventListener(OPEN_EVENT, open)
}
