import { CommunityLimitError, withPlanError } from "../shared/plan-errors"
import { licenseBuyUrl } from "./license/buy-url"
import { importConfirmedArchive, reviewArchive } from "./backup/archive"
import { readFile, stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { isGuid, isMicrosoftLoginUrl, sameRendererDocument } from "../shared/security"
import { rendererStorageKey, rendererStorageValue } from "./renderer-storage"
import { prepareGeneratedFile, prepareSaveFile, type PreparedFile } from "./save-file"
import { PdfBrandingPolicy, PdfBrandingStore, setPdfBrandingPolicy } from "./pdf-branding"
import { prepareOibReportFile, printHtmlToPdf } from "./report-export"
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, safeStorage, shell } from "electron"
import { basename, join } from "node:path"
import type { ApiRequest, AppPreferences, ScheduleInput } from "../shared/ipc"
import { DELEGATED_CLIENT_SECRET, INTERNAL_API_ORIGIN } from "../shared/constants"
import { createAuditRecorder } from "./api/audit"
import { setAuditOutboxStore } from "../portal/lib/audit/outbox"
import { backupRoutes, surfaceTokenErrors } from "./api/desktop-routes"
import { createBridgedFetch } from "./api/fetch-bridge"
import { withNetworkErrors } from "./api/network-error"
import { ApiHost } from "./api/host"
import { routes } from "./api/routes"
import { AuthManager, SignInRequiredError } from "./auth/msal"
import { BackupEngine, verifyStorageAccess, type BackupJob } from "./backup/engine"
import { BackupScheduler, reportsResult, runUnattended, scheduledResult } from "./backup/scheduler"
import { runTrayBackups } from "./backup/tray-backup"
import { prepareScheduleInput } from "./backup/schedule-input"
import { BackgroundLaunch } from "./backup/background-launch"
import { BackupScopes } from "./backup/scopes"
import { includedTypes, normalizeScope, type BackupScope } from "../shared/intune/scope"
import { RefusalLog, refuseUnlicensedBackup } from "./backup/refusals"
import { FailedAttemptLog, recordPlanRefusal } from "./backup/failed-attempts"
import { backupTenantLabel, notifyBackupFailure } from "./backup/notifications"
import { BackupKeys } from "./backup/keys"
import { readBackupSettings } from "./backup/settings"
import { localInventoryProblem } from "./backup/local-inventory"
import { encryptedAzureFetch, registerStorageToken } from "./storage/azure-seal"
import { BackupReaderService } from "./auth/backup-reader"
// The same setup script the docs site downloads and the card copies, bundled so Save writes it exactly.
import readerSetupScript from "../../resources/New-TenuVaultBackupReader.ps1?raw"
import { assertStorageAccountName } from "../shared/storage-account"
import { hostname } from "node:os"
import { handleLocalBlobRequest, isLocalAccount, localRoutesRunning } from "./storage/blob-emulator"
import { LocalBlobStore } from "./storage/local-blob-store"
import { setRestoreJournalStore, setRestoreJournalAuthorization } from "./storage/restore-journal"
import { accountStore, secureCachePlugin } from "./auth/stores"
import {
  LICENSE_API_BASE,
  LICENSE_BUY_URL,
  LICENSE_PORTAL_URL,
  LICENSE_PUBLIC_KEY,
  LICENSE_REFRESH_MS,
} from "./license/config"
import { LicenseService } from "./license/service"
import { planGuard } from "./api/plan-gates"
import { cisInternalGuard } from "./api/cis-gate"
import { DisclaimerAcknowledgements, disclaimerGuard } from "./disclaimer"
import { migrateLegacyOibRuns, setOibStore } from "./oib/service"
import { setOibCacheDir } from "./oib/source"
import { setFrameworkStore } from "./frameworks/workspaces"
import { internalCisBenchmarksEnabled, isAdmittedAssessStatus, setCisEntitlementProvider, setFrameworkExportSaver, setInternalCisBenchmarksProvider } from "./frameworks/service"
import { setCisContentFallbackBaseUrl } from "./frameworks/cis-content"
import { setNativeFrameworkStore, setNativeFrameworkAuthorization, setNativeFrameworkNotifier } from "./frameworks/native"
import { allows, effectiveRetentionDays, PlanRequired } from "../shared/plans"
import { APP_STATE_START_OVER_BUTTON, APP_STATE_START_OVER_DETAIL, SecureStore, UnreadableStoreError, type Cipher } from "./storage/secure-store"
import { Preferences } from "./preferences"
import { AppTray } from "./tray"
import { installedBySetup, isNightly, Updates, updatesDisabledByPolicy } from "./updates"
import { featureRoutes, startFeatures } from "./features"
import { emitBackupOutcome, emitDriftOutcome, emitRestoreOutcome } from "./features/notifications/producers"
import { apiBody, type FeatureDeps } from "./features/deps"
import { TenantRecords } from "./features/records"
import { DriftJobs, driftScanRoutes } from "./drift/jobs"
import { graphCaller } from "../portal/lib/policies/graph-restore"

const RENDERER_STORAGE_PREFIX = "renderer."
const LOCAL_FOLDER_KEY = "backup.localFolder"

// A second instance would share the encrypted stores and overwrite the first one's changes.
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.exit(0)

// Route code that calls its own API (audit logging) builds URLs from this origin.
process.env.NEXT_PUBLIC_APP_URL = INTERNAL_API_ORIGIN

let mainWindow: BrowserWindow | null = null
/** Set when the app should really exit instead of hiding in the tray. */
let quitting = false
/** Started by the operating system at login: stay in the tray until opened. */
const startedHidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin

function canEncrypt(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
}

function osCipher(): Cipher {
  if (canEncrypt()) {
    return {
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }
  }
  if (app.isPackaged) {
    throw new Error("OS encryption is not available. Enable the operating system credential store before opening TenuVault.")
  }
  console.warn("[storage] OS encryption unavailable, storing data unencrypted (development only).")
  return { encrypt: (text) => Buffer.from(text, "utf8"), decrypt: (data) => data.toString("utf8") }
}

/**
 * Opens an encrypted store. If it cannot be decrypted (for example the Keychain prompt
 * was denied), the user chooses between quitting, so nothing is lost, and starting over.
 * `startOver` says what starting over means for this store; the default fits the stores
 * that hold sign-ins and the license.
 */
function openStore(filePath: string, cipher: Cipher, startOver = "your saved data is kept as a backup, and you sign in to your tenants and activate your license again.", startOverButton = "Start over"): SecureStore | null {
  const store = new SecureStore(filePath, cipher)
  try {
    store.open()
    return store
  } catch (error) {
    if (!(error instanceof UnreadableStoreError)) throw error
    console.error("[storage]", error)
    const choice = dialog.showMessageBoxSync({
      type: "error",
      title: "TenuVault",
      message: "TenuVault cannot unlock its saved data.",
      detail:
        process.platform === "darwin"
          ? `Allow TenuVault to access its Keychain item and start the app again. If that does not help, start over: ${startOver}`
          : `The data may have been created by another Windows user. Start the app as that user, or start over: ${startOver}`,
      buttons: ["Quit", startOverButton],
      defaultId: 0,
      cancelId: 0,
    })
    if (choice !== 1) return null
    console.warn(`[storage] Moved unreadable store to ${store.moveAside()}`)
    return store
  }
}

/**
 * Requests to Microsoft, Azure and licensing use Chromium's network stack, which follows the
 * system proxy (including PAC) and certificate store. Node's fetch uses neither, so behind a
 * corporate proxy or HTTPS inspection it fails with "fetch failed".
 */
const chromiumFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init)

async function bootstrap(): Promise<void> {
  const cipher = osCipher()
  const userData = app.getPath("userData")
  const appStore = openStore(join(userData, "app-state.bin"), cipher, APP_STATE_START_OVER_DETAIL, APP_STATE_START_OVER_BUTTON)
  const tokenStore = appStore && openStore(join(userData, "token-cache.bin"), cipher)
  // Records of the review, evidence and change workflows, kept apart so the app state stays small.
  const workspaceStore = tokenStore && openStore(join(userData, "workspace.bin"), cipher, "your saved review records (baselines, promotions and health reviews) are kept as a backup copy and start empty. Tenant access and your license are not affected.")
  // Drift results are large and rewritten on every scan, so they do not share a file with the records.
  const driftStore = workspaceStore && canEncrypt() ? openStore(join(userData, "drift-results.bin"), cipher, "saved drift results are kept as a backup copy and start empty; the next drift scan saves new ones. Tenant access and your license are not affected.") : undefined
  if (!appStore || !tokenStore || !workspaceStore || driftStore === null) {
    app.quit()
    return
  }

  const accounts = accountStore(appStore)
  const auth = new AuthManager({
    cachePlugin: (clientId) => secureCachePlugin(tokenStore, clientId),
    openBrowser: (url) => {
      if (!isMicrosoftLoginUrl(url)) {
        console.warn("[auth] Refused to open a sign-in URL that is not on the Microsoft login host.")
        return Promise.resolve()
      }
      return shell.openExternal(url)
    },
    accountStore: accounts,
  })

  // Every tenant is licensed on its own: its first use activates it with the licensing
  // service (see license/service.ts), later uses verify the cached token offline.
  const signedInTenants = () => auth.accounts().map((account) => account.tenantId)
  const pushLicense = () => mainWindow?.webContents.send("license:changed", license.status(signedInTenants()))
  const license = new LicenseService({
    store: appStore,
    // Without OS encryption the key is kept in memory only, never written in plaintext.
    persist: canEncrypt(),
    publicKey: LICENSE_PUBLIC_KEY,
    apiBase: LICENSE_API_BASE,
    appVersion: app.getVersion(),
    // The ID token proves the tenant for organization license sharing; its audience is
    // the app registration the tenant is signed in with.
    idToken: (tenantId) => auth.getIdToken(tenantId),
    clientId: (tenantId) => accounts.get(tenantId)?.clientId ?? null,
    // Keep licensing outside the local API/storage bridge below.
    fetch: chromiumFetch,
    onChange: pushLicense,
  })
  const refreshLicenses = () => license.refreshAll().catch((error: unknown) => console.warn("[license]", error))
  setInterval(() => void refreshLicenses(), LICENSE_REFRESH_MS)

  // Backups kept on this device: encrypted blob storage in a folder the admin chooses.
  const backupKeys = new BackupKeys(appStore)
  setRestoreJournalStore(appStore)
  const localFolder = () => appStore.get(LOCAL_FOLDER_KEY) ?? join(app.getPath("documents"), "TenuVault Backups")
  let localStore: LocalBlobStore | null = null
  const getLocalStore = () => (localStore ??= new LocalBlobStore(localFolder(), backupKeys.keyring()))
  // The unreadable-backups warning reads inventories through its own store, so a check never shares
  // an index rebuild with a running backup or retention. Stores already coordinate through the folder.
  let checkStore: LocalBlobStore | null = null
  const getCheckStore = () => (checkStore ??= new LocalBlobStore(localFolder(), backupKeys.keyring()))
  const backupSettings = () => readBackupSettings(localFolder(), backupKeys, appStore)

  // Background requests never open a sign-in window; the renderer shows a prompt instead.
  const lastPrompt = new Map<string, number>()
  const tokenFor = async (tenantId: string, clientId: string, scope: string, forceRefresh = false) => {
    try {
      const token = await auth.getAccessToken(tenantId, clientId, scope, forceRefresh)
      if (scope.includes("storage.azure.com")) registerStorageToken(token.accessToken, tenantId)
      return token
    } catch (error) {
      if (error instanceof SignInRequiredError) {
        const key = tenantId.toLowerCase()
        if (Date.now() - (lastPrompt.get(key) ?? 0) > 3000) {
          lastPrompt.set(key, Date.now())
          mainWindow?.webContents.send("auth:signInRequired", { tenantId, clientId, message: error.message, scope: error.scope })
        }
      }
      throw error
    }
  }

  const bridgedFetch = createBridgedFetch({
    dispatch: (request) => host.dispatch(request),
    fetch: encryptedAzureFetch(withNetworkErrors(chromiumFetch), () => backupKeys.keyring(), () => {
      if (appStore.get("backup.recovery-exported") !== backupKeys.fingerprint()) throw new Error("Save your current backup recovery key in Settings before the first encrypted Azure backup.")
    }),
    authorizeTenant: (tenant) => license.requireEntitlement(tenant),
    handleLocalBlob: (request) => handleLocalBlobRequest(getLocalStore(), request),
    getDelegatedToken: async (tenant, clientId, scope, forceRefresh) => {
      const result = await tokenFor(tenant, clientId, scope, forceRefresh)
      return { accessToken: result.accessToken, expiresOn: result.expiresOn }
    },
  })
  globalThis.fetch = bridgedFetch
  setNativeFrameworkAuthorization(async tenantId => {
    if (!accounts.get(tenantId)) throw new Error("Sign in to this tenant before opening framework history.")
    return license.requireEntitlement(tenantId)
  })
  setRestoreJournalAuthorization(async (tenantId) => {
    const account = accounts.get(tenantId)
    if (!account) throw new Error("Sign in to this tenant before opening restore history.")
    await license.requireEntitlement(tenantId)
    const token = await tokenFor(tenantId, account.clientId, "https://graph.microsoft.com/.default", true)
    const response = await bridgedFetch("https://graph.microsoft.com/beta/deviceManagement/deviceCategories?$top=1&$select=id", {
      headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok || !Array.isArray((await response.json()).value)) throw new Error("Intune management access is required for this tenant's restore history.")
  })

  // Every PDF export resolves branding per tenant here: saved branding applies only on a plan with pdfBranding.
  const pdfBranding = new PdfBrandingPolicy(
    new PdfBrandingStore(appStore, (bytes) => nativeImage.createFromBuffer(bytes)),
    (tenantId) => license.requireEntitlement(tenantId),
    () => license.status(signedInTenants()).tenants.map((tenant) => (tenant.entitled ? tenant.plan : null)),
  )
  setPdfBrandingPolicy(pdfBranding)

  // Nightly builds keep following nightlies until the admin switches back to stable.
  const preferences = new Preferences(appStore, { nightlyUpdates: isNightly(app.getVersion()) })
  // OpenIntuneBaseline runs keep the IDs they created and what they replaced, so they can be undone after a restart.
  if (canEncrypt()) setFrameworkStore(appStore)
  if (canEncrypt()) setNativeFrameworkStore(appStore)
  // Quick Start runs from earlier versions move into the OpenIntuneBaseline history, so they stay undoable.
  migrateLegacyOibRuns(appStore)
  setOibStore(appStore)
  // Public OpenIntuneBaseline content by commit, so packs are downloaded once rather than every session.
  setOibCacheDir(join(userData, "oib-cache"))
  setAuditOutboxStore(canEncrypt() ? appStore : undefined)
  // Roadmap workflow records.
  const records = new TenantRecords(workspaceStore)
  // Backups that failed before saving anything, counted on the Dashboard on every plan.
  const failedAttempts = new FailedAttemptLog(appStore)
  // The Backup Reader's tokens reach only the backup engine: never the fetch bridge, tokenFor or a
  // portal route, so no restore, revert or other change can ever run with them.
  const backupReader = new BackupReaderService(tokenStore)
  const engine = new BackupEngine({
    fetch: bridgedFetch,
    getToken: async (tenantId, clientId, scope) => {
      await license.requireEntitlement(tenantId)
      return (await tokenFor(tenantId, clientId, scope)).accessToken
    },
    unattendedTokens: (request) => {
      const plan = license.plan(request.tenantId)
      if (!plan || !allows(plan, "backupReader")) return null
      const reader = backupReader.tokens(request)
      if (!reader) return null
      return {
        ...reader,
        graph: async () => {
          await license.requireEntitlement(request.tenantId)
          return reader.graph()
        },
        storage: async () => {
          await license.requireEntitlement(request.tenantId)
          const token = await reader.storage()
          // The encrypted Azure fetch only seals requests for tenants with a registered storage token.
          registerStorageToken(token, request.tenantId)
          return token
        },
      }
    },
    // Community keeps 30 days of history; Pro and MSP keep what the admin chooses (0 keeps everything).
    retentionDays: (tenantId) => effectiveRetentionDays(preferences.get().retentionDays, license.plan(tenantId)),
    onFinished: (job, request) => {
      failedAttempts.finished(job, request)
      // Manual backup outcomes notify here; scheduled and tray outcomes notify from the
      // scheduler path, which already suppresses repeated unreachable failures.
      if ((request.trigger ?? "manual") !== "manual") return
      void notifyBackupOutcome(job, "manual")
    },
  })

  const scopes = new BackupScopes(appStore)
  const graphScope = "https://graph.microsoft.com/.default"
  const signedInClient = (tenantId: string) => {
    const account = accounts.get(tenantId)
    if (!account) throw new Error("Sign in to this tenant first.")
    return account.clientId
  }
  const featureDeps: FeatureDeps = {
    records,
    plan: (tenantId) => license.requireEntitlement(tenantId),
    sameLicense: (a, b) => {
      const tenants = license.status([]).tenants
      const first = tenants.find((t) => t.tenantId === a.toLowerCase())
      const second = tenants.find((t) => t.tenantId === b.toLowerCase())
      if (!first?.entitled || !second?.entitled || first.source !== second.source) return false
      return first.source === "key" || (first.displayKey !== null && first.displayKey === second.displayKey)
    },
    tenant: (tenantId) => {
      const profile = tenantProfile(tenantId)
      return profile ? { tenantId: tenantId.toLowerCase(), ...profile } : null
    },
    tenants: () => connectedTenantIds(),
    actor: (tenantId) => {
      const account = accounts.get(tenantId)
      return account ? { id: account.username, name: account.name || account.username } : null
    },
    graph: async (tenantId, options = {}) => {
      await license.requireEntitlement(tenantId)
      const clientId = signedInClient(tenantId)
      const token = await tokenFor(tenantId, clientId, graphScope)
      return graphCaller(token.accessToken, bridgedFetch, {
        tenant: options.journal ? tenantId.toLowerCase() : undefined,
        refreshToken: async () => (await tokenFor(tenantId, clientId, graphScope, true)).accessToken,
      })
    },
    api: (path, tenantId, body = {}) => {
      const profile = tenantProfile(tenantId)
      if (!profile) return Promise.resolve(Response.json({ error: "This tenant is no longer connected." }, { status: 404 }))
      return host.dispatch(new Request(`${INTERNAL_API_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiBody(tenantId, profile, body)),
      }))
    },
    // Outside the bridge: only customer-configured endpoints use it.
    externalFetch: withNetworkErrors(chromiumFetch),
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    },
    now: () => new Date(),
  }
  // Every change to a tenant waits until the admin accepted the disclaimer for that tenant.
  const disclaimer = new DisclaimerAcknowledgements(appStore)
  const checkDisclaimer = disclaimerGuard(disclaimer)
  setInternalCisBenchmarksProvider(() => license.cisInternal())
  setCisEntitlementProvider((tenantId) => license.entitlementToken(tenantId))
  // Framework exports the main process built are saved here directly, so they never round-trip through the renderer.
  setFrameworkExportSaver((file) => saveFileWithDialog(prepareGeneratedFile(file.data, file.name, file.encoding)))
  setCisContentFallbackBaseUrl(LICENSE_API_BASE)
  const checkCis = cisInternalGuard(() => internalCisBenchmarksEnabled(), (tenantId) => license.entitlementToken(tenantId))
  const planGate = planGuard((tenantId) => license.requireEntitlement(tenantId).catch(() => null))
  // Progress polls of an assessment the plan guard admitted at start read only that job, bound to
  // its tenant, so they do not stall behind a slow license refresh.
  const checkPlan = async (request: Request) => (await isAdmittedAssessStatus(request)) ? null : planGate(request)
  // Drift scans run in the background; each tenant's last result is kept in its own store, or in
  // memory for the session without OS encryption.
  const memoryResults = new Map<string, string>()
  // Earlier builds of this branch kept the results with the workflow records.
  for (const key of workspaceStore.keys()) if (key.startsWith("drift.result.")) workspaceStore.delete(key)
  const driftJobs = new DriftJobs({
    api: featureDeps.api,
    tenant: featureDeps.tenant,
    plan: featureDeps.plan,
    store: driftStore ?? { get: (key) => memoryResults.get(key) ?? null, set: (key, value) => void memoryResults.set(key, value), delete: (key) => void memoryResults.delete(key) },
    // When the window is not in front, a system notification says the scan finished; the app itself shows a toast.
    notify: (job) => {
      void (async () => {
        let localNotified = false
        if (job.status === "completed" && job.summary) {
          const saved = driftJobs.result(job.tenantId)
          const items = saved && saved.jobId === job.jobId
            ? saved.drifts.slice(0, 20).map((drift) => ({ title: `${drift.changeType}: ${drift.configName}`, detail: drift.type }))
            : undefined
          const result = await emitDriftOutcome(featureDeps, job.tenantId, {
            jobId: job.jobId,
            finishedAt: job.finishedAt ?? new Date().toISOString(),
            added: job.summary.added,
            modified: job.summary.modified,
            deleted: job.summary.deleted,
            items,
          }).catch(() => ({ created: 0, localCreated: false }))
          localNotified = result.localCreated
        }
        if (job.status === "cancelled" || mainWindow?.isFocused() || !Notification.isSupported()) return
        if (localNotified) return
        const tenant = tenantProfile(job.tenantId)?.name ?? "your tenant"
        const notification = new Notification({
          title: job.status === "completed" ? "Drift scan ready" : "Drift scan failed",
          body: job.status === "completed" ? `The backups of ${tenant} were compared. Click to review the drift.` : job.error ?? "Open TenuVault for details.",
        })
        notification.on("click", () => {
          showWindow()
          void mainWindow?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`/portal/drift?tenant=${job.tenantId}`)}`)
        })
        notification.show()
      })()
    },
  })
  const host: ApiHost = new ApiHost({
    routes: { ...routes, ...backupRoutes(engine, (tenantId) => scopes.get(tenantId).scope), ...featureRoutes(featureDeps), ...driftScanRoutes(driftJobs) },
    transform: surfaceTokenErrors,
    // Disabled CIS routes refuse before any licensing work. The plan comes next, so the
    // disclaimer is never accepted for a change the plan refuses anyway.
    guard: async (request) => (await checkCis(request)) ?? (await recordPlanRefusal(failedAttempts, request, await checkPlan(request))) ?? checkDisclaimer(request),
    onHandled: createAuditRecorder((request) => host.dispatch(request), (tenantId) => accounts.get(tenantId), (notice) => {
      void emitRestoreOutcome(featureDeps, notice.tenantId, {
        status: notice.status,
        jobId: notice.jobId,
        finishedAt: new Date().toISOString(),
        restored: notice.restored,
        failed: notice.failed,
        partial: notice.partial,
        message: notice.message,
      }).catch(() => undefined)
    }),
  })

  // Tenant profiles are kept by the renderer; scheduled backups read them from the store.
  const tenantProfile = (tenantId: string) => {
    try {
      const tenants = JSON.parse(appStore.get(`${RENDERER_STORAGE_PREFIX}tenuvault_tenants`) ?? "[]") as Array<{
        name?: string
        domain?: string
        credentials?: { tenantId?: string; appId?: string }
        resources?: { storageAccountName?: string }
      }>
      const tenant = tenants.find((t) => t.credentials?.tenantId?.toLowerCase() === tenantId.toLowerCase())
      if (!tenant?.credentials?.appId || !tenant.resources?.storageAccountName) return null
      return { name: backupTenantLabel(tenant), clientId: tenant.credentials.appId, storageAccountName: tenant.resources.storageAccountName }
    } catch {
      return null
    }
  }

  const connectedTenantIds = () => {
    try {
      const tenants = JSON.parse(appStore.get(`${RENDERER_STORAGE_PREFIX}tenuvault_tenants`) ?? "[]") as Array<{
        credentials?: { tenantId?: string }
      }>
      return tenants.map((t) => t.credentials?.tenantId).filter((id): id is string => Boolean(id))
    } catch {
      return []
    }
  }

  // Tenants connected by an older version, or whose license check never completed, are
  // checked once at start when their sign-in is available. The others are checked at
  // their next sign-in; until then the overview says the license is checked at first use.
  const checkUncheckedTenants = async () => {
    const signedIn = new Set(signedInTenants().map((id) => id.toLowerCase()))
    const activated = new Set(license.status([]).tenants.filter((t) => t.activated).map((t) => t.tenantId))
    const unchecked = connectedTenantIds()
      .map((id) => id.toLowerCase())
      .filter((id) => signedIn.has(id) && !activated.has(id))
    await license.retry([...new Set(unchecked)])
    pushLicense()
  }
  void refreshLicenses().then(checkUncheckedTenants)

  const waitForJob = (job: BackupJob) => engine.waitForJob(job)

  // A framework comparison runs in the background. When the window is not in front, a system
  // notification says it finished; the app itself shows a toast. Clicking opens the result.
  setNativeFrameworkNotifier((job) => {
    if (job.status === "cancelled" || mainWindow?.isFocused() || !Notification.isSupported()) return
    const tenant = tenantProfile(job.tenantId)?.name ?? "your tenant"
    const notification = new Notification({
      title: job.status === "completed" ? `${job.frameworkName} comparison ready` : `${job.frameworkName} comparison failed`,
      body: job.status === "completed" ? `The settings of ${tenant} were compared. Click to review the results.` : job.error ?? "Open TenuVault for details.",
    })
    notification.on("click", () => {
      showWindow()
      void mainWindow?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`/portal/frameworks/${job.frameworkId}?tenant=${job.tenantId}`)}`)
    })
    notification.show()
  })

  const notifyFailure = (tenantId: string, name: string, message: string, trigger: "scheduled" | "tray") => {
    notifyBackupFailure({ tenantId, name }, message, trigger, () => {
      showWindow()
      return mainWindow
    })
  }

  const refusals = new RefusalLog(appStore, () => mainWindow?.webContents.send("schedules:refusalsChanged"))

  // Joined requests share one notification and the trigger that started the job.
  const unattendedBackupTriggers = new WeakMap<BackupJob, { trigger: "scheduled" | "tray"; notified: boolean }>()

  // Best-effort notification event for one finished backup job, with fixed summary text
  // only. Resolves true when a local channel intent was queued for this outcome.
  const notifyBackupOutcome = async (job: BackupJob, trigger: string): Promise<boolean> => {
    if (job.status === "Cancelled") return false
    const result = await emitBackupOutcome(featureDeps, job.tenantId, {
      status: job.status === "Failed" ? "Failed" : job.failures || /completed with \d+ warnings?/i.test(job.progressMessage) ? "CompletedWithWarnings" : "Success",
      backupFolder: job.backupFolder ?? `job:${job.id}`,
      finishedAt: job.endTime ?? new Date().toISOString(),
      failures: job.failures ?? 0,
      trigger,
      message: null,
    }).catch(() => ({ created: 0, localCreated: false }))
    return result.localCreated
  }

  // An expiring Backup Reader certificate is easy to miss when nobody opens TenuVault, so scheduled
  // runs remind once a week from 30 days before expiry. After it, backups use the admin's sign-in again.
  const remindBackupReaderRenewal = (tenantId: string, name: string) => {
    const reader = backupReader.status(tenantId)
    if (reader?.state !== "verified") return
    const daysLeft = Math.ceil((Date.parse(reader.notAfter) - Date.now()) / 86_400_000)
    const key = `backupReader.reminded.${tenantId.toLowerCase()}`
    if (daysLeft > 30 || Date.now() - Number(appStore.get(key) ?? 0) < 7 * 86_400_000) return
    appStore.set(key, String(Date.now()))
    if (Notification.isSupported()) {
      new Notification({
        title: `Backup Reader certificate of ${name} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        body: reader.renewalPending
          ? "A renewal certificate is waiting: upload it with the setup script, then verify it in Settings > Background runner."
          : "Renew it in Settings > Background runner so scheduled backups keep running without your sign-in.",
      }).show()
    }
  }

  const runScheduledBackup = async (tenantId: string, trigger: "scheduled" | "tray", afterFailure = false, slot?: string) => {
    const profile = tenantProfile(tenantId)
    if (!profile) {
      const message = "This tenant is no longer connected."
      failedAttempts.record({ tenantId, trigger, slot, message })
      return { status: "Failed" as const, message }
    }
    // A tenant the license does not cover is not backed up. Its audit log lives in the
    // tenant's own storage, which is closed without a license too, so the refusal is
    // recorded in the refusal log on this device, notified and shown on the schedule.
    // The plan must also include how the backup runs: daily schedules and Azure storage are paid.
    const daily = trigger === "scheduled" && scheduler.list().some((s) => s.tenantId.toLowerCase() === tenantId.toLowerCase() && s.frequency === "daily")
    const requirePlan = async (id: string) => {
      const plan = await license.requireEntitlement(id)
      if (daily && !allows(plan, "dailySchedule")) throw new PlanRequired("dailySchedule")
      if (!isLocalAccount(profile.storageAccountName) && !allows(plan, "azureStorage")) throw new PlanRequired("azureStorage")
    }
    const refused = await refuseUnlicensedBackup(
      { requireEntitlement: requirePlan, log: refusals, notify: (name, message) => notifyFailure(tenantId, name, message, trigger) },
      { tenantId, name: profile.name },
      trigger,
    )
    if (refused) {
      failedAttempts.record({ tenantId, trigger, slot, message: refused })
      return { status: "Failed" as const, message: refused }
    }
    let origin = { trigger, notified: false }
    const job = await runUnattended(engine, { tenantId, clientId: profile.clientId, storageAccountName: profile.storageAccountName, scope: scopes.get(tenantId).scope, trigger, slot }, (started) => {
      origin = unattendedBackupTriggers.get(started) ?? { trigger, notified: false }
      unattendedBackupTriggers.set(started, origin)
      return waitForJob(started)
    })
    const result = scheduledResult(job)
    // A repeated failure to reach Microsoft or storage in the same slot was already reported.
    if (!reportsResult(afterFailure, result)) return result
    const ok = result.status === "Completed"
    const cancelled = result.status === "Cancelled"
    const localNotified = cancelled ? false : await notifyBackupOutcome(job, trigger)
    const account = accounts.get(tenantId)
    // Record scheduled backups in the tenant's audit log, attributed to the signed-in admin. A Backup
    // Reader run skips it: the audit route signs in as the admin, which is exactly what the reader
    // replaces, so it would ask for a sign-in after a backup that worked. Its metadata.json records
    // the run (Trigger, AuthMode, RunId) in the backup itself.
    if (job.authMode !== "app-only") void host
      .dispatch(
        new Request(`${INTERNAL_API_ORIGIN}/api/audit/log`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantId,
            appId: profile.clientId,
            clientSecret: DELEGATED_CLIENT_SECRET,
            storageAccountName: profile.storageAccountName,
            user: { id: account?.username ?? "unknown", email: account?.username ?? "unknown", name: account?.name ?? "Scheduled backup" },
            logEntry: {
              eventType: cancelled ? "BACKUP_CANCELLED" : ok ? "BACKUP_COMPLETED" : "BACKUP_FAILED",
              action: "Scheduled backup",
              resource: { type: "backup", id: job.backupFolder ?? job.id, name: profile.name },
              result: cancelled ? "PARTIAL" : ok ? "SUCCESS" : "FAILURE",
              severity: ok || cancelled ? "INFO" : "ERROR",
              details: { source: "schedule", message: job.exception ?? job.progressMessage },
            },
          }),
        }),
      )
      .catch(() => undefined)
    if (job.authMode === "app-only") {
      backupReader.recordRun(tenantId, result.status)
      remindBackupReaderRenewal(tenantId, profile.name)
    }
    if (!ok && !cancelled && !origin.notified) {
      origin.notified = true
      // The channel delivery above already toasted this failure when a local intent was queued.
      if (!localNotified) notifyFailure(tenantId, profile.name, job.exception ?? "Open TenuVault for details.", origin.trigger)
    }
    return result
  }

  const scheduler = new BackupScheduler(appStore, (tenantId, afterFailure, slot) => runScheduledBackup(tenantId, "scheduled", afterFailure, slot), () => {
    mainWindow?.webContents.send("schedules:changed", scheduler.list())
    tray.refresh()
  })

  const tray = new AppTray({
    open: showWindow,
    backUpAll: () => {
      void runTrayBackups(connectedTenantIds(), (tenantId) => runScheduledBackup(tenantId, "tray"))
    },
    nextBackup: () => {
      const next = scheduler.next()
      if (!next) return null
      const name = tenantProfile(next.tenantId)?.name ?? next.tenantId
      return `${name}, ${next.at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    },
    quit: () => {
      quitting = true
      app.quit()
    },
  })
  tray.create()
  scopes.migrate(scheduler.list().map((schedule) => schedule.tenantId))
  scheduler.start()
  const stopFeatures = startFeatures(featureDeps)
  app.on("before-quit", stopFeatures)

  const updates = new Updates((status) => mainWindow?.webContents.send("updates:changed", status))
  // The MSI is deployed and updated by the organization; updating it would add a per-user copy.
  const autoUpdateManaged = (app.isPackaged && !installedBySetup(process.execPath)) || (await updatesDisabledByPolicy())
  const applyPreferences = (prefs: ReturnType<Preferences["get"]>) => {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: prefs.startAtLogin, args: ["--hidden"] })
    }
    updates.configure(prefs.autoUpdate && !autoUpdateManaged, prefs.nightlyUpdates)
  }
  applyPreferences(preferences.get())
  const currentPreferences = (): AppPreferences => ({
    ...preferences.get(),
    autoUpdate: preferences.get().autoUpdate && !autoUpdateManaged,
    autoUpdateManaged,
  })
  keepInTray = () => preferences.get().keepRunningInTray

  const backgroundLaunch = new BackgroundLaunch({ platform: process.platform, packaged: app.isPackaged, executable: process.execPath, home: app.getPath("home"), data: app.getPath("userData"), uid: process.getuid?.(), systemRoot: process.env.SystemRoot })
  // Status checks and changes share the Windows script path.
  let backgroundLaunchPending: Promise<unknown> = Promise.resolve()
  const updateBackgroundLaunch = (action: () => ReturnType<BackgroundLaunch["status"]>) => {
    const request = backgroundLaunchPending.then(action).then(status => {
      tray.setBackgroundRunnerInstalled(status.installed)
      return status
    })
    backgroundLaunchPending = request.catch(() => undefined)
    return request
  }
  void updateBackgroundLaunch(() => backgroundLaunch.refresh()).catch(error => console.warn("Could not check background startup.", error))
  handleTrusted("backgroundLaunch:status", () => updateBackgroundLaunch(() => backgroundLaunch.status()))
  handleTrusted("backgroundLaunch:install", () => updateBackgroundLaunch(() => backgroundLaunch.install()))
  handleTrusted("backgroundLaunch:remove", () => updateBackgroundLaunch(() => backgroundLaunch.remove()))

  handleTrusted("schedules:list", () => scheduler.list())
  handleTrusted("schedules:set", (_event, schedule: ScheduleInput) => withPlanError(() => {
    const current = scheduler.list().find((saved) => saved.tenantId === schedule.tenantId.toLowerCase())
    scheduler.set(prepareScheduleInput(schedule, license.plan(schedule.tenantId), current))
    return scheduler.list()
  }))
  handleTrusted("schedules:remove", (_event, tenantId: string) => {
    scheduler.remove(tenantId)
    return scheduler.list()
  })
  handleTrusted("schedules:refusals", (_event, tenantId: unknown) => (typeof tenantId === "string" ? refusals.list(tenantId) : []))
  handleTrusted("preferences:get", () => currentPreferences())
  handleTrusted("preferences:set", (_event, changes: Partial<AppPreferences>) => {
    const { autoUpdateManaged: _managed, ...rest } = changes
    applyPreferences(preferences.set(rest))
    return currentPreferences()
  })
  // The Backup Reader is set up per tenant in Settings > Background runner. Scheduled backups only run in the
  // installed Windows and macOS apps, so it is not offered elsewhere.
  const readerSupported = process.platform === "win32" || process.platform === "darwin"
  const readerState = (tenantId: string) => {
    const plan = license.plan(tenantId)
    const profile = tenantProfile(tenantId)
    const azureStorage = profile && !isLocalAccount(profile.storageAccountName) ? profile.storageAccountName : undefined
    return {
      supported: readerSupported,
      available: !!plan && allows(plan, "backupReader"),
      reader: backupReader.status(tenantId),
      ...(azureStorage ? { storageAccountName: azureStorage } : {}),
    }
  }
  const readerTenant = (tenantId: unknown) => {
    if (typeof tenantId !== "string" || !tenantProfile(tenantId)) throw new Error("Connect this tenant first.")
    return tenantId
  }
  // The confidence test behind Verify and the card's Test button: one small Intune read with the
  // reader's token (so a green verification is not just token claims), and for Azure tenants the
  // container check scheduled backups need (the TenuVault Backup Writer role from
  // New-TenuVaultStorage.ps1 -BackupReaderAppId). The result is recorded for the card's checklist;
  // a storage problem stays a warning, since the Graph part can still work.
  const testReader = async (tenantId: string): Promise<{ warning?: string }> => {
    const profile = tenantProfile(tenantId)
    if (!profile) return {}
    const azure = !isLocalAccount(profile.storageAccountName)
    const tokens = backupReader.tokens({ tenantId, clientId: profile.clientId, storageAccountName: profile.storageAccountName, trigger: "scheduled" })
    if (!tokens) {
      const message = "No verified Backup Reader is available for this tenant, or its certificate has expired."
      backupReader.recordTest(tenantId, { graph: false, storage: azure ? false : null, message })
      return { warning: message }
    }
    let graph = false
    let graphMessage: string | undefined
    try {
      const response = await chromiumFetch("https://graph.microsoft.com/beta/deviceManagement/deviceCompliancePolicies?$top=1&$select=id", {
        headers: { Authorization: `Bearer ${await tokens.graph()}` },
        signal: AbortSignal.timeout(15_000),
      })
      void response.body?.cancel().catch(() => undefined)
      graph = response.ok
      if (!graph) graphMessage = `Microsoft Graph answered ${response.status} for a Backup Reader read.`
    } catch (error) {
      graphMessage = error instanceof Error ? error.message : String(error)
    }
    let storage: boolean | null = null
    let warning: string | undefined
    if (azure) {
      const setup = `Run New-TenuVaultStorage.ps1 with -BackupReaderAppId ${backupReader.status(tenantId)?.clientId ?? ""} for storage account ${profile.storageAccountName}, wait a few minutes, then test again.`
      // The account name becomes the host of a request that carries the reader's storage token, so a
      // name that is not a plain Azure account name must never reach the URL.
      let nameValid = true
      try {
        assertStorageAccountName(profile.storageAccountName)
      } catch {
        nameValid = false
      }
      if (!nameValid) {
        storage = false
        warning = "Its Azure Storage access was not checked: the tenant's storage account name is not a valid Azure storage account name."
      } else {
        try {
          const response = await chromiumFetch(`https://${profile.storageAccountName}.blob.core.windows.net/intune-backups?restype=container&comp=list&maxresults=1`, {
            headers: { Authorization: `Bearer ${await tokens.storage()}`, "x-ms-version": "2023-11-03" },
            signal: AbortSignal.timeout(15_000),
          })
          void response.body?.cancel().catch(() => undefined)
          storage = response.ok
          if (response.status === 404) warning = `The Backup Reader works for Microsoft Graph, but the backup container does not exist in ${profile.storageAccountName}. ${setup}`
          else if (response.status === 403) warning = `The Backup Reader works for Microsoft Graph, but cannot write backups to ${profile.storageAccountName}. ${setup}`
          else if (!response.ok) warning = `The Backup Reader works for Microsoft Graph, but Azure Storage answered ${response.status}. ${setup}`
        } catch (error) {
          storage = false
          warning = `Its access to ${profile.storageAccountName} could not be checked: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    const message = [graph ? undefined : graphMessage, warning].filter(Boolean).join(" ") || undefined
    backupReader.recordTest(tenantId, { graph, storage, ...(message ? { message } : {}) })
    return message ? { warning: message } : {}
  }
  const requireReaderPlan = async (tenantId: string) => {
    if (!readerSupported) throw new Error("The Backup Reader is available in the installed Windows and macOS apps.")
    const plan = await license.requireEntitlement(tenantId)
    if (!allows(plan, "backupReader")) throw new PlanRequired("backupReader")
  }
  handleTrusted("backupReader:status", (_event, tenantId: unknown) => readerState(readerTenant(tenantId)))
  handleTrusted("backupReader:prepare", (_event, tenantId: unknown) => withPlanError(async () => {
    const tenant = readerTenant(tenantId)
    await requireReaderPlan(tenant)
    backupReader.prepare(tenant, hostname())
    return readerState(tenant)
  }))
  handleTrusted("backupReader:verify", (_event, tenantId: unknown, clientId: unknown, renewal: unknown) => withPlanError(async () => {
    const tenant = readerTenant(tenantId)
    await requireReaderPlan(tenant)
    await backupReader.verify(tenant, typeof clientId === "string" ? clientId.trim() : "", { renewal: renewal === true })
    const { warning } = await testReader(tenant)
    return { ...readerState(tenant), ...(warning ? { warning } : {}) }
  }))
  handleTrusted("backupReader:test", (_event, tenantId: unknown) => withPlanError(async () => {
    const tenant = readerTenant(tenantId)
    await requireReaderPlan(tenant)
    const { warning } = await testReader(tenant)
    return { ...readerState(tenant), ...(warning ? { warning } : {}) }
  }))
  handleTrusted("backupReader:cancelRenewal", (_event, tenantId: unknown) => {
    const tenant = readerTenant(tenantId)
    backupReader.cancelRenewal(tenant)
    return readerState(tenant)
  })
  handleTrusted("backupReader:exportCertificate", async (_event, tenantId: unknown) => {
    const tenant = readerTenant(tenantId)
    const reader = backupReader.status(tenant)
    if (!reader) throw new Error("Create the Backup Reader certificate first.")
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save Backup Reader certificate",
      defaultPath: join(app.getPath("documents"), `TenuVault Backup Reader ${reader.thumbprintSha256.slice(0, 8)}.cer`),
      filters: [{ name: "Certificate", extensions: ["cer"] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    const { writeFile } = await import("node:fs/promises")
    // Only the public certificate: the private key never leaves the encrypted store.
    await writeFile(result.filePath, reader.certificatePem, "utf8")
    backupReader.recordExport(tenant, basename(result.filePath))
    return { saved: true, fileName: basename(result.filePath) }
  })
  handleTrusted("backupReader:exportScript", async (_event, tenantId: unknown) => {
    readerTenant(tenantId)
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save Backup Reader setup script",
      defaultPath: join(app.getPath("documents"), "New-TenuVaultBackupReader.ps1"),
      filters: [{ name: "PowerShell script", extensions: ["ps1"] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    const { writeFile } = await import("node:fs/promises")
    await writeFile(result.filePath, readerSetupScript, "utf8")
    return { saved: true }
  })
  handleTrusted("backupReader:remove", (_event, tenantId: unknown) => {
    const tenant = readerTenant(tenantId)
    backupReader.remove(tenant)
    return readerState(tenant)
  })
  handleTrusted("pdfBranding:get", () => ({ branding: pdfBranding.get(), available: pdfBranding.available() }))
  handleTrusted("pdfBranding:set", (_event, branding: unknown) => withPlanError(() => ({ branding: pdfBranding.set(branding), available: true })))
  handleTrusted("pdfBranding:clear", () => {
    pdfBranding.clear()
    return { branding: null, available: pdfBranding.available() }
  })
  handleTrusted("updates:status", () => updates.current())
  handleTrusted("updates:check", () => updates.check())
  handleTrusted("updates:install", async () => {
    if (updates.current().state !== "ready") return
    quitting = true
    if (!(await updates.install())) quitting = false
  })

  handleTrusted("api", (_event, request: ApiRequest) => host.handleIpc(request))
  handleTrusted("disclaimer:accept", (_event, tenantIds: unknown) => {
    if (!Array.isArray(tenantIds) || !tenantIds.length || tenantIds.length > 500 || !tenantIds.every(isGuid)) throw new Error("Unknown tenant.")
    disclaimer.accept(tenantIds, (tenantId) => accounts.get(tenantId)?.username ?? null)
  })

  // A tenant is added only when the license covers it: this machine's key, or the
  // organization license shared with the tenant (checked with the new sign-in). The
  // check runs when the admin signs in and again when the tenant is saved; when it
  // fails, the new sign-in is removed so no tenant stays connected without a license.
  const requireForNewTenant = async (tenantId: string) => {
    try {
      await license.checkNewTenant(tenantId)
    } catch (error) {
      // A tenant that is already connected keeps its sign-in; only a new one is rolled back.
      const connected = connectedTenantIds().some((id) => id.toLowerCase() === tenantId.toLowerCase())
      if (!connected) await auth.signOut(tenantId)
      const message = `The tenant was not added. ${error instanceof Error ? error.message : String(error)}`
      if (error instanceof CommunityLimitError) throw new CommunityLimitError(error.tenantId, message)
      throw new Error(message)
    } finally {
      pushLicense()
    }
  }
  handleTrusted("auth:signIn", (_event, tenant: string, clientId: string) => withPlanError(async () => {
    const account = await auth.signIn(tenant, clientId)
    await requireForNewTenant(account.tenantId)
    return account
  }))
  // Signing in again also renews the ID token an organization license is checked with.
  handleTrusted("auth:reauthenticate", async (_event, tenantId: string, clientId: string, scope?: unknown) => {
    const account = await auth.reauthenticate(tenantId, clientId, scope === undefined ? undefined : String(scope))
    try {
      await license.requireEntitlement(tenantId, { retry: true })
    } finally {
      pushLicense()
    }
    return account
  })
  handleTrusted("auth:signOut", async (_event, tenantId: string) => {
    await auth.signOut(tenantId)
    // The Backup Reader's private key goes with the tenant's sign-in on this computer.
    backupReader.remove(tenantId)
    pushLicense()
  })
  handleTrusted("auth:accounts", () => auth.accounts())

  const isTenantId = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  const withStatus = async (action: () => Promise<void>) => {
    try {
      await action()
      return license.status(signedInTenants())
    } finally {
      pushLicense()
    }
  }
  handleTrusted("license:status", () => license.status(signedInTenants()))
  handleTrusted("license:refresh", () => withStatus(() => license.refreshAll()))
  handleTrusted("license:setKey", (_event, key: unknown) => {
    if (typeof key !== "string" || key.length > 256) throw new Error("Enter a valid license key.")
    return withStatus(() => license.setKey(key, signedInTenants()))
  })
  handleTrusted("license:retry", (_event, tenantId: unknown) => {
    if (tenantId !== undefined && tenantId !== null && !isTenantId(tenantId)) throw new Error("Unknown tenant.")
    return withStatus(() => license.retry(tenantId ? [tenantId] : signedInTenants()))
  })
  handleTrusted("license:setShared", (_event, tenantId: unknown, shared: unknown) => {
    if (!isTenantId(tenantId)) throw new Error("Unknown tenant.")
    if (typeof shared !== "boolean") throw new Error("Choose whether to share the license.")
    return withStatus(() => license.setShared(tenantId, shared))
  })
  handleTrusted("license:deactivate", () => withStatus(() => license.deactivate()))
  handleTrusted("license:checkNewTenant", (_event, tenantId: unknown) => {
    if (!isTenantId(tenantId)) throw new Error("Unknown tenant.")
    return withPlanError(() => withStatus(() => requireForNewTenant(tenantId)))
  })
  // Releasing needs the sign-in for organization licenses, so it runs before the sign-out.
  // A key activation the service could not release is kept and released at the next start.
  // The tenant's schedule goes with it.
  handleTrusted("license:releaseTenant", (_event, tenantId: unknown) => {
    if (!isTenantId(tenantId)) throw new Error("Unknown tenant.")
    return withStatus(async () => {
      scheduler.remove(tenantId)
      await license
        .releaseTenant(tenantId)
        .catch((error: unknown) => console.warn(`[license] Could not release ${tenantId}:`, error))
      await auth.signOut(tenantId)
      backupReader.remove(tenantId)
    })
  })
  handleTrusted("license:open", async (_event, target: unknown, options?: { source?: unknown }) => {
    const url = target === "buy" ? licenseBuyUrl(LICENSE_BUY_URL, options?.source) : target === "portal" ? LICENSE_PORTAL_URL : null
    if (!url || new URL(url).protocol !== "https:") throw new Error("Refused to open an unexpected link.")
    await shell.openExternal(url)
  })

  ipcMain.on("storage:getSync", (event, key: unknown) => {
    if (!trustedSender(event)) { event.returnValue = null; return }
    try {
      event.returnValue = appStore.get(RENDERER_STORAGE_PREFIX + rendererStorageKey(key))
    } catch {
      event.returnValue = null
    }
  })
  handleTrusted("storage:set", (_event, key: unknown, value: unknown) => appStore.set(RENDERER_STORAGE_PREFIX + rendererStorageKey(key), rendererStorageValue(value)))
  handleTrusted("storage:remove", (_event, key: unknown) => appStore.delete(RENDERER_STORAGE_PREFIX + rendererStorageKey(key)))

  let importingArchive = false
  handleTrusted("backups:importArchive", async () => {
    if (importingArchive) throw new Error("An archive import is already open")
    importingArchive = true
    try {
      const selected = await dialog.showOpenDialog(mainWindow!, { title: "Review backup archive", properties: ["openFile"], filters: [{ name: "TenuVault backup", extensions: ["zip"] }] })
      if (selected.canceled || !selected.filePaths[0]) return { imported: false }
      if ((await stat(selected.filePaths[0])).size > 32 * 1024 * 1024) throw new Error("Choose an archive smaller than 32 MiB")
      const archive = await reviewArchive(await readFile(selected.filePaths[0]))
      const confirm = async () => (await dialog.showMessageBox(mainWindow!, { type: "warning", title: "Review backup archive", message: `Import ${archive.count} policy snapshots?`, detail: `Source tenant: ${archive.tenantId}\nBackup: ${archive.backupId}\nSHA-256: ${archive.digest}\n\nThe archive declares its source identity; it is not signed. Use files supplied by a source you trust. Snapshots will be encrypted on this device. Import does not change Intune. Use the tenant's local backup storage and the existing restore preview to restore later.`, buttons: ["Cancel", "Import locally"], defaultId: 0, cancelId: 0 })).response === 1
      // The license check can claim a slot for the archive's tenant, so it runs only once the import is confirmed.
      if (!(await importConfirmedArchive(getLocalStore(), archive, confirm, (tenantId) => license.checkNewTenant(tenantId, { retry: false })))) return { imported: false }
      return { imported: true, tenantId: archive.tenantId, backupId: archive.backupId }
    } finally { importingArchive = false }
  })
  handleTrusted("backups:settings", () => backupSettings())
  handleTrusted("backups:inventoryProblem", (_event, tenantId: unknown) => {
    if (!isGuid(tenantId)) throw new Error("Unknown tenant.")
    return localInventoryProblem(getCheckStore(), localFolder(), tenantId)
  })
  handleTrusted("backups:cancel", async (_event, jobId: unknown) => {
    if (typeof jobId !== "string") throw new Error("Choose a running backup.")
    const job = engine.cancel(jobId)
    if (!job) throw new Error("This backup job is no longer available.")
    await engine.waitForJob(job)
  })
  handleTrusted("backups:scope", (_event, tenantId: unknown) => {
    if (typeof tenantId !== "string") throw new Error("Choose a tenant.")
    return scopes.get(tenantId)
  })
  handleTrusted("backups:failedAttempts", (_event, tenantId: unknown) => (typeof tenantId === "string" ? failedAttempts.list(tenantId) : []))
  handleTrusted("backups:liveRuns", (_event, tenantId: unknown) => (typeof tenantId === "string" ? engine.liveRuns(tenantId) : []))
  handleTrusted("backups:setScope", (_event, tenantId: unknown, scope: unknown) => {
    if (typeof tenantId !== "string" || !scope || typeof scope !== "object") throw new Error("Choose what to back up.")
    const normalized = normalizeScope(scope as BackupScope)
    if (includedTypes(normalized).length === 0) throw new Error("Choose at least one type to back up.")
    return scopes.set(tenantId, normalized)
  })
  // Every local storage request resolves the folder when it is made, so a change while a backup,
  // restore or import uses it would split that work across two folders.
  const assertLocalFolderIdle = () => {
    if (importingArchive || engine.hasLocalWork() || localRoutesRunning()) {
      throw new Error("A backup, restore or archive import is using the backup folder. Wait for it to finish, then change the folder.")
    }
  }
  handleTrusted("backups:chooseFolder", async () => {
    assertLocalFolderIdle()
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose where TenuVault stores backups",
      defaultPath: localFolder(),
      properties: ["openDirectory", "createDirectory"],
    })
    const folder = result.filePaths[0]
    if (!result.canceled && folder) {
      // Work may have started while the dialog was open.
      assertLocalFolderIdle()
      appStore.set(LOCAL_FOLDER_KEY, folder)
      localStore = null
      checkStore = null
    }
    return backupSettings()
  })
  handleTrusted("backups:openFolder", async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(localFolder(), { recursive: true })
    const failure = await shell.openPath(localFolder())
    if (failure) throw new Error(failure)
  })
  handleTrusted("backups:exportRecoveryKey", async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save backup recovery key",
      defaultPath: join(app.getPath("documents"), `TenuVault recovery key ${backupKeys.fingerprint()}.txt`),
      filters: [{ name: "Text", extensions: ["txt"] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    const { chmod, writeFile } = await import("node:fs/promises")
    await writeFile(
      result.filePath,
      [
        "TenuVault backup recovery key",
        "",
        "Anyone with this key and your backup files can read your Intune configuration.",
        "Store it like a password, for example in your password manager, and delete this file.",
        "",
        `Key fingerprint: ${backupKeys.fingerprint()}`,
        `Recovery key:    ${backupKeys.exportRecoveryKey()}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    )
    // The mode only applies to a new file; an overwritten file keeps its old permissions.
    // Windows has no owner-only mode bits, the profile folder's ACL protects the file there.
    if (process.platform !== "win32") await chmod(result.filePath, 0o600)
    appStore.set("backup.recovery-exported", backupKeys.fingerprint())
    return { saved: true, path: result.filePath }
  })
  handleTrusted("backups:importRecoveryKey", async (_event, recoveryKey: string) => {
    // The imported key encrypts every new backup, so the admin confirms it here, not only in the renderer.
    const review = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "Import recovery key", message: "Use this recovery key for new backups?", detail: "TenuVault encrypts every new backup on this device with the imported key. Backups made with the previous key stay readable. Import only a key you exported yourself or received from a source you trust.", buttons: ["Cancel", "Import key"], defaultId: 0, cancelId: 0 })
    if (review.response !== 1) return null
    backupKeys.importRecoveryKey(recoveryKey)
    localStore = null
    checkStore = null
    return backupSettings()
  })
  handleTrusted("backups:verifyAzureStorage", async (_event, tenantId: string, clientId: string, account: string) => {
    await license.requireEntitlement(tenantId, { retry: true })
    await verifyStorageAccess(bridgedFetch, account, async () =>
      (await tokenFor(tenantId, clientId, "https://storage.azure.com/.default")).accessToken,
    )
  })

  handleTrusted("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    trayIconLoaded: tray.iconLoaded,
    internalCisBenchmarks: internalCisBenchmarksEnabled(),
  }))
  handleTrusted("app:openExternal", (_event, url: string) => openExternalSafely(url))
  handleTrusted("reports:savePdf", async (_event, report: unknown, fileName: unknown) =>
    saveFileWithDialog(await prepareOibReportFile(report, fileName, (html, options) => printHtmlToPdf(html, options, (window) => new BrowserWindow(window))), "Save PDF report"))
  handleTrusted("reports:saveFile", (_event, data: unknown, fileName: unknown, encoding: unknown) => saveExportFile(data, fileName, encoding))

  createWindow()
}

/** Whether closing the window keeps TenuVault running in the tray (set once preferences load). */
let keepInTray = () => true

function showWindow(): void {
  if (!mainWindow) createWindow()
  mainWindow?.show()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
}

function rendererUrl(): string {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href
}

function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && sameRendererDocument(event.senderFrame.url, rendererUrl())
}

const handleTrusted: typeof ipcMain.handle = (channel, listener) => {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) {
      throw new Error("Untrusted IPC sender")
    }
    return listener(event, ...args)
  })
}

async function openExternalSafely(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    return Promise.reject(new Error(`Refusing to open ${parsed.protocol} URL`))
  }
  return shell.openExternal(parsed.href)
}

/** Saves an export built by the renderer (CSV, JSON, text or a PDF as base64) where the admin chooses. */
async function saveExportFile(data: unknown, fileName: unknown, encoding: unknown): Promise<{ saved: boolean; path?: string }> {
  return saveFileWithDialog(prepareSaveFile(data, fileName, encoding))
}

/** Asks where to save a checked file, under Documents by default, and writes it. */
async function saveFileWithDialog(file: PreparedFile, title = `Save ${file.label} file`): Promise<{ saved: boolean; path?: string }> {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title,
    defaultPath: join(app.getPath("documents"), file.name),
    filters: [{ name: file.label, extensions: [file.extension] }],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  const { writeFile } = await import("node:fs/promises")
  await writeFile(result.filePath, file.content)
  return { saved: true, path: result.filePath }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "TenuVault",
    show: false,
    backgroundColor: "#f9fafb",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })

  mainWindow.once("ready-to-show", () => {
    if (!startedHidden) mainWindow?.show()
  })

  // Closing the window keeps TenuVault in the tray so scheduled backups keep running.
  let toldAboutTray = false
  mainWindow.on("close", (event) => {
    if (quitting || !keepInTray()) return
    event.preventDefault()
    mainWindow?.hide()
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true
      new Notification({
        title: "TenuVault is still running",
        body: "Scheduled backups keep running in the background. Quit TenuVault from its tray icon.",
      }).show()
    }
  })

  // Links to external sites open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url).catch((error: unknown) => console.warn(String(error)))
    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url)
    // Shared pages occasionally navigate with `location.href = "/portal/..."`; route those
    // through the hash router instead of loading a file path that does not exist.
    // On Windows the file URL keeps the drive letter: file:///C:/portal/backup.
    const portalPath = /^(?:\/[A-Za-z]:)?(\/portal(?:\/.*)?)$/.exec(target.pathname)?.[1]
    if (portalPath && (target.protocol === "file:" || target.origin === new URL(rendererUrl()).origin)) {
      event.preventDefault()
      const route = `${portalPath}${target.search}`
      void mainWindow?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`)
    } else if (!sameRendererDocument(url, rendererUrl())) {
      event.preventDefault()
      void openExternalSafely(url).catch((error: unknown) => console.warn(String(error)))
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"))
  }
  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

// Starting TenuVault again (or clicking the dock icon) shows the window hidden in the tray.
app.on("second-instance", (_event, argv) => { if (!argv.includes("--hidden")) showWindow() })

app.on("before-quit", () => {
  quitting = true
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => showWindow())

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault())
})

if (isPrimaryInstance) void app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error("[app] Failed to start:", error)
  app.quit()
})
