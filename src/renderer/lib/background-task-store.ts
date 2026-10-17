/**
 * Background tasks for operations the renderer awaits itself (scans, reviews and exports that
 * have no main-process job). The store lives outside any page, so work started on one page
 * keeps running, and keeps reporting progress, while the admin navigates elsewhere. Starting a
 * task whose key is already running is a no-op, so a page revisited mid-task joins the running
 * task instead of starting a second one.
 */
export type BackgroundTaskStatus = "running" | "completed" | "failed"

export interface BackgroundTask {
  /** The dedupe key the task was started with, for example `hygiene:<tenantId>`. */
  id: string
  title: string
  /** The current step while running, or the outcome once finished. */
  detail?: string
  /** 0 to 100 when the work can measure itself; undefined shows an indeterminate bar. */
  percent?: number
  status: BackgroundTaskStatus
  startedAt: number
  finishedAt?: number
  /** The in-app route that shows the result, for example /portal/governance/hygiene. */
  href?: string
  error?: string
}

export interface BackgroundTaskReport {
  detail?: string
  percent?: number
}

export interface BackgroundTaskOptions {
  title: string
  detail?: string
  href?: string
}

const DEFAULT_AUTO_REMOVE_MS = 30_000

/** True when the hash route is the task's result page, so its outcome is already on screen. */
export function isOnTaskPage(hash: string, href: string | undefined): boolean {
  if (!href) return false
  const route = hash.startsWith("#") ? hash.slice(1) : hash
  return route === href || route.startsWith(`${href}?`) || route.startsWith(`${href}/`)
}

export interface BackgroundTaskStore {
  /**
   * Runs `work` detached from the caller and tracks it under `key`. Returns false without
   * starting anything when a task with that key is already running. The string `work` returns,
   * when any, becomes the completed detail.
   */
  start: (key: string, options: BackgroundTaskOptions, work: (report: (update: BackgroundTaskReport) => void) => Promise<string | void>) => boolean
  dismiss: (id: string) => void
  clearFinished: () => void
  getSnapshot: () => BackgroundTask[]
  subscribe: (listener: () => void) => () => void
}

export function createBackgroundTaskStore(options: {
  /** Called once when a task finishes away from its result page. */
  notify: (task: BackgroundTask) => void
  /** How long a completed task stays listed. Failed tasks stay until dismissed. */
  autoRemoveMs?: number
  currentHash?: () => string
  now?: () => number
}): BackgroundTaskStore {
  const autoRemoveMs = options.autoRemoveMs ?? DEFAULT_AUTO_REMOVE_MS
  const now = options.now ?? Date.now
  const currentHash = options.currentHash ?? (() => (typeof location === "undefined" ? "" : location.hash))
  let tasks: BackgroundTask[] = []
  const listeners = new Set<() => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function emit() {
    for (const listener of listeners) listener()
  }

  function replace(task: BackgroundTask) {
    tasks = tasks.map((item) => (item.id === task.id ? task : item))
    emit()
  }

  function dismiss(id: string) {
    clearTimer(id)
    if (!tasks.some((task) => task.id === id)) return
    tasks = tasks.filter((task) => task.id !== id)
    emit()
  }

  function clearTimer(id: string) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  function finish(task: BackgroundTask) {
    replace(task)
    if (!isOnTaskPage(currentHash(), task.href)) options.notify(task)
    if (task.status === "completed") {
      clearTimer(task.id)
      timers.set(task.id, setTimeout(() => dismiss(task.id), autoRemoveMs))
    }
  }

  return {
    start(key, taskOptions, work) {
      if (tasks.some((task) => task.id === key && task.status === "running")) return false
      const running: BackgroundTask = {
        id: key,
        title: taskOptions.title,
        detail: taskOptions.detail,
        href: taskOptions.href,
        status: "running",
        startedAt: now(),
      }
      // A restarted key replaces its finished entry instead of listing the same task twice,
      // and the finished entry's auto-remove must not delete the new run later.
      clearTimer(key)
      tasks = [running, ...tasks.filter((task) => task.id !== key)]
      emit()
      const report = (update: BackgroundTaskReport) => {
        const current = tasks.find((task) => task.id === key)
        if (!current || current.status !== "running") return
        replace({ ...current, detail: update.detail ?? current.detail, percent: update.percent ?? current.percent })
      }
      void work(report).then(
        (result) => {
          const current = tasks.find((task) => task.id === key)
          if (!current || current.status !== "running") return
          finish({ ...current, status: "completed", percent: 100, detail: result ?? current.detail, finishedAt: now() })
        },
        (error: unknown) => {
          const current = tasks.find((task) => task.id === key)
          if (!current || current.status !== "running") return
          const message = error instanceof Error ? error.message : "The task failed."
          finish({ ...current, status: "failed", detail: message, error: message, finishedAt: now() })
        },
      )
      return true
    },
    dismiss,
    clearFinished() {
      for (const task of tasks) if (task.status !== "running") dismiss(task.id)
    },
    getSnapshot: () => tasks,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
