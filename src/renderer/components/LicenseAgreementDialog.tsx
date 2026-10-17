import { useState } from "react"
import { ExternalLink } from "lucide-react"
import eula from "../../../EULA.txt?raw"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog"
import { TERMS_URL } from "../../shared/constants"
import { bridge } from "../lib/bridge"

/**
 * A text link that opens the end user license agreement this build ships with, the same text the
 * installers show. The link is the dialog trigger, so focus returns to it when the dialog closes.
 */
export function LicenseAgreementLink({ label = "License agreement", active = true }: { label?: string; active?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={active && open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="text-blue-600 hover:underline">
          {label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>License agreement</DialogTitle>
          <DialogDescription>
            Official TenuVault builds are licensed under this agreement. The TenuVault Terms of Use also apply.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-2xl border border-gray-200 bg-gray-50 p-4 font-mono text-xs leading-relaxed text-gray-800">
          {eula}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => void bridge.app.openExternal(TERMS_URL)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Terms of Use
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
