import { useEffect, useRef, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import type { UpdateStatus } from "../../shared/ipc"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"
import { cn } from "~/lib/utils"

/**
 * Green label at the bottom of the sidebar, shown while an update downloads
 * and once it is ready. Pressing it installs the update: right away when the
 * download has finished, otherwise as soon as it completes. The main process
 * already follows the channel of the nightly preference, so the version
 * offered here is the stable or nightly build the admin opted into.
 */
export function UpdateSidebarLabel() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" })
  const [installRequested, setInstallRequested] = useState(false)
  const installStarted = useRef(false)
  // Identifies the current install call, so a late rejection of an earlier
  // press cannot clear or toast over a newer one.
  const installAttempt = useRef(0)

  useEffect(() => {
    void bridge.updates.status().then(setStatus).catch(() => undefined)
    return bridge.updates.onChanged(setStatus)
  }, [])

  useEffect(() => {
    if (!installRequested) return
    if (status.state === "ready") {
      if (installStarted.current) return
      installStarted.current = true
      const attempt = ++installAttempt.current
      void bridge.updates.install().catch((error: unknown) => {
        // An error status for the same failure already handled this press.
        if (installAttempt.current !== attempt) return
        installStarted.current = false
        setInstallRequested(false)
        toast(error instanceof Error ? error.message : "Could not install the update.", "error")
      })
    } else if (status.state === "error") {
      installAttempt.current += 1
      installStarted.current = false
      setInstallRequested(false)
      toast(`Update failed: ${status.message}`, "error")
    } else if (status.state !== "downloading") {
      // The pending update went away, for example after a channel change.
      installAttempt.current += 1
      installStarted.current = false
      setInstallRequested(false)
    }
  }, [status, installRequested])

  if (status.state !== "downloading" && status.state !== "ready") return null
  const downloading = status.state === "downloading"
  const label = !installRequested ? "Update available" : downloading ? `Downloading ${status.percent}%` : "Installing update"
  // Each accessible name starts with the visible label, so speech input can target the button by what it says.
  const ariaLabel = !installRequested
    ? `Update available: download and install TenuVault ${status.version}`
    : downloading
      ? `Downloading ${status.percent} percent. TenuVault ${status.version} installs when the download finishes.`
      : `Installing update: TenuVault ${status.version}`
  return (
    <button
      type="button"
      // aria-disabled instead of disabled, so pressing it does not drop keyboard focus to the body.
      aria-disabled={installRequested || undefined}
      onClick={() => {
        if (!installRequested) setInstallRequested(true)
      }}
      title={`TenuVault ${status.version}`}
      aria-label={ariaLabel}
      className={cn(
        "flex min-h-10 w-full items-center gap-3 rounded-full bg-green-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
        installRequested && "cursor-default hover:bg-green-700",
      )}
    >
      {installRequested ? (
        <Loader2 className="h-[18px] w-[18px] flex-shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
      )}
      {/* The label never shrinks; the version takes whatever width is left and truncates itself. */}
      <span className="shrink-0 whitespace-nowrap text-left">{label}</span>
      {/*
        The version shows only while unpressed and only when short, such as a stable 0.3.1.
        A nightly version like 0.3.1-nightly.20261017090000 stays in the tooltip and the
        accessible name instead, so neither the label nor the download percent can truncate.
      */}
      {!installRequested && status.version.length <= 6 && <span className="min-w-0 flex-1 truncate text-right text-[11px] text-white" aria-hidden="true">{status.version}</span>}
    </button>
  )
}
