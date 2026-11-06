import { useEffect, useId, useState, type FormEvent } from "react"
import { Network } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Checkbox } from "~/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import type { ProxySignInPrompt } from "../../shared/ipc"
import { bridge } from "../lib/bridge"

/**
 * Asks for the credentials of a proxy that requires authentication (HTTP 407). The main process
 * raises one prompt per proxy and holds every request for that proxy until it is answered, so
 * this shows the oldest open prompt; it is mounted outside the license gate because licensing
 * itself may wait for it.
 */
export function ProxySignInHost() {
  const [prompts, setPrompts] = useState<ProxySignInPrompt[]>([])
  useEffect(() => {
    let current = true
    const unsubscribe = bridge.proxy.onPrompts((next) => setPrompts(next))
    bridge.proxy.pending().then((next) => current && setPrompts(next), () => undefined)
    return () => {
      current = false
      unsubscribe()
    }
  }, [])
  const prompt = prompts[0] ?? null
  return (
    <Dialog open={!!prompt}>
      {prompt && <ProxySignInForm key={prompt.id} prompt={prompt} />}
    </Dialog>
  )
}

function ProxySignInForm({ prompt }: { prompt: ProxySignInPrompt }) {
  const id = useId()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [remember, setRemember] = useState(true)
  const [sending, setSending] = useState(false)
  const answer = (value: Parameters<typeof bridge.proxy.answer>[1]) => {
    setSending(true)
    void bridge.proxy.answer(prompt.id, value).catch(() => setSending(false))
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (username.trim()) answer({ username: username.trim(), password, remember })
  }
  return (
    <DialogContent
      hideClose
      className="sm:max-w-md"
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        if (!sending) answer(null)
      }}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <form onSubmit={submit} className="space-y-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-5 w-5 text-blue-600" aria-hidden="true" />
            Proxy sign-in required
          </DialogTitle>
          <DialogDescription>
            The proxy <strong className="text-gray-900 dark:text-gray-100">{prompt.proxy}</strong> asks TenuVault to sign in
            before it connects to Microsoft and the licensing service. Use the account your organization gave you for this proxy.
          </DialogDescription>
        </DialogHeader>
        {prompt.rejected && (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            The proxy did not accept the user name or password. Check them and try again.
          </p>
        )}
        <div className="space-y-3">
          <label className="block space-y-1 text-sm font-medium text-gray-700" htmlFor={`${id}-user`}>
            <span>User name</span>
            <Input id={`${id}-user`} autoFocus autoComplete="username" value={username} disabled={sending} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="block space-y-1 text-sm font-medium text-gray-700" htmlFor={`${id}-password`}>
            <span>Password</span>
            <Input id={`${id}-password`} type="password" autoComplete="current-password" value={password} disabled={sending} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <Checkbox className="mt-0.5" checked={remember} disabled={sending} onCheckedChange={(checked) => setRemember(checked === true)} />
            <span>
              Remember on this computer
              <span className="block text-xs text-gray-500">
                {prompt.persistent
                  ? "Saved encrypted for your Windows or macOS account. Forget it in Settings > Sign-in."
                  : "Operating system encryption is not available, so it is kept only until TenuVault quits."}
              </span>
            </span>
          </label>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={sending} onClick={() => answer(null)}>Cancel</Button>
          <Button type="submit" disabled={sending || !username.trim()}>{sending ? "Signing in" : "Sign in"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
