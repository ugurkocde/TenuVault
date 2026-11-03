import { CIS_REMEDIATION_LIMITS } from "../../../shared/frameworks/cis-certification"

/** What TenuVault can and cannot remediate, from the shared statement, wherever remediation or readiness is shown. */
export function CisRemediationLimits({ className }: { className?: string }) {
  return <section aria-label="Limits of remediation" className={className}>
    <p className="text-sm font-medium text-gray-900">Limits of remediation</p>
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-600">{CIS_REMEDIATION_LIMITS.map(line => <li key={line}>{line}</li>)}</ul>
  </section>
}
