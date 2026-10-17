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
const store = createBackgroundTaskStore({
  notify: (task) => {
    const action = task.href ? { label: task.status === "completed" ? "View results" : "Open", href: task.href } : undefined
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
