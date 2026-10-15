import { createPublicKey } from "node:crypto"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import { checkFrameworkRights } from "./scripts/check-framework-rights"

const desktopRoot = import.meta.dirname
checkFrameworkRights(desktopRoot)
const webSrc = resolve(desktopRoot, "src/portal")
const renderer = resolve(desktopRoot, "src/renderer")

/** Production Content Security Policy. Dev builds skip it because Vite injects inline scripts. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

// Licensing endpoints and the token verification key are fixed at build time. The public
// key below is a placeholder whose private half was discarded, so no token verifies against
// it and an unconfigured build cannot license any tenant. Release builds must set
// TENUVAULT_LICENSE_PUBLIC_KEY (see scripts/generate-license-keypair.mjs).
const PLACEHOLDER_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKxXrhBA4x3ybwuC7hkZm8pyRgkM/Zy51UwCGj8EzsF8=
-----END PUBLIC KEY-----`
const license = {
  // The canonical host. The apex redirects to it, and CIS content requests refuse redirects so the
  // entitlement bearer never follows one, so the apex would break CIS delivery.
  apiBase: process.env.TENUVAULT_LICENSE_API_BASE ?? "https://www.tenuvault.com",
  // CI secrets and env files often carry the PEM with escaped newlines.
  publicKey: (process.env.TENUVAULT_LICENSE_PUBLIC_KEY ?? PLACEHOLDER_LICENSE_PUBLIC_KEY).replace(/\\n/g, "\n"),
  buyUrl: process.env.TENUVAULT_LICENSE_BUY_URL ?? "https://tenuvault.com/desktop#pricing",
  portalUrl: process.env.TENUVAULT_LICENSE_PORTAL_URL ?? "https://polar.sh/ugurlabs/portal",
}
// The app parses this key at startup, so refuse to build with one that would crash it.
if (createPublicKey(license.publicKey).asymmetricKeyType !== "ed25519") {
  throw new Error("TENUVAULT_LICENSE_PUBLIC_KEY must be an Ed25519 public key.")
}
for (const [name, value] of [
  ["TENUVAULT_LICENSE_API_BASE", license.apiBase],
  ["TENUVAULT_LICENSE_BUY_URL", license.buyUrl],
  ["TENUVAULT_LICENSE_PORTAL_URL", license.portalUrl],
] as const) {
  if (new URL(value).protocol !== "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(value).origin)) {
    throw new Error(`${name} must be an https URL.`)
  }
}
if (license.publicKey === PLACEHOLDER_LICENSE_PUBLIC_KEY) {
  console.warn("Using the placeholder license public key; set TENUVAULT_LICENSE_PUBLIC_KEY.")
}

/** Resolves the `~/` import alias used by the portal UI and API code. */
const webAlias = { find: /^~\//, replacement: `${webSrc}/` }

export default defineConfig({
  main: {
    resolve: {
      alias: [
        { find: /^next\/server$/, replacement: resolve(desktopRoot, "src/main/api/next-server-shim.ts") },
        { find: /^next\/cache$/, replacement: resolve(desktopRoot, "src/main/api/next-cache-shim.ts") },
        { find: /^next\/headers$/, replacement: resolve(desktopRoot, "src/main/api/next-headers-shim.ts") },
        webAlias,
      ],
    },
    define: {
      __TENUVAULT_LICENSE_API_BASE__: JSON.stringify(new URL(license.apiBase).origin),
      __TENUVAULT_LICENSE_PUBLIC_KEY__: JSON.stringify(license.publicKey),
      __TENUVAULT_LICENSE_BUY_URL__: JSON.stringify(license.buyUrl),
      __TENUVAULT_LICENSE_PORTAL_URL__: JSON.stringify(license.portalUrl),
    },
    build: {
      rollupOptions: { input: resolve(desktopRoot, "src/main/index.ts") },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/preload/index.ts"),
        // Sandboxed preload scripts must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: renderer,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "tenuvault-csp",
        apply: "build",
        transformIndexHtml: (html) =>
          html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
      },
    ],
    resolve: {
      alias: [
        // Next.js APIs used by the shared portal pages, mapped onto React Router.
        { find: /^next\/link$/, replacement: resolve(renderer, "shims/next-link.tsx") },
        { find: /^next\/navigation$/, replacement: resolve(renderer, "shims/next-navigation.ts") },
        // Desktop replacements for web modules that handle credentials or storage.
        {
          find: /^~\/components\/tenants\/add-tenant-modal(-redesigned)?$/,
          replacement: resolve(renderer, "overrides/add-tenant-modal.tsx"),
        },
        { find: /^~\/lib\/tenant-storage$/, replacement: resolve(renderer, "overrides/tenant-storage.ts") },
        // Desktop components used inside portal pages.
        { find: /^@desktop\//, replacement: `${renderer}/` },
        webAlias,
      ],
    },
    build: {
      rollupOptions: { input: resolve(renderer, "index.html") },
    },
  },
})
