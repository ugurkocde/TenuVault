import { createContext, useContext, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { feedbackPageLabel, type FeedbackSnapshot } from "../../shared/feedback"
import { bridge } from "../lib/bridge"
import { FeedbackDialog } from "./FeedbackDialog"

const OpenFeedbackContext = createContext<(() => Promise<void>) | null>(null)

/** Null outside the host, so a form never offers an unavailable action. */
export const useOpenFeedback = () => useContext(OpenFeedbackContext)

export function FeedbackProvider({ children, onOpenSupport }: { children: ReactNode; onOpenSupport: () => void }) {
  const { pathname } = useLocation()
  const [feedback, setFeedback] = useState<{ open: boolean; snapshot: FeedbackSnapshot | null }>({ open: false, snapshot: null })
  const capturing = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const openFeedback = async () => {
    if (capturing.current || feedback.open) return
    capturing.current = true
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Capture before opening, using only the existing page label and snapshot contract.
    const snapshot = await bridge.feedback.capture(feedbackPageLabel(pathname)).catch(() => null)
    capturing.current = false
    setFeedback({ open: true, snapshot })
  }
  return (
    <OpenFeedbackContext.Provider value={openFeedback}>
      {children}
      <FeedbackDialog
        open={feedback.open}
        onOpenChange={(open) => setFeedback((current) => ({ open, snapshot: open ? current.snapshot : null }))}
        snapshot={feedback.snapshot}
        onOpenSupport={onOpenSupport}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus()
          }
        }}
      />
    </OpenFeedbackContext.Provider>
  )
}
