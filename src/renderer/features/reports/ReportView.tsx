import { Chip } from "~/components/dashboard/tiles"
import { activityLine, changeLabel, reportTime, summaryLine, type ChangeReport, type ReportItem } from "../../../shared/reports/change-report"

const CHANGE_TONE = { added: "success", modified: "warning", deleted: "danger" } as const

/** A stored change report as the app shows it: the same sections and wording as the PDF. */
export function ReportView({ report }: { report: ChangeReport }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm text-gray-700">
        <p>{summaryLine(report)}</p>
        <p className="text-xs text-gray-500">
          From {report.from.id} ({reportTime(report.from.timestamp)}) to {report.to.id} ({reportTime(report.to.timestamp)}). Generated {reportTime(report.generatedAt)}
          {report.trigger === "scheduled" ? " after a scheduled backup" : ""}.
        </p>
      </div>
      {report.audit.note && (
        <p role="status" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {report.audit.status === "included" ? "Part of the audit log was not read. " : "Who made the changes is unknown. "}
          {report.audit.note}
        </p>
      )}
      {!report.values && <p className="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-700">Setting values are left out of this report.</p>}
      {report.items.length === 0 && <p className="text-sm text-gray-600">No items were added, changed or deleted between the two backups.</p>}
      {(["deleted", "modified", "added"] as const).map((change) => {
        const items = report.items.filter((item) => item.change === change)
        if (!items.length) return null
        return (
          <section key={change} aria-label={`${changeLabel(change)} items`} className="space-y-3">
            <h4 className="text-base font-medium text-gray-900">
              {changeLabel(change)} ({items.length})
            </h4>
            {items.map((item, index) => (
              <Item key={`${item.id}:${index}`} item={item} report={report} />
            ))}
          </section>
        )
      })}
      {report.otherActivity.length > 0 && (
        <section aria-label="Other activity" className="space-y-2">
          <h4 className="text-base font-medium text-gray-900">Other activity ({report.otherActivity.length + report.moreActivity})</h4>
          <p className="text-xs text-gray-500">Audit events in this window that match no item above, for example a change that was undone before the second backup.</p>
          <ul className="space-y-1 text-sm text-gray-700">
            {report.otherActivity.map((event, index) => (
              <li key={`${event.at}:${index}`}>
                {event.target ? <span className="font-medium">{event.target}: </span> : null}
                {activityLine(event)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {report.warnings.length > 0 && (
        <section aria-label="Not compared" className="space-y-1">
          <h4 className="text-base font-medium text-gray-900">Not compared</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
            {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}

function Item({ item, report }: { item: ReportItem; report: ChangeReport }) {
  const value = (text: string | null) => (text === null || text === "Not set" ? <span className="italic text-gray-400">Not set</span> : text)
  return (
    <div className="rounded-2xl border border-gray-100 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words font-medium text-gray-900">{item.name}</p>
        <Chip tone={CHANGE_TONE[item.change]}>{changeLabel(item.change)}</Chip>
        <Chip>{item.type}</Chip>
        {item.severity !== "info" && <Chip tone={item.severity === "critical" ? "danger" : "warning"}>{item.severity === "critical" ? "Critical" : "Warning"}</Chip>}
      </div>
      {item.previousName && <p className="mt-1 text-xs text-gray-500">Previously named {item.previousName}</p>}
      {item.activity.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-sm text-gray-700">
          {item.activity.map((event, index) => <li key={`${event.at}:${index}`}>{activityLine(event)}</li>)}
        </ul>
      ) : report.audit.status === "included" ? (
        <p className="mt-2 text-sm italic text-gray-500">No matching audit event in this window.</p>
      ) : null}
      {item.settings.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-2/5 pb-1 pr-3 font-medium">Setting</th>
                {report.values && item.change === "modified" && <><th className="pb-1 pr-3 font-medium">Before</th><th className="pb-1 font-medium">After</th></>}
                {report.values && item.change !== "modified" && <th className="pb-1 font-medium">Value</th>}
              </tr>
            </thead>
            <tbody>
              {item.settings.map((setting, index) => (
                <tr key={`${setting.path}:${index}`} className="border-t border-gray-100 align-top">
                  <td className="break-words py-1.5 pr-3 text-gray-900" title={setting.path}>{setting.name}</td>
                  {report.values && item.change === "modified" && (
                    <>
                      <td className="break-words py-1.5 pr-3 text-red-700">{value(setting.before)}</td>
                      <td className="break-words py-1.5 text-green-700">{value(setting.after)}</td>
                    </>
                  )}
                  {report.values && item.change !== "modified" && <td className="break-words py-1.5 text-gray-700">{value(item.change === "added" ? setting.after : setting.before)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {item.moreSettings > 0 && <p className="mt-1 text-xs text-gray-500">{item.moreSettings} more settings are not listed.</p>}
        </div>
      )}
      {item.restoreFrom && <p className="mt-2 text-xs text-gray-500">The previous version is in backup {item.restoreFrom}.</p>}
    </div>
  )
}
