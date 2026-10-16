# SEO audit: ranking for Intune backup, Intune restore, Intune disaster recovery

Date: 2026-10-17. Scope: www.tenuvault.com (live, separate Next.js repo), docs.tenuvault.com (this repo, `docs-site/`), and the GitHub repository README. Method: live fetches of titles, descriptions, canonicals, headings, JSON-LD counts, robots.txt and sitemaps; source review of every docs page frontmatter and word count; web searches for the three target phrases and the competitor set. No Google Search Console, GA4, CrUX or backlink-tool data was available, so current positions, impressions and referring domains could not be measured. Anything that needs that data is marked as unverified below.

## The honest headline

No on-page change can guarantee position 1, 2 or 3, and anyone who promises that is selling something. The three target pages on www are already well built. The gap to the top three is mostly authority: the product launched in October 2026, the GitHub repo has 4 stars against 452 for the leading open-source Intune backup script, and the competitor set includes Veeam, AvePoint and CoreView. Realistic expectation with the plan in [ACTION-PLAN.md](ACTION-PLAN.md) executed in full: top 10 for the three head terms in 3 to 6 months, top 3 first for the long-tail variants ("restore deleted Intune policy", "does Intune have backup", "Intune disaster recovery plan"), head-term top 3 after that if backlinks and brand search follow. This pull request fixes everything that is fixable inside this repo. The www and off-page work is specified so it can be executed without re-auditing.

## Score (docs and www combined)

| Category | Weight | Score | Basis |
| --- | --- | --- | --- |
| Technical SEO | 22% | 78 | Canonicals, sitemaps, robots and redirects correct. Docs root redirects to Getting started. Homepage HTML is 179 KB. |
| Content quality | 23% | 70 | Strong docs depth (37 pages, several over 2,000 words). Thin pages: tenants (132 words), audit log (193), requirements (236). No comparison pages. |
| On-page SEO | 20% | 74 before this PR, 84 after | www titles carry the exact phrases. Docs pillar titles did not ("Run a backup", "Restore items", "Disaster recovery") and docs linked to the www pillars almost nowhere. Both fixed here. |
| Schema | 10% | 82 | www emits 4 to 8 JSON-LD blocks per page. Docs emit TechArticle, BreadcrumbList and FAQPage where defined. This PR adds author, image and a SoftwareApplication block. |
| Performance | 10% | Unverified | No Lighthouse or CrUX run in this audit. Run before and after the www changes. |
| AI search readiness | 10% | 76 | llms.txt, llms-small.txt and llms-full.txt exist on docs. Definition-first paragraphs and FAQs added here improve citability. |
| Images | 5% | 60 | README icon had empty alt text (fixed). Docs carry few screenshots, so image search and rich snippets have little to work with. |

Weighted overall, performance excluded and renormalized: about 75. Off-page authority is outside this scoring model and is currently the weakest factor of all.

## Keyword to URL map (one owner per phrase)

This is the anti-cannibalization contract. www owns commercial intent, docs own task intent, GitHub owns "github" modifiers. Every other page links to the owner with the exact phrase as anchor text and never uses the phrase as its own title.

| Phrase | Owner URL | Supporting pages |
| --- | --- | --- |
| Intune backup | https://www.tenuvault.com/intune-backup | docs /backups/, /backups/coverage/, /backups/schedules/, /backups/storage/; www /guides/intune-backup-setup |
| Intune restore | https://www.tenuvault.com/intune-restore | docs /restore/, /restore/modes/, /restore/limitations/; www /guides/restore-deleted-intune-policy, /guides/roll-back-intune-policy-change |
| Intune disaster recovery | https://www.tenuvault.com/intune-disaster-recovery | docs /restore/disaster-recovery/; www /guides/intune-restore-drill |
| Does Intune have backup | https://www.tenuvault.com/guides/does-intune-have-backup | docs /backups/ FAQ |
| Intune backup github / open source | https://github.com/ugurkocde/TenuVault | README pillar links |

Search intent warning: "Intune backup" also matches Windows Backup for Organizations (end-user settings backup) in Microsoft documentation. The existing www guide /guides/intune-backup-vs-windows-backup-for-organizations is the right disambiguation asset. Keep it linked from the backup pillar.

## What the live audit found

### www.tenuvault.com (not in this repo)

Strengths, verified by fetch on 2026-10-17:

* Titles already target the phrases: homepage "Intune Backup and Restore for Windows and macOS", /intune-backup "Intune Backup Tool: Back Up and Restore Policies", /intune-restore, /intune-disaster-recovery "Intune Disaster Recovery Plan: Checklist", plus six guides including does-intune-have-backup and restore-deleted-intune-policy.
* Canonicals self-reference correctly, sitemap.xml lists 26 URLs with lastmod dates, robots.txt allows everything except /api/ and lists both sitemaps.
* JSON-LD on every checked page (4 blocks on the homepage, 8 on the pillars).

Gaps, specified for the www repo in the action plan:

* Homepage response is 179 KB of HTML with heavy client JS. Performance unverified, likely the biggest technical risk to Core Web Vitals.
* No comparison or alternative pages ("TenuVault vs PowerShell scripts", "Intune backup tools compared"), which is where commercial-intent searches with winnable difficulty sit.
* No video. A two minute backup and restore walkthrough is the cheapest way into video results and YouTube search for the same phrases.
* Freshness: sitemap lastmod clusters on 2026-10-03 and 2026-10-04. Update pillars monthly with a visible "last updated" date and real content changes.

### docs.tenuvault.com (this repo, fixed in this PR)

* Pillar titles missed the phrases entirely and competed weakly with www instead of supporting it. Retitled with slugs unchanged: "Intune backup: run a backup", "Intune restore: restore items from a backup", "Intune disaster recovery", "Get started: your first Intune backup". Sidebar labels are explicit in astro.config.mjs, so navigation text does not change.
* Docs linked to the www pillars and guides zero times with keyword anchors. Twenty contextual links added across twelve pages, one relevant link per page.
* FAQPage schema existed on only 3 of 37 pages. FAQs added to the backup and restore pillars. Note: Google restricts FAQ rich results to government and healthcare sites since 2023, so expect value through on-page answers and AI citation, not rich results. Visible text and JSON-LD are generated from the same frontmatter, so they cannot drift.
* TechArticle schema lacked author and image, and no SoftwareApplication block existed on docs. Both added, without aggregateRating because there is no published review count to cite. Invented ratings risk a manual action.
* robots.txt allowed all crawlers but named none. AI search crawlers are now allowed explicitly, matching the existing llms.txt investment.

### GitHub (fixed in this PR, plus one manual step)

* The README already ranks: it appeared first in this audit's web search for native Intune backup questions. But it linked to none of the three pillar pages. Pillar links with exact anchors added in the header nav and feature list, the H1 now carries the three phrases, and the icon alt text is no longer empty.
* Repo topics already include intune-backup, microsoft-intune and microsoft-graph. Manual step in the action plan: add intune-restore and disaster-recovery topics if GitHub accepts them, and pin the repo on the owner profile.

## Competitor set for the three phrases

| Competitor | Why they rank | TenuVault counter |
| --- | --- | --- |
| Veeam Data Cloud | Entra ID backup with Intune policy restore, huge domain authority | Desktop, delegated sign-in, no third-party cloud copy of tenant config. Comparison page. |
| AvePoint | Microsoft 365 backup suite, enterprise backlinks | Same counter as Veeam, plus price transparency. |
| CoreView (Simeon Cloud) | Configuration manager across Microsoft 365 workloads | Intune depth (39 object types with assignments), OpenIntuneBaseline. |
| Nerdio | Intune policy backup inside an MSP platform | Standalone desktop app, per-tenant licensing. |
| SDM Software free tool | Press-release syndication, October 2026 | Schedules, encryption, Azure storage, drift, macOS. |
| jseerden/IntuneBackupAndRestore (452 stars), Micke-K/IntuneManagement | GitHub authority and years of inbound links | "Scripts vs app" guide. Honest about when a script is enough. |

## E-E-A-T notes

* Experience: the docs are specific and operational (exact UI labels, error strings, plan limits), which is the strongest experience signal on the site. Keep screenshots current.
* Expertise: author identity exists on www (meta author Ugur Koc). Add an author page with Microsoft-community credentials and link it from guides.
* Authority: CIS SecureSuite membership badge is in the www footer. Third-party listings (G2, Capterra, Microsoft AppSource if eligible) and Intune community mentions are missing and are in the action plan.
* Trust: the honest limitations pages (what cannot be restored, what Graph does not export) help rather than hurt. Do not dilute them for keywords.
