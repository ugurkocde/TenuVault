import { reviewArchive, importArchive } from "./backup/archive"
import { readFile, stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { isGuid, sameRendererDocument } from "../shared/security"
import { prepareSaveFile } from "./save-file"
import { app, BrowserWindow, dialog, ipcMain, net, Notification, safeStorage, shell } from "electron"
import { join } from "node:path"
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
import { BackupScheduler } from "./backup/scheduler"
import { BackgroundLaunch } from "./backup/background-launch"
import { BackupScopes } from "./backup/scopes"
import { includedTypes, normalizeScope, type BackupScope } from "../shared/intune/scope"
import { RefusalLog, refuseUnlicensedBackup } from "./backup/refusals"
import { BackupKeys } from "./backup/keys"
import { encryptedAzureFetch, registerStorageToken } from "./storage/azure-seal"
import { handleLocalBlobRequest, isLocalAccount } from "./storage/blob-emulator"
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
import { DisclaimerAcknowledgements, disclaimerGuard } from "./disclaimer"
import { migrateLegacyOibRuns, setOibStore } from "./oib/service"
import { setOibCacheDir } from "./oib/source"
import { setFrameworkStore } from "./frameworks/workspaces"
import { setNativeFrameworkStore, setNativeFrameworkAuthorization, setNativeFrameworkNotifier } from "./frameworks/native"
import { allows, COMMUNITY_RETENTION_DAYS, PlanRequired } from "../shared/plans"
import { SecureStore, UnreadableStoreError, type Cipher } from "./storage/secure-store"
import { Preferences } from "./preferences"
import { AppTray } from "./tray"
import { installedBySetup, isNightly, Updates, updatesDisabledByPolicy } from "./updates"
import { featureRoutes, startFeatures } from "./features"
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
function openStore(filePath: string, cipher: Cipher, startOver = "your saved data is kept as a backup, and you sign in to your tenants and activate your license again."): SecureStore | null {
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
      buttons: ["Quit", "Start over"],
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
  const appStore = openStore(join(userData, "app-state.bin"), cipher)
  const tokenStore = appStore && openStore(join(userData, "token-cache.bin"), cipher)
  // Records of the review, evidence and change workflows, kept apart so the app state stays small.
  const workspaceStore = tokenStore && openStore(join(userData, "workspace.bin"), cipher, "your saved review records (baselines, promotions and health reviews) are kept as a backup copy and start empty. Tenant access and your license are not affected.")
  if (!appStore || !tokenStore || !workspaceStore) {
    app.quit()
    return
  }

  const accounts = accountStore(appStore)
  const auth = new AuthManager({
    cachePlugin: (clientId) => secureCachePlugin(tokenStore, clientId),
    openBrowser: (url) => shell.openExternal(url),
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
  const backupSettings = () => ({ localFolder: localFolder(), keyFingerprint: backupKeys.fingerprint() })

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
  const engine = new BackupEngine({
    fetch: bridgedFetch,
    getToken: async (tenantId, clientId, scope) => {
      await license.requireEntitlement(tenantId)
      return (await tokenFor(tenantId, clientId, scope)).accessToken
    },
    // Community keeps 30 days of history; Pro and MSP keep what the admin chooses (0 keeps everything).
    retentionDays: (tenantId) => {
      const days = preferences.get().retentionDays
      if (license.plan(tenantId) !== "community") return days
      return days === 0 ? COMMUNITY_RETENTION_DAYS : Math.min(days, COMMUNITY_RETENTION_DAYS)
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
  const checkPlan = planGuard((tenantId) => license.requireEntitlement(tenantId).catch(() => null))
  // Drift scans run in the background; each tenant's last result is kept with the workflow records.
  const memoryResults = new Map<string, string>()
  const driftJobs = new DriftJobs({
    api: featureDeps.api,
    tenant: featureDeps.tenant,
    plan: featureDeps.plan,
    store: canEncrypt() ? workspaceStore : { get: (key) => memoryResults.get(key) ?? null, set: (key, value) => void memoryResults.set(key, value), delete: (key) => void memoryResults.delete(key) },
    // When the window is not in front, a system notification says the scan finished; the app itself shows a toast.
    notify: (job) => {
      if (job.status === "cancelled" || mainWindow?.isFocused() || !Notification.isSupported()) return
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
    },
  })
  const host: ApiHost = new ApiHost({
    routes: { ...routes, ...backupRoutes(engine, (tenantId) => scopes.get(tenantId).scope), ...featureRoutes(featureDeps), ...driftScanRoutes(driftJobs) },
    transform: surfaceTokenErrors,
    // The plan comes first, so the disclaimer is never accepted for a change the plan refuses anyway.
    guard: async (request) => (await checkPlan(request)) ?? checkDisclaimer(request),
    onHandled: createAuditRecorder((request) => host.dispatch(request), (tenantId) => accounts.get(tenantId)),
  })

  // Tenant profiles are kept by the renderer; scheduled backups read them from the store.
  const tenantProfile = (tenantId: string) => {
    try {
      const tenants = JSON.parse(appStore.get(`${RENDERER_STORAGE_PREFIX}tenuvault_tenants`) ?? "[]") as Array<{
        name?: string
        credentials?: { tenantId?: string; appId?: string }
        resources?: { storageAccountName?: string }
      }>
      const tenant = tenants.find((t) => t.credentials?.tenantId?.toLowerCase() === tenantId.toLowerCase())
      if (!tenant?.credentials?.appId || !tenant.resources?.storageAccountName) return null
      return { name: tenant.name ?? tenantId, clientId: tenant.credentials.appId, storageAccountName: tenant.resources.storageAccountName }
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

  const waitForJob = async (job: BackupJob) => {
    while (job.status === "Running") await new Promise((resolve) => setTimeout(resolve, 2000))
    return job
  }

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

  const notifyFailure = (name: string, message: string) => {
    if (Notification.isSupported()) new Notification({ title: `Scheduled backup of ${name} failed`, body: message }).show()
  }

  const refusals = new RefusalLog(appStore, () => mainWindow?.webContents.send("schedules:refusalsChanged"))

  const runScheduledBackup = async (tenantId: string, trigger: "scheduled" | "tray") => {
    const profile = tenantProfile(tenantId)
    if (!profile) return { status: "Failed" as const, message: "This tenant is no longer connected." }
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
      { requireEntitlement: requirePlan, log: refusals, notify: notifyFailure },
      { tenantId, name: profile.name },
      trigger,
    )
    if (refused) return { status: "Failed" as const, message: refused }
    const job = await waitForJob(
      engine.start({ tenantId, clientId: profile.clientId, storageAccountName: profile.storageAccountName, scope: scopes.get(tenantId).scope, trigger }),
    )
    const ok = job.status === "Completed"
    const account = accounts.get(tenantId)
    // Record scheduled backups in the tenant's audit log, attributed to the signed-in admin.
    void host
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
              eventType: ok ? "BACKUP_COMPLETED" : "BACKUP_FAILED",
              action: "Scheduled backup",
              resource: { type: "backup", id: job.backupFolder ?? job.id, name: profile.name },
              result: ok ? "SUCCESS" : "FAILURE",
              severity: ok ? "INFO" : "ERROR",
              details: { source: "schedule", message: job.exception ?? job.progressMessage },
            },
          }),
        }),
      )
      .catch(() => undefined)
    if (!ok) notifyFailure(profile.name, job.exception ?? "Open TenuVault for details.")
    return { status: ok ? ("Completed" as const) : ("Failed" as const), message: job.exception ?? job.progressMessage }
  }

  const scheduler = new BackupScheduler(appStore, (tenantId) => runScheduledBackup(tenantId, "scheduled"), () => {
    mainWindow?.webContents.send("schedules:changed", scheduler.list())
    tray.refresh()
  })

  const tray = new AppTray({
    open: showWindow,
    backUpAll: () => {
      for (const tenantId of connectedTenantIds()) void runScheduledBackup(tenantId, "tray")
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
  handleTrusted("backgroundLaunch:status", () => backgroundLaunch.status())
  handleTrusted("backgroundLaunch:install", () => backgroundLaunch.install())
  handleTrusted("backgroundLaunch:remove", () => backgroundLaunch.remove())

  handleTrusted("schedules:list", () => scheduler.list())
  handleTrusted("schedules:set", (_event, schedule: ScheduleInput) => {
    if (schedule.frequency === "daily" && license.plan(schedule.tenantId) === "community") throw new PlanRequired("dailySchedule")
    scheduler.set(schedule)
    return scheduler.list()
  })
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
      await license.requireEntitlement(tenantId, { retry: true })
    } catch (error) {
      // A tenant that is already connected keeps its sign-in; only a new one is rolled back.
      const connected = connectedTenantIds().some((id) => id.toLowerCase() === tenantId.toLowerCase())
      if (!connected) await auth.signOut(tenantId)
      throw new Error(`The tenant was not added. ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      pushLicense()
    }
  }
  handleTrusted("auth:signIn", async (_event, tenant: string, clientId: string) => {
    const account = await auth.signIn(tenant, clientId)
    await requireForNewTenant(account.tenantId)
    return account
  })
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
    return withStatus(() => requireForNewTenant(tenantId))
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
    })
  })
  handleTrusted("license:open", async (_event, target: unknown) => {
    const url = target === "buy" ? LICENSE_BUY_URL : target === "portal" ? LICENSE_PORTAL_URL : null
    if (!url || new URL(url).protocol !== "https:") throw new Error("Refused to open an unexpected link.")
    await shell.openExternal(url)
  })

  ipcMain.on("storage:getSync", (event, key: string) => {
    if (!trustedSender(event)) { event.returnValue = null; return }
    event.returnValue = appStore.get(RENDERER_STORAGE_PREFIX + key)
  })
  handleTrusted("storage:set", (_event, key: string, value: string) => appStore.set(RENDERER_STORAGE_PREFIX + key, value))
  handleTrusted("storage:remove", (_event, key: string) => appStore.delete(RENDERER_STORAGE_PREFIX + key))

  let importingArchive = false
  handleTrusted("backups:importArchive", async () => {
    if (importingArchive) throw new Error("An archive import is already open")
    importingArchive = true
    try {
      const selected = await dialog.showOpenDialog(mainWindow!, { title: "Review backup archive", properties: ["openFile"], filters: [{ name: "TenuVault backup", extensions: ["zip"] }] })
      if (selected.canceled || !selected.filePaths[0]) return { imported: false }
      if ((await stat(selected.filePaths[0])).size > 32 * 1024 * 1024) throw new Error("Choose an archive smaller than 32 MiB")
      const archive = await reviewArchive(await readFile(selected.filePaths[0]))
      await license.requireEntitlement(archive.tenantId)
      const review = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "Review backup archive", message: `Import ${archive.count} policy snapshots?`, detail: `Source tenant: ${archive.tenantId}\nBackup: ${archive.backupId}\nSHA-256: ${archive.digest}\n\nThe archive declares its source identity; it is not signed. Use files supplied by a source you trust. Snapshots will be encrypted on this device. Import does not change Intune. Use the tenant's local backup storage and the existing restore preview to restore later.`, buttons: ["Cancel", "Import locally"], defaultId: 0, cancelId: 0 })
      if (review.response !== 1) return { imported: false }
      await importArchive(getLocalStore(), archive)
      return { imported: true, tenantId: archive.tenantId, backupId: archive.backupId }
    } finally { importingArchive = false }
  })
  handleTrusted("backups:settings", () => backupSettings())
  handleTrusted("backups:scope", (_event, tenantId: unknown) => {
    if (typeof tenantId !== "string") throw new Error("Choose a tenant.")
    return scopes.get(tenantId)
  })
  handleTrusted("backups:setScope", (_event, tenantId: unknown, scope: unknown) => {
    if (typeof tenantId !== "string" || !scope || typeof scope !== "object") throw new Error("Choose what to back up.")
    const normalized = normalizeScope(scope as BackupScope)
    if (includedTypes(normalized).length === 0) throw new Error("Choose at least one type to back up.")
    return scopes.set(tenantId, normalized)
  })
  handleTrusted("backups:chooseFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose where TenuVault stores backups",
      defaultPath: localFolder(),
      properties: ["openDirectory", "createDirectory"],
    })
    const folder = result.filePaths[0]
    if (!result.canceled && folder) {
      appStore.set(LOCAL_FOLDER_KEY, folder)
      localStore = null
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
  }))
  handleTrusted("app:openExternal", (_event, url: string) => openExternalSafely(url))
  handleTrusted("reports:savePdf", (_event, html: unknown, fileName: unknown) => savePdfReport(html, fileName))
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

/**
 * Prints a report built by the renderer to PDF. The page is rendered in a hidden, sandboxed window
 * with JavaScript off and a CSP that blocks every external resource, then saved where the admin chooses.
 */
async function savePdfReport(html: unknown, fileName: unknown): Promise<{ saved: boolean; path?: string }> {
  if (typeof html !== "string" || !html.startsWith("<!doctype html>") || html.length > 25_000_000) throw new Error("The report could not be prepared.")
  const base = (typeof fileName === "string" ? fileName : "").replace(/\.pdf$/i, "").replace(/[^\w .()-]/g, "_").trim().slice(0, 120) || "TenuVault report"
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const folder = await mkdtemp(join(tmpdir(), "tenuvault-report-"))
  const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  try {
    page.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    page.webContents.on("will-navigate", (event) => event.preventDefault())
    const file = join(folder, "report.html")
    await writeFile(file, html, { encoding: "utf8", mode: 0o600 })
    await page.loadFile(file)
    const pdf = await page.webContents.printToPDF({ printBackground: true, pageSize: "A4" })
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: "Save PDF report",
      defaultPath: join(app.getPath("documents"), `${base}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, pdf)
    return { saved: true, path: result.filePath }
  } finally {
    page.destroy()
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Saves an export built by the renderer (CSV, JSON, text or a PDF as base64) where the admin chooses. */
async function saveExportFile(data: unknown, fileName: unknown, encoding: unknown): Promise<{ saved: boolean; path?: string }> {
  const file = prepareSaveFile(data, fileName, encoding)
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: `Save ${file.label} file`,
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
