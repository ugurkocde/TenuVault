"use client"

import { useCallback, useRef, useState, type ReactNode } from "react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"

export type ConfirmOptions = {
  title: string
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

/**
 * The one shared confirmation dialog. It uses the Radix dialog, so Escape closes it,
 * focus stays inside while it is open, and focus returns to the control that opened it.
 */
export function ConfirmDialog({ request, onResolve }: { request: (ConfirmOptions & { id: number }) | null; onResolve: (confirmed: boolean) => void }) {
  if (!request) return null
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onResolve(false) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>{request.description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onResolve(false)}>{request.cancelLabel ?? "Cancel"}</Button>
          <Button type="button" variant={request.destructive ? "destructive" : "default"} onClick={() => onResolve(true)}>{request.confirmLabel ?? "Confirm"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Asks for confirmation and resolves true only when the admin confirms. Render confirmDialog once. */
export function useConfirm() {
  const [request, setRequest] = useState<(ConfirmOptions & { id: number }) | null>(null)
  const resolver = useRef<((confirmed: boolean) => void) | null>(null)
  const resolve = useCallback((confirmed: boolean) => {
    setRequest(null)
    resolver.current?.(confirmed)
    resolver.current = null
  }, [])
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((done) => {
    resolver.current?.(false)
    resolver.current = done
    setRequest({ ...options, id: Date.now() })
  }), [])
  return { confirm, confirmDialog: <ConfirmDialog request={request} onResolve={resolve} /> }
}
