import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
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
if (process.platform === "win32") execFileSync(process.execPath, [resolve(desktopRoot, "scripts/build-app-backup-helper.mjs")], { stdio: "inherit" })
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
export default defineConfig(({ command, mode }) => {
  const releaseBuild = process.env.TENUVAULT_RELEASE_BUILD === "1"
  const labBuild = command === "build" && mode === "lab-e2e"
  const expandedEntra = labBuild && process.env.TENUVAULT_LAB_EXPANDED_ENTRA === "1"
  const privilegedRestore = expandedEntra && process.env.TENUVAULT_LAB_PRIVILEGED_RESTORE === "1"
  const labInputs = ["TENUVAULT_LAB_EXPANDED_ENTRA", "TENUVAULT_LAB_PRIVILEGED_RESTORE", "TENUVAULT_LAB_LICENSE_ORIGIN", "TENUVAULT_LAB_LICENSE_PUBLIC_KEY", "TENUVAULT_LAB_RUN"] as const
  if ((releaseBuild && labBuild) || (!labBuild && labInputs.some(name => process.env[name] !== undefined))) {
    throw new Error("Lab build options require the dedicated lab build command.")
  }
  const productionOrigin = "https://www.tenuvault.com"
  const labOrigin = labBuild ? new URL(process.env.TENUVAULT_LAB_LICENSE_ORIGIN ?? "http://127.0.0.1:3000") : undefined
  if (labOrigin && (!["http:", "https:"].includes(labOrigin.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(labOrigin.hostname) || labOrigin.href !== labOrigin.origin + "/")) {
    throw new Error("The lab license origin must be a loopback HTTP or HTTPS origin.")
  }
  const run = labBuild ? process.env.TENUVAULT_LAB_RUN ?? "local" : ""
  if (labBuild && !/^[A-Za-z0-9-]{1,40}$/.test(run)) throw new Error("The lab run name must contain 1 to 40 letters, digits or hyphens.")
  // The trial service accepts a prerelease whose numeric version is above its minimum.
  const labVersion = labBuild ? `0.6.0-lab.${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}` : undefined
  const license = {
    // The canonical host. The apex redirects to it, and CIS content requests refuse redirects so the
    // entitlement bearer never follows one, so the apex would break CIS delivery.
    apiBase: labOrigin?.origin ?? process.env.TENUVAULT_LICENSE_API_BASE ?? productionOrigin,
    // CI secrets and env files often carry the PEM with escaped newlines.
    publicKey: ((labBuild ? process.env.TENUVAULT_LAB_LICENSE_PUBLIC_KEY : process.env.TENUVAULT_LICENSE_PUBLIC_KEY) ?? PLACEHOLDER_LICENSE_PUBLIC_KEY).replace(/\\n/g, "\n"),
    buyUrl: process.env.TENUVAULT_LICENSE_BUY_URL ?? "https://tenuvault.com/desktop#pricing",
    portalUrl: process.env.TENUVAULT_LICENSE_PORTAL_URL ?? "https://polar.sh/ugurlabs/portal",
  }
  // The app parses this key at startup, so refuse to build with one that would crash it.
  // Release builds must carry the pinned production key, never the placeholder or a wrong key.
  // The fingerprint is printed so build logs show which verification key an artifact carries.
  if (releaseBuild && license.apiBase !== productionOrigin) throw new Error("Release builds require the production license origin.")
  const licenseKeyFingerprint = checkLicensePublicKey(license.publicKey, releaseBuild)
  console.info(`License public key fingerprint (sha256): ${licenseKeyFingerprint}`)
  // Keys trusted besides it only during a signing key rotation, kept in the repository.
  const rotationKeys = labBuild ? [] : ROTATION_LICENSE_PUBLIC_KEYS
  for (const fingerprint of checkRotationLicensePublicKeys(rotationKeys, license.publicKey)) {
    console.info(`License rotation key fingerprint (sha256): ${fingerprint}`)
  }
  for (const [name, value] of [
    ["TENUVAULT_LICENSE_API_BASE", license.apiBase],
    ["TENUVAULT_LICENSE_BUY_URL", license.buyUrl],
    ["TENUVAULT_LICENSE_PORTAL_URL", license.portalUrl],
  ] as const) {
    if ((labBuild && name === "TENUVAULT_LICENSE_API_BASE")) continue
    if (new URL(value).protocol !== "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(value).origin)) {
      throw new Error(`${name} must be an https URL.`)
    }
  }
  if (license.publicKey === PLACEHOLDER_LICENSE_PUBLIC_KEY) {
    console.warn("Using the placeholder license public key; set TENUVAULT_LICENSE_PUBLIC_KEY.")
  }

  /** Resolves the `~/` import alias used by the portal UI and API code. */
  const webAlias = { find: /^~\//, replacement: `${webSrc}/` }

  return {
    main: {
      plugins: labVersion ? [{
        name: "tenuvault-lab-version",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(labVersion) })
        },
      }] : [],
      resolve: {
        alias: [
          { find: /^next\/server$/, replacement: resolve(desktopRoot, "src/main/api/next-server-shim.ts") },
          { find: /^next\/cache$/, replacement: resolve(desktopRoot, "src/main/api/next-cache-shim.ts") },
          { find: /^next\/headers$/, replacement: resolve(desktopRoot, "src/main/api/next-headers-shim.ts") },
          webAlias,
        ],
      },
      define: {
        __TV_LAB_BUILD__: JSON.stringify(labBuild),
        __TV_LAB_EXPANDED_ENTRA__: JSON.stringify(expandedEntra),
        __TV_LAB_PRIVILEGED_RESTORE__: JSON.stringify(privilegedRestore),
        __TV_LAB_REGISTRATION__: JSON.stringify(labBuild ? `TV06-TEST-${run}-${randomUUID()}` : ""),
        __TENUVAULT_LICENSE_API_BASE__: JSON.stringify(new URL(license.apiBase).origin),
        __TENUVAULT_LICENSE_KEYS_JSON__: JSON.stringify(JSON.stringify([license.publicKey, ...rotationKeys])),
        __TENUVAULT_LICENSE_BUY_URL__: JSON.stringify(license.buyUrl),
        __TENUVAULT_LICENSE_PORTAL_URL__: JSON.stringify(license.portalUrl),
      },
      build: {
        ...(labBuild && { outDir: resolve(desktopRoot, "out-lab/main") }),
        rollupOptions: { input: resolve(desktopRoot, "src/main/index.ts") },
      },
    },
    preload: {
      build: {
        ...(labBuild && { outDir: resolve(desktopRoot, "out-lab/preload") }),
        rollupOptions: {
          input: resolve(desktopRoot, "src/preload/index.ts"),
          // Sandboxed preload scripts must be CommonJS.
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: renderer,
      define: {
        __TV_LAB_BUILD__: JSON.stringify(labBuild),
        __TV_LAB_EXPANDED_ENTRA__: JSON.stringify(expandedEntra),
        __TV_LAB_PRIVILEGED_RESTORE__: JSON.stringify(privilegedRestore),
      },
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
        ...(labBuild && { outDir: resolve(desktopRoot, "out-lab/renderer") }),
        rollupOptions: { input: resolve(renderer, "index.html") },
      },
    },
  }
})
