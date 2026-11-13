import { contextBridge, ipcRenderer } from "electron"
import type { BackupSchedule, LicenseStatus, ProxySignInPrompt, SignInRequiredEvent, TenuVaultPreloadBridge, UpdateStatus } from "../shared/ipc"

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix from IPC errors. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cleaned = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "")
    throw new Error(cleaned.replace(/^LicenseDenied: /, ""))
  }
}

/** Subscribes to a main-process event; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: TenuVaultPreloadBridge = {
  appSources: {
    details: (tenant, appId) => invoke("appSources:details", tenant, appId),
    printDetails: (tenant, appId) => invoke("appSources:printDetails", tenant, appId),
    downloadScript: (tenant, appId, scriptId) => invoke("appSources:downloadScript", tenant, appId, scriptId),
    apps: (tenant) => invoke("appSources:apps", tenant),
    list: (tenant) => invoke("appSources:list", tenant),
    chooseStore: (tenant) => invoke("appSources:chooseStore", tenant),
    attach: (tenant, operation, name) => invoke("appSources:attach", tenant, operation, name),
    export: (tenant, operation, source) => invoke("appSources:export", tenant, operation, source),
    cancel: (tenant, operation) => invoke("appSources:cancel", tenant, operation),
    deviceStatus: (tenant) => invoke("appSources:deviceStatus", tenant),
    signIn: (tenant) => invoke("appSources:signIn", tenant),
  },
  api: (request) => invoke("api", request),
  auth: {
    signIn: (tenant, clientId, options) => invoke("auth:signIn", tenant, clientId, options),
    signOut: (tenantId) => invoke("auth:signOut", tenantId),
    accounts: () => invoke("auth:accounts"),
    reauthenticate: (tenantId, clientId, scope) => invoke("auth:reauthenticate", tenantId, clientId, scope),
    cancelSignIn: () => invoke("auth:cancelSignIn"),
    copySignInLink: (kind) => invoke("auth:copySignInLink", kind),
    onSignInRequired: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SignInRequiredEvent) => listener(payload)
      ipcRenderer.on("auth:signInRequired", handler)
      return () => ipcRenderer.removeListener("auth:signInRequired", handler)
    },
  },
  proxy: {
    pending: () => invoke("proxy:pending"),
    answer: (id, answer) => invoke("proxy:answer", id, answer),
    onPrompts: (listener) => subscribe<ProxySignInPrompt[]>("proxy:prompts", listener),
    saved: () => invoke("proxy:saved"),
    forget: () => invoke("proxy:forget"),
    onSavedChanged: (listener) => subscribe<void>("proxy:savedChanged", () => listener()),
  },
  setup: {
    createRegistration: (options) => invoke("setup:createRegistration", options),
    cancelCreateRegistration: () => invoke("setup:cancelCreateRegistration"),
    onProgress: (listener) => subscribe("setup:progress", listener),
    clipboardIds: () => invoke("setup:clipboardIds"),
    saveScript: () => invoke("setup:saveScript"),
  },
  backups: {
    cancel: (jobId) => invoke("backups:cancel", jobId),
    importArchive: () => invoke("backups:importArchive"),
    settings: () => invoke("backups:settings"),
    inventoryProblem: (tenantId) => invoke("backups:inventoryProblem", tenantId),
    chooseFolder: () => invoke("backups:chooseFolder"),
    openFolder: (tenantId) => invoke("backups:openFolder", tenantId),
    exportRecoveryKey: () => invoke("backups:exportRecoveryKey"),
    importRecoveryKey: (recoveryKey) => invoke("backups:importRecoveryKey", recoveryKey),
    verifyAzureStorage: (tenantId, clientId, storageAccountName) =>
      invoke("backups:verifyAzureStorage", tenantId, clientId, storageAccountName),
    scope: (tenantId) => invoke("backups:scope", tenantId),
    setScope: (tenantId, scope) => invoke("backups:setScope", tenantId, scope),
    failedAttempts: (tenantId) => invoke("backups:failedAttempts", tenantId),
    liveRuns: (tenantId) => invoke("backups:liveRuns", tenantId),
  },
  services: {
    status: (tenantId, clientId, refresh) => invoke("services:status", tenantId, clientId, refresh === true),
    setEnabled: (tenantId, clientId, id, enabled) => invoke("services:setEnabled", tenantId, clientId, id, enabled),
  },
  license: {
    trialWorkflowsConfigured: (tenantId) => invoke("license:trialWorkflowsConfigured", tenantId),
    trialUsage: (tenantId) => invoke("license:trialUsage", tenantId),
    startTenantTrial: (tenantId) => invoke("license:startTenantTrial", tenantId),
    tenantTrialAction: (tenantId, action, email) => invoke("license:tenantTrialAction", tenantId, action, email),
    chooseCommunity: (tenantId) => invoke("license:chooseCommunity", tenantId),
    status: () => invoke("license:status"),
    refresh: () => invoke("license:refresh"),
    setKey: (key) => invoke("license:setKey", key),
    replaceKey: (key) => invoke("license:replaceKey", key),
    retry: (tenantId) => invoke("license:retry", tenantId ?? null),
    setShared: (tenantId, shared) => invoke("license:setShared", tenantId, shared),
    deactivate: () => invoke("license:deactivate"),
    checkNewTenant: (tenantId) => invoke("license:checkNewTenant", tenantId),
    releaseTenant: (tenantId) => invoke("license:releaseTenant", tenantId),
    open: (target, options) => invoke("license:open", target, options),
    startTrial: (email, options) => invoke("license:startTrial", email, options),
    clipboardKey: () => invoke("license:clipboardKey"),
    onChanged: (listener) => subscribe<LicenseStatus>("license:changed", listener),
  },
  schedules: {
    list: () => invoke("schedules:list"),
    set: (schedule) => invoke("schedules:set", schedule),
    remove: (tenantId) => invoke("schedules:remove", tenantId),
    onChanged: (listener) => subscribe<BackupSchedule[]>("schedules:changed", listener),
    refusals: (tenantId) => invoke("schedules:refusals", tenantId),
    onRefusalsChanged: (listener) => subscribe<void>("schedules:refusalsChanged", () => listener()),
  },
  backgroundLaunch: {
    status: () => invoke("backgroundLaunch:status"),
    install: () => invoke("backgroundLaunch:install"),
    remove: () => invoke("backgroundLaunch:remove"),
  },
  preferences: {
    get: () => invoke("preferences:get"),
    set: (changes) => invoke("preferences:set", changes),
  },
  pdfBranding: {
    get: () => invoke("pdfBranding:get"),
    set: (branding) => invoke("pdfBranding:set", branding),
    clear: () => invoke("pdfBranding:clear"),
  },
  backupReader: {
    status: (tenantId) => invoke("backupReader:status", tenantId),
    prepare: (tenantId) => invoke("backupReader:prepare", tenantId),
    exportCertificate: (tenantId) => invoke("backupReader:exportCertificate", tenantId),
    exportScript: (tenantId) => invoke("backupReader:exportScript", tenantId),
    verify: (tenantId, clientId, renewal) => invoke("backupReader:verify", tenantId, clientId, renewal === true),
    test: (tenantId) => invoke("backupReader:test", tenantId),
    cancelRenewal: (tenantId) => invoke("backupReader:cancelRenewal", tenantId),
    remove: (tenantId) => invoke("backupReader:remove", tenantId),
  },
  updates: {
    status: () => invoke("updates:status"),
    check: () => invoke("updates:check"),
    install: () => invoke("updates:install"),
    onChanged: (listener) => subscribe<UpdateStatus>("updates:changed", listener),
    whatsNew: () => invoke("updates:whatsNew"),
    markWhatsNewSeen: () => invoke("updates:markWhatsNewSeen"),
  },
  storage: {
    getItemSync: (key) => ipcRenderer.sendSync("storage:getSync", key) as string | null,
    setItem: (key, value) => invoke("storage:set", key, value),
    removeItem: (key) => invoke("storage:remove", key),
  },
  app: {
    info: () => invoke("app:info"),
    openExternal: (url) => invoke("app:openExternal", url),
  },
  diagnostics: {
    status: () => invoke("diagnostics:status"),
    consent: (where, step) => invoke("diagnostics:consent", where, step),
    decline: () => invoke("diagnostics:decline"),
    reminderShown: () => invoke("diagnostics:reminderShown"),
    record: (event) => invoke("diagnostics:record", event.name, "props" in event ? event.props : undefined),
  },
  feedback: {
    capture: (page) => invoke("feedback:capture", page),
    send: (openingId, input) => invoke("feedback:send", openingId, input),
    discardCapture: (openingId) => invoke("feedback:discardCapture", openingId),
  },
  reports: {
    savePdf: (report, fileName) => invoke("reports:savePdf", report, fileName),
    saveFile: (data, fileName, encoding = "utf8") => invoke("reports:saveFile", data, fileName, encoding),
  },
  disclaimer: {
    accept: (tenantIds) => invoke("disclaimer:accept", tenantIds),
  },
}

contextBridge.exposeInMainWorld("tenuvault", bridge)
