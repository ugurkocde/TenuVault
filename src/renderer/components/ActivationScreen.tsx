import { useState } from "react"
import { AlertCircle, Building2, ExternalLink, KeyRound, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { bridge } from "../lib/bridge"
import { useLicense } from "../lib/license"
import { BrandMark } from "./BrandMark"

/**
 * First run welcome, shown instead of the app while this machine has no license key, no
 * tenant licensed through its organization and no connected tenant.
 *
 * Licensing is per tenant and enforced in the main process, so this screen is a guide,
 * not a lock: without a key the first tenant runs on Community, and a license shared by
 * the tenant's organization is checked at the tenant sign-in.
 */
export function ActivationScreen({ onSignIn }: { onSignIn: () => void }) {
  const { refresh } = useLicense()
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const activate = async () => {
    setBusy(true)
    setError("")
    try {
      await bridge.license.setKey(key.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6 rounded-3xl bg-card p-9 shadow-[0_24px_60px_-30px_rgba(22,21,20,0.25)]">
        <div className="flex items-center gap-3">
          <BrandMark className="size-12" />
          <div>
            <h1 className="text-3xl font-medium tracking-tight text-gray-900">Welcome to TenuVault</h1>
            <p className="text-base text-gray-500">TenuVault Desktop</p>
          </div>
        </div>
        <p className="text-sm text-gray-600">
          Sign in to your tenant to start. Community is free for one tenant, with manual and weekly backups. If your
          organization shares a TenuVault license with your tenant, it is picked up when you sign in.
        </p>

        <div className="space-y-3">
          <Button size="lg" className="w-full bg-blue-600 text-white hover:bg-blue-700" onClick={onSignIn}>
            <Building2 className="mr-2 h-4 w-4" /> Start free with Community
          </Button>
          <Button variant="outline" size="lg" className="w-full" onClick={() => void bridge.license.open("buy")}>
            <ExternalLink className="mr-2 h-4 w-4" /> Buy Pro or MSP
          </Button>
          <p className="text-xs text-gray-600">
            Pro and MSP come with a 30-day money-back guarantee. You can upgrade any time from the License page.
          </p>
        </div>

        <form
          className="space-y-3 border-t border-gray-100 pt-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) void activate()
          }}
        >
          <Label htmlFor="license-key">Already have a license key?</Label>
          <div className="flex gap-2">
            <Input
              id="license-key"
              placeholder="Paste the key from your email"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
            <Button type="submit" variant="outline" disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Save key
            </Button>
          </div>
          <p className="text-xs text-gray-600">The key is saved on this device and activated for your tenant when you sign in.</p>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <p className="text-center text-xs text-gray-500">
          License checks go to tenuvault.com and send the license key or your Microsoft sign-in token, the tenant ID and a
          random installation ID. Tenant configuration and backups are never sent.
        </p>
      </div>
    </div>
  )
}
