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

/**
 * The first of several targets that is still in the page, read when the dialog closes. A dialog opened
 * from a control that has since left the page (the sidebar remounts around the guided setup) then
 * returns focus to the replacement, such as the current Help button.
 */
export function firstConnected(...targets: RefObject<HTMLElement | null>[]): RefObject<HTMLElement | null> {
  return {
    get current() {
      return targets.map((target) => target.current).find((element) => element?.isConnected) ?? null
    },
  }
}
