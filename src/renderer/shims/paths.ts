const WEBSITE = "https://tenuvault.com"

export type HrefTarget = { kind: "internal"; path: string } | { kind: "external"; url: string }

/**
 * Decides where a link from the portal pages goes. Portal and license routes stay in the app;
 * other paths open on tenuvault.com in the browser.
 */
export function resolveHref(href: string): HrefTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "external", url: href }
  if (href === "/" || href === "/portal" || href === "/portal/") return { kind: "internal", path: "/portal/dashboard" }
  if (/^\/(portal|license)(\/|[?#]|$)/.test(href)) return { kind: "internal", path: href }
  if (href.startsWith("/")) return { kind: "external", url: WEBSITE + href }
  return { kind: "internal", path: href }
}

export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener")
}
