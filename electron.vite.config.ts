import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import { checkFrameworkRights } from "./scripts/check-framework-rights"
import {
  PLACEHOLDER_LICENSE_PUBLIC_KEY,
  ROTATION_LICENSE_PUBLIC_KEYS,
  checkLicensePublicKey,
  checkRotationLicensePublicKeys,
} from "./scripts/license-public-key"

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

// Licensing endpoints and the token verification key are fixed at build time. Unconfigured
// builds fall back to the placeholder key from scripts/license-public-key.ts, whose private
// half was discarded, so they cannot license any tenant. Release builds set
// TENUVAULT_RELEASE_BUILD=1 and must carry the pinned production key.
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
// Release builds must carry the pinned production key, never the placeholder or a wrong key.
// The fingerprint is printed so build logs show which verification key an artifact carries.
const licenseKeyFingerprint = checkLicensePublicKey(license.publicKey, process.env.TENUVAULT_RELEASE_BUILD === "1")
console.info(`License public key fingerprint (sha256): ${licenseKeyFingerprint}`)
// Keys trusted besides it only during a signing key rotation, kept in the repository.
for (const fingerprint of checkRotationLicensePublicKeys(ROTATION_LICENSE_PUBLIC_KEYS, license.publicKey)) {
  console.info(`License rotation key fingerprint (sha256): ${fingerprint}`)
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
      __TENUVAULT_LICENSE_ROTATION_KEYS__: JSON.stringify(ROTATION_LICENSE_PUBLIC_KEYS),
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
