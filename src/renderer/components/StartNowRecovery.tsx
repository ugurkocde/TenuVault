import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { GRAPH_CLI_BROWSER_SIGN_IN_MESSAGE } from "../../shared/tenant-connection"
import { bridge } from "../lib/bridge"
import { toast } from "../lib/toast"

export function StartNowRecovery({ onRetry, className, buttonClassName, centered, tenantName }: {
  onRetry: () => void
  className?: string
  buttonClassName?: string
  centered?: boolean
  tenantName?: string
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p role="status" className="text-sm text-muted-foreground">
        {tenantName && <span className="font-medium">{tenantName}: </span>}
        {GRAPH_CLI_BROWSER_SIGN_IN_MESSAGE}
      </p>
      <div className={cn("flex flex-wrap items-center gap-3", centered && "flex-col")}>
        <Button className={buttonClassName} onClick={() => {
          void bridge.app.openExternal("https://intune.microsoft.com").catch(() => toast("Could not open Microsoft sign-in.", "error"))
        }}>Open Microsoft sign-in</Button>
        <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={onRetry}>Try again</button>
      </div>
    </div>
  )
}
