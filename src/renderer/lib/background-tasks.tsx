import { useSyncExternalStore } from "react"
import { createBackgroundTaskStore, type BackgroundTask, type BackgroundTaskOptions, type BackgroundTaskReport } from "./background-task-store"
import { toast } from "./toast"

export type { BackgroundTask, BackgroundTaskOptions, BackgroundTaskReport }

/**
 * The one background task store for renderer-awaited work (hygiene scans, health reviews,
 * exports). Main-process jobs (backups, drift scans, framework and pack assessments) have
 * their own stores; the activity panel shows all of them together. A finished task toasts
 * when the admin is not already looking at its result page.
 */
let selectedTenantId: string | undefined

/** Records the tenant on screen, called by the activity panel, which is always mounted. */
export function noteBackgroundTaskTenant(tenantId: string | undefined): void {
  selectedTenantId = tenantId
}

/** The task's result route naming its tenant, so the link opens that tenant's page. */
export function taskHref(task: Pick<BackgroundTask, "href" | "tenantId">): string | undefined {
  if (!task.href) return undefined
  if (!task.tenantId || task.href.includes("tenant=")) return task.href
  return `${task.href}${task.href.includes("?") ? "&" : "?"}tenant=${task.tenantId}`
}

const store = createBackgroundTaskStore({
  currentTenantId: () => selectedTenantId,
  notify: (task) => {
    const href = taskHref(task)
    const action = href ? { label: task.status === "completed" ? "View results" : "Open", href } : undefined
    if (task.status === "completed") toast(task.detail ?? `${task.title} finished.`, "success", action)
    else toast(`${task.title} failed. ${task.error ?? ""}`.trim(), "error", action)
  },
})

export function startBackgroundTask(key: string, options: BackgroundTaskOptions, work: (report: (update: BackgroundTaskReport) => void) => Promise<string | void>): boolean {
  return store.start(key, options, work)
}

export function dismissBackgroundTask(id: string): void {
  store.dismiss(id)
}

export function clearFinishedBackgroundTasks(): void {
  store.clearFinished()
}

export function useBackgroundTasks(): BackgroundTask[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** The task started under `key`, so a page revisited mid-task shows it still running. */
export function useBackgroundTask(key: string | undefined): BackgroundTask | undefined {
  const tasks = useBackgroundTasks()
  return key ? tasks.find((task) => task.id === key) : undefined
}
