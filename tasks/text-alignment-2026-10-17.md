# Text positioning audit and fixes (2026-10-17)

Branch fix/text-alignment from origin/main (5a5935e). The main checkout is 15 commits behind origin and carries unrelated uncommitted work, so this worktree keeps both untouched.

## Root cause

src/portal/styles/globals.css applies `min-height: 44px` to every button, link, input, select and textarea (a mobile touch target rule from the web template). Components that set a height (h-8, h-9, h-10, size-9, size-10) keep that height property but the global minimum wins, so on the desktop app:

- size-9 icon buttons render 36px wide and 44px tall (vertical ovals, visibly protruding in the tenants view toggle and dialog close buttons)
- small, default and large buttons all render 44px tall
- block links with symmetric vertical padding (framework sidebar subrows) become 44px tall with text glued to the top
- plain icon buttons (toast dismiss) inflate their containers and sit off the text line
- checkboxes needed `min-h-0` workarounds in more than ten places

Fix: apply the 44px minimum only on coarse pointers, where the touch target intent applies. The desktop app gets the heights each component declares.

## Acceptance criteria

1. On a fine pointer, no button, link, input, select or textarea renders taller than its declared height class; size-9 and size-10 icon buttons are square in screenshots.
2. Segmented controls (Backup and Restore tabs, tenants grid/list toggle) show the active pill inset evenly from the container on every side, and the toggle aligns in height with the adjacent search input.
3. Dialog titles and descriptions never run under the absolute close button (Connect a tenant dialog shows this today).
4. Toast height fits its content; the icon, the first text line and the dismiss button share one optical line.
5. Dashboard tile row two shares one header rhythm: the Successful backups and Drift labels and big values sit on the same lines, and the Failed/Running/Scheduled labels keep clear space from their box borders.
6. Framework sidebar subrows center their text vertically and match the 40px main nav rhythm for single-line entries.
7. The tenant card status dot is vertically centered on the Selected row.
8. Typecheck, lint, tests and build pass; smoke screenshots are re-captured and inspected; no new smoke failures against the clean origin/main baseline (2 failures on the baseline run: license agreement from settings, settings sidebar section switching; to be rechecked for flakiness).

## Audit method

- Built origin/main, ran scripts/smoke.mjs to out/audit-smoke (61 screenshots), inspected every distinct screen and zoomed crops of the dashboard, tenants, settings and dialogs.
- Three independent read-only code audits (UI primitives, renderer shell and pages, portal pages and features) ranked by severity; findings cross-checked against screenshots before fixing.
- Screens confirmed clean on visual inspection: welcome, license, dashboard empty state, overview stat and tenant cards, OIB entry cards, framework catalog cards, governance hub, onboarding steps, backup progress dialog.

## Checked and left as intentional

- Focal Success Rate tile label sits in the icon row position: the dark focal tile is a distinct composition with the ring as its body, unlike the white stat tiles.
- Recent Activity and Quick Actions use h2 section headers, a different pattern from stat tile labels, so no shared baseline is expected.
- Tenant card status dot at top-6: its center (28px) matches the select row center (pt-4 plus half of the remaining min-h-10 box).
- Drift empty state alert: single line is optically centered (icon center 28px, text center 30px in a 60px bar).
- Catalog card monogram and arrow use items-start, matching the dashboard tile icon and chip pattern.
- FrameworkCard chip group: the row already uses items-center, so chips center against two-line labels.
- Drift value pills are flex items, so their padding does not overlap adjacent lines.
- Backup timeline icon mt-4 aligns the icon top with the card content top (p-4), correct for a top-anchored timeline.
- add-tenant-modal-redesigned.tsx is replaced on desktop by src/renderer/overrides/add-tenant-modal.tsx, so its findings do not ship.

## Review

- Gates on the final tree: typecheck clean, lint 0 errors (6 pre-existing warnings), 2780 tests in 218 files pass (full suite at default parallelism flakes on this machine with worker timeouts; every failing file passes on rerun and the suite passes whole with four workers), build clean, all smoke checks pass with before and after screenshots inspected (dashboard tiles, tenants toggle, backup tabs, dialog, toast, sidebar subrows, governance pills, onboarding steps).
- scripts/marketing-shots.mjs stops at the dashboard drift assertion ("Last comparison of backups") on clean origin/main as well as on this branch, verified by stash, rebuild and rerun. Pre-existing, unrelated to this change; the failure screenshot itself shows the demo dashboard aligned correctly.
- New regression test test/text-alignment-css.test.ts pins the coarse-pointer scoping and the dialog header clearance.
