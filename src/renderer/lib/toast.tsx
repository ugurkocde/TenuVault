import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react"
import { cn } from "~/lib/utils"

export type ToastVariant = "info" | "success" | "error"

export interface ToastAction {
  label: string
  /** An in-app route, for example /portal/frameworks/iso-27001. */
  href: string
}

interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
  action?: ToastAction
}

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<(items: ToastItem[]) => void>()

function emit() {
  for (const listener of listeners) listener(items)
}

export function toast(message: string, variant: ToastVariant = "info", action?: ToastAction): void {
  const id = nextId++
  items = [...items.slice(-3), { id, message, variant, action }]
  emit()
  setTimeout(() => dismiss(id), variant === "error" || action ? 10000 : 5000)
}

function dismiss(id: number) {
  items = items.filter((item) => item.id !== id)
  emit()
}

/**
 * The shared pages report errors with `alert()`, which blocks the whole window with a
 * native dialog. In the app those messages become toasts instead.
 */
export function replaceAlerts(): void {
  window.alert = (message?: unknown) => {
    const text = String(message ?? "")
    toast(text, /fail|error|could not|cannot|denied|invalid/i.test(text) ? "error" : "info")
  }
}

const icons = { info: Info, success: CheckCircle2, error: AlertCircle }
const styles = {
  info: "border-blue-200 bg-white text-gray-800",
  success: "border-green-200 bg-white text-gray-800",
  error: "border-red-200 bg-red-50 text-red-800",
}

export function Toaster() {
  const [current, setCurrent] = useState(items)
  useEffect(() => {
    listeners.add(setCurrent)
    return () => void listeners.delete(setCurrent)
  }, [])

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-96 flex-col gap-2" role="status" aria-live="polite">
      {current.map((item) => {
        const Icon = icons[item.variant]
        return (
          <div
            key={item.id}
            className={cn("pointer-events-auto flex items-start gap-3 rounded-lg border p-3 text-sm shadow-lg", styles[item.variant])}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 flex-shrink-0", item.variant === "success" ? "text-green-600" : item.variant === "error" ? "text-red-600" : "text-blue-600")} />
            <div className="flex-1">
              <p className="whitespace-pre-line">{item.message}</p>
              {item.action && (
                <a href={`#${item.action.href}`} onClick={() => dismiss(item.id)} className="mt-1 inline-block font-medium underline underline-offset-2">
                  {item.action.label}
                </a>
              )}
            </div>
            <button type="button" onClick={() => dismiss(item.id)} className="-mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-gray-600" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
