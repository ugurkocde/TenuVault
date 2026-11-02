# 136: Framework PDF reports and CSV/JSON exports

## What it does

Every framework report is built in the main process from a saved result, never from a fresh
Graph read:

- Native comparisons: `POST /api/frameworks` actions `native-pdf`, `native-csv`, `native-json`
  with `runId` (a saved run from `framework.native.v1.<tenant>.<framework>`). The response is the
  file; the renderer saves it where the admin chooses.
- Policy pack assessments (OIB, Microsoft, STIG, Custom): `workspace-pdf`, `workspace-csv`,
  `workspace-json` with `runId` (a saved assessment of the framework workspace). `workspace-json`
  without `runId` exports every saved assessment. The response is `{ file: { name, type,
  encoding, data } }` (PDF base64), because `/api/frameworks` answers JSON for pack actions.
- Generators: `src/shared/compliance/export.ts` (report header, CSV, JSON, redaction) and
  `src/shared/compliance/report-pdf.ts` (native and policy pack PDFs).

Each report names the tenant (ID, plus the display name the admin sees), framework, version and
profile, assessed scope, collection date, supported coverage, unknowns (unable to check, outside
scope, collection gaps, unreadable assignment evidence) and limitations. It states that it is not
an audit opinion or certification and does not prove device enforcement. Secret setting values,
secret-named properties and token-like strings are replaced with `[redacted]`.

"Export coverage and source mappings" on policy pack pages stays a renderer download: it holds
only the loaded pack's source mappings, no tenant evidence.

## Plan boundary (takes effect with the next release)

Shipped free on every plan (Community, Pro, MSP) for every framework except CIS. CIS assessments
and CIS reports (`cis-benchmarks`, `cis-controls`) need `baselineAllPlatforms` ("CIS Benchmark and
CIS Controls assessments and reports", Pro and MSP). The earlier `frameworkExports` feature was
removed. Enforcement: `requiredFeatures` in `src/main/api/plan-gates.ts`, repeated in
`authorizeFrameworkTenant` (`src/main/frameworks/native.ts`) when the authorizer reports the plan.
In the UI, non-CIS export buttons are ordinary buttons and CIS export buttons are `GatedButton`s.
Backup, drift and audit exports keep their own rules.

## Limits

- CIS Benchmarks is available on Pro and MSP (see [frameworks](../frameworks.md#cis-benchmarks)); CIS Controls stays Coming soon on every plan.
- Exports cover what the saved result recorded; a result saved before this release exports with
  the same facts, computed from the stored run.
- Tenant name in a report is a label from the renderer, validated to a short single line.

## Manual verification

1. Community tenant, open ISO/IEC 27001, run a comparison. Click PDF report, CSV and JSON. Each
   opens a save dialog; files name the tenant, framework, version, scope, collection date,
   coverage, unknowns and limitations, and contain no tokens.
2. Disconnect the network, open a saved comparison from history and export again: the export works
   and matches the saved run.
3. OpenIntuneBaseline: load the macOS pack, run a comparison, export PDF, CSV and JSON of the
   current assessment and Export JSON of a history entry and Export saved assessments.
4. Pro and MSP tenants: the same buttons behave the same.
5. Directly POST `/api/frameworks` with `{ action: "workspace-csv", frameworkId: "cis-benchmarks",
   tenantId }` for a Community tenant (DevTools fetch): 402 with the CIS upgrade message.
6. Select a second, unlicensed tenant and export a saved result: refused with the license message.
