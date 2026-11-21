import type { RefObject } from "react"

/**
 * An `onCloseAutoFocus` handler for a dialog opened without a DialogTrigger (from a menu or a button
 * elsewhere): focus goes back to the element in `target` while it is still in the page. Otherwise the
 * dialog's default applies.
 */
export function returnFocusTo(target: RefObject<HTMLElement | null> | undefined) {
  return (event: Event) => {
    const element = target?.current
    if (!element?.isConnected) return
    event.preventDefault()
    element.focus()
  }
}
