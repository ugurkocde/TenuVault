import { Fragment } from "react"
import { Link } from "react-router-dom"
import { SERVICES_HREF, SERVICES_PAGE } from "../../shared/services/modules"

/**
 * A backup or restore message with "Services and permissions" linked to that Settings card, so a type
 * left out or a restore stopped for a missing permission leads straight to the fix.
 */
export function LinkedMessage({ text }: { text: string }) {
  const parts = text.split(SERVICES_PAGE)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <Link to={SERVICES_HREF} className="font-medium underline underline-offset-2">{SERVICES_PAGE}</Link> : null}
        </Fragment>
      ))}
    </>
  )
}
