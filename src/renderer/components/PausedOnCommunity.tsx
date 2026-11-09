import { Link } from "react-router-dom"

export function PausedOnCommunity() {
  return <div role="status" className="rounded-2xl bg-amber-50 px-5 py-4 text-sm text-amber-900"><p className="font-medium">Paused on Community</p><p>Your saved configuration is kept. <Link className="underline" to="/license">Add a license</Link> to resume.</p></div>
}
