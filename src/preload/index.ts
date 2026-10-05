import { contextBridge, ipcRenderer } from "electron"
import type { BackupSchedule, LicenseStatus, SignInRequiredEvent, TenuVaultBridge, UpdateStatus } from "../shared/ipc"

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix from IPC errors. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ""))
  }
}

/** Subscribes to a main-process event; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: TenuVaultBridge = {
  api: (request) => invoke("api", request),
  auth: {
    signIn: (tenant, clientId) => invoke("auth:signIn", tenant, clientId),
    signOut: (tenantId) => invoke("auth:signOut", tenantId),
    accounts: () => invoke("auth:accounts"),
    reauthenticate: (tenantId, clientId, scope) => invoke("auth:reauthenticate", tenantId, clientId, scope),
    onSignInRequired: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: SignInRequiredEvent) => listener(payload)
      ipcRenderer.on("auth:signInRequired", handler)
      return () => ipcRenderer.removeListener("auth:signInRequired", handler)
    },
  },
  backups: {
    importArchive: () => invoke("backups:importArchive"),
    settings: () => invoke("backups:settings"),
    chooseFolder: () => invoke("backups:chooseFolder"),
    openFolder: () => invoke("backups:openFolder"),
    exportRecoveryKey: () => invoke("backups:exportRecoveryKey"),
    importRecoveryKey: (recoveryKey) => invoke("backups:importRecoveryKey", recoveryKey),
    verifyAzureStorage: (tenantId, clientId, storageAccountName) =>
      invoke("backups:verifyAzureStorage", tenantId, clientId, storageAccountName),
    scope: (tenantId) => invoke("backups:scope", tenantId),
    setScope: (tenantId, scope) => invoke("backups:setScope", tenantId, scope),
  },
  license: {
    status: () => invoke("license:status"),
    setKey: (key) => invoke("license:setKey", key),
    retry: (tenantId) => invoke("license:retry", tenantId ?? null),
    setShared: (tenantId, shared) => invoke("license:setShared", tenantId, shared),
    deactivate: () => invoke("license:deactivate"),
    checkNewTenant: (tenantId) => invoke("license:checkNewTenant", tenantId),
    releaseTenant: (tenantId) => invoke("license:releaseTenant", tenantId),
    open: (target) => invoke("license:open", target),
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
  updates: {
    status: () => invoke("updates:status"),
    check: () => invoke("updates:check"),
    install: () => invoke("updates:install"),
    onChanged: (listener) => subscribe<UpdateStatus>("updates:changed", listener),
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
  reports: {
    savePdf: (html, fileName) => invoke("reports:savePdf", html, fileName),
    saveFile: (data, fileName, encoding = "utf8") => invoke("reports:saveFile", data, fileName, encoding),
  },
  disclaimer: {
    accept: (tenantIds) => invoke("disclaimer:accept", tenantIds),
  },
}

contextBridge.exposeInMainWorld("tenuvault", bridge)
