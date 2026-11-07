import { useState } from "react"
import { Check, CheckCircle2, Copy, Loader2, TriangleAlert } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { toast } from "../../lib/toast"
import { notificationsApi, type WatcherDeployView } from "./api"

const VARIABLE_NAMES: Record<string, string> = {
  teams: "TenuVaultTeamsWebhookUrl",
  webhook: "TenuVaultWebhookUrl (and TenuVaultWebhookSecret for signed posts)",
  mail: "TenuVaultMailSender and TenuVaultMailRecipients",
}

/**
 * The live state of one in-app watcher setup: its steps, the one admin action it may be
 * waiting for, and Continue or Stop. The setup itself runs in the main process, so this
 * panel can close and reopen without losing it.
 */
export function WatcherDeployProgress({ tenant, job, onJob, onChanged }: {
  tenant: Tenant
  job: WatcherDeployView
  onJob: (job: WatcherDeployView) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const act = async (key: string, run: () => Promise<{ job: WatcherDeployView }>) => {
    setBusy(key)
    try {
      const result = await run()
      onJob(result.job)
      onChanged()
    } catch (error) {
      toast(error instanceof Error ? error.message : "The Azure watcher setup could not continue.", "error")
    } finally {
      setBusy(null)
    }
  }
  const copySnippet = async () => {
    if (!job.grantSnippet) return
    try {
      await navigator.clipboard.writeText(job.grantSnippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      toast(`Copying failed: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  }
  const blocked = job.state === "blocked" || job.state === "failed" || job.state === "interrupted"
  const findings = job.findings.filter((finding) => finding.severity !== "info")
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm text-gray-800">
        {job.state === "complete"
          ? "The Azure watcher ran these alerts cleanly and has taken over while this computer is off."
          : job.mode === "create"
            ? `Creating ${job.plan.automationAccountName} in ${job.plan.resourceGroupName}, then proving it works before anything hands over.`
            : `Checking ${job.plan.automationAccountName} in ${job.plan.resourceGroupName}. Nothing hands over until a clean run proves it works.`}
      </p>
      <ol className="space-y-1.5 text-sm" aria-label="Azure watcher setup steps">
        {job.steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2">
            {step.status === "done"
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700" aria-hidden="true" />
              : step.status === "running"
                ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
                : step.status === "blocked" || step.status === "failed"
                  ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                  : <span className="mt-0.5 size-4 shrink-0 rounded-full border border-gray-300" aria-hidden="true" />}
            <span className="text-gray-800">
              <span className="font-medium text-gray-900">{step.label}</span>
              {step.detail && <span className="text-gray-700">: {step.detail}</span>}
              {step.status === "skipped" && <span className="text-gray-600"> (not needed)</span>}
            </span>
          </li>
        ))}
      </ol>

      {findings.length > 0 && (
        <ul className="space-y-1.5 text-sm" aria-label="Azure checks">
          {findings.slice(0, 5).map((finding) => (
            <li key={`${finding.code}-${finding.message}`} className={`flex gap-2 ${finding.severity === "block" ? "text-red-700" : "text-amber-800 dark:text-amber-200"}`}>
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{finding.message}</span>
            </li>
          ))}
        </ul>
      )}

      {job.blockedReason === "needs-admin" && (
        <div className="space-y-2">
          <p className="text-sm text-gray-800">
            The watcher identity{job.principalId ? <> (<code className="font-mono text-xs">{job.principalId}</code>)</> : ""} needs {job.graphRoles.join(", ")}.
            A Global Administrator or Privileged Role Administrator runs this once, then confirm here. Nothing has been handed over.
          </p>
          {job.grantSnippet && (
            <>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary px-3 py-2 font-mono text-xs">{job.grantSnippet}</pre>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copySnippet()}>
                  {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                  {copied ? "Copied" : "Copy commands"}
                </Button>
                {!job.ack.grantRoles && (
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("grant", () => notificationsApi.watcherDeployConfirm(tenant, job.id, "grant"))}>
                    Assign them from this sign-in
                  </Button>
                )}
                <Button type="button" size="sm" disabled={busy !== null} onClick={() => void act("roles", () => notificationsApi.watcherDeployConfirm(tenant, job.id, "roles"))}>
                  Roles are assigned, check again
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {job.blockedReason === "needs-destination" && (
        <div className="space-y-2">
          <p className="text-sm text-gray-800">
            Set {job.plan.destinationKinds.map((kind) => VARIABLE_NAMES[kind]).join(" and ")} on the Automation account
            {job.plan.destinationKinds.includes("mail") ? ", and finish the one-time mail verification, " : " "}
            then confirm. A watcher without a destination runs but delivers nothing, so nothing has been handed over.
          </p>
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void act("destination", () => notificationsApi.watcherDeployConfirm(tenant, job.id, "destination"))}>
            Destination is set, check again
          </Button>
        </div>
      )}

      {blocked && job.blockedReason !== "needs-admin" && job.blockedReason !== "needs-destination" && (
        <div className="space-y-2">
          {job.error && <p className="text-sm text-red-700" role="alert">{job.error}</p>}
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void act("resume", () => notificationsApi.watcherDeployResume(tenant, job.id))}>
            {job.blockedReason === "roles-not-effective" || job.blockedReason === "waiting-heartbeat" || job.blockedReason === "test-timeout" ? "Check again" : "Continue setup"}
          </Button>
        </div>
      )}

      {job.state !== "complete" && job.state !== "cancelled" && (
        <div className="flex flex-wrap items-center gap-2">
          {job.state === "running" && <span className="text-sm text-gray-600">You can close this. The setup keeps running and this card stays on the Alerts tab.</span>}
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act("cancel", () => notificationsApi.revokeWatcherDeploy(tenant, job.id))}>
            Stop setup
          </Button>
        </div>
      )}
      {job.state === "cancelled" && <p className="text-sm text-gray-700">Stopped. Anything already created in Azure was left in place, and this computer still watches.{job.alertsHash ? " These alerts were already sent to the watcher, so it can also send them on its schedule until you finish this setup or update it in Azure." : ""}</p>}
    </div>
  )
}
