import { Link } from "react-router-dom"
import { ArrowUpRight } from "lucide-react"
import { Button } from "~/components/ui/button"
import { formatDate } from "./api"
import type { CisScoreCard } from "./cis"

export const CIS_CARD_NOTE = "CIS checks configuration: settings in unassigned policies count as present. The framework scores above check assigned coverage, so unassigned policies do not count there."

/** One saved CIS benchmark with the same headline rate as the CIS page, linking to it. */
export function CisCard({ card }: { card: CisScoreCard }) {
  return (
    <section aria-label={`${card.title} readiness`} className="flex flex-col gap-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]">
      <div>
        <h3 className="text-lg font-medium text-gray-900">{card.title}</h3>
        <p className="text-sm text-gray-500">CIS Benchmarks{card.version ? `, version ${card.version}` : ""}. Newest saved assessment, {formatDate(card.assessedAt)}.</p>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {card.levels.map((level) => (
          <div key={level.level}>
            <p className="text-sm text-gray-500">Level {level.level} {level.label.toLowerCase()}</p>
            <p className="text-gray-900 tabular-nums">
              <span className="text-4xl font-light tracking-tight">{level.rate === null ? "Not available" : `${level.rate}%`}</span>
            </p>
            {level.withExclusions !== null && <p className="text-sm text-gray-700">{level.withExclusions}<span className="block text-xs text-gray-500">Exclusions as of {formatDate(`${level.exclusionsAsOf}T00:00:00`)}</span></p>}
          </div>
        ))}
        {card.levels.length === 0 && <p className="text-sm text-gray-600">No Level could be read from this assessment.</p>}
      </div>
      <p className="text-xs text-gray-500">{CIS_CARD_NOTE}</p>
      <div className="mt-auto">
        <Button asChild variant="ghost" size="sm">
          <Link to="/portal/frameworks/cis-benchmarks">
            Open CIS Benchmarks
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  )
}
