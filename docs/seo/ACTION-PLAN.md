# SEO action plan: top 3 for Intune backup, Intune restore, Intune disaster recovery

Companion to [FULL-AUDIT-REPORT.md](FULL-AUDIT-REPORT.md). Priorities describe execution order, not ranking timelines: Critical first because nothing can be attributed without it, then High, then Medium. No position or timeline is predicted anywhere in this plan; the baseline in the Critical section decides what is realistic. Effort is rough engineering or marketing time. Items marked Done ship in the same pull request as this file.

## Done in this pull request (this repo)

| # | Action | Files |
| --- | --- | --- |
| D1 | Retitle docs pillars to carry the exact phrases, slugs unchanged, sidebar labels unchanged | backups/index.md, restore/index.md, restore/disaster-recovery.md, getting-started/index.md |
| D2 | Definition-first opening paragraphs on the three docs pillars (featured snippet and AI citation format: phrase, definition, scope, in the first 60 words) | same |
| D3 | FAQ frontmatter on the backup and restore pillars, rendered visibly and as FAQPage JSON-LD from one source | backups/index.md, restore/index.md |
| D4 | Twenty contextual links from twelve docs pages to the owning www pillar or guide, exact-phrase anchors, per the keyword map in the report | backups cluster, restore cluster, drift, first-backup |
| D5 | TechArticle gets author, image, isPartOf. Getting started (the docs home page after the root redirect) gets one SoftwareApplication block, price 0 EUR for Community, no invented ratings | src/components/Head.astro |
| D6 | robots.txt allows GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and Google-Extended explicitly | public/robots.txt |
| D7 | README: H1 carries the three phrases, pillar links in the header nav and feature bullets, icon alt text | README.md |

## Critical: measurement first (half a day, before anything else)

1. Google Search Console: verify www and docs as one Domain property. Submit both sitemaps. Record baseline average position, impressions and CTR for the three phrases and the long-tail set (restore deleted Intune policy, does Intune have backup, Intune disaster recovery plan, Intune backup tool, back up Intune policies). Without this, no later change can be attributed.
2. Bing Webmaster Tools: import from GSC. Bing feeds ChatGPT search and Copilot answers, which matter for an Intune admin audience.
3. Request indexing for the three www pillars after every material update in this plan.
4. Add a rank and GSC snapshot to a monthly note. Judge changes on 28-day windows, not days.

## High: www repo changes (the ranking pages live there)

W1. Performance. The homepage HTML is 179 KB. Run Lighthouse lab plus CrUX on /, /intune-backup, /intune-restore, /intune-disaster-recovery. Target LCP under 2.5 s, INP under 200 ms, CLS under 0.1 on mobile. Likely wins: reduce client JS on marketing pages, keep hero content server rendered, size images, font-display swap. Re-measure after.
W2. Comparison pages, one per search pattern, factual and sourced, no invented competitor claims:
   * /compare/intune-backup-tools: approaches compared (manual Graph export, open-source PowerShell, SaaS Microsoft 365 backup, TenuVault desktop). Criteria: object coverage, assignments, schedules, storage location, sign-in model, price model.
   * /compare/intune-backup-scripts-vs-app: when a script is enough and when it is not. Link the leading repos honestly; this is the page their users will share.
   * Each comparison page links down to /intune-backup and up from the pillar. Add both to sitemap.xml and the footer Use cases column.
W3. Video. Record one screen capture per pillar (backup in under two minutes, restore a deleted policy, the disaster recovery drill). Publish on YouTube with the exact phrase as the title, embed on the pillar with VideoObject JSON-LD, transcript on the page.
W4. Freshness loop. Monthly: add one real section to a pillar (new object type, new plan fact, new FAQ from support tickets), bump the visible updated date and sitemap lastmod, request indexing. Rotate through the three pillars.
W5. Internal links on www. Every guide ends with a link to its owning pillar using the exact phrase. /features and /pricing link to all three pillars in body copy, not only the footer.
W6. Author and trust. One author page (name, role, Microsoft community links, GitHub, LinkedIn) linked from every guide byline. Keep the CIS badge. Add sameAs to the Organization JSON-LD (GitHub, LinkedIn, YouTube once W3 exists).

## High: off-page authority (the suspected constraint, unproven until the baseline exists)

O1. GitHub. Add intune-restore and disaster-recovery topics if accepted. Pin the repo. Every release note links one pillar. Answer Intune backup questions in the repo Discussions and link the relevant guide. Stars follow usefulness; the 452-star script is the benchmark.
O2. Community presence, in person, no astroturfing: r/Intune, Microsoft Tech Community, Intune Discord and Slack communities. Answer "deleted a policy, help" threads with the restore-deleted-policy guide. One genuinely helpful answer outperforms ten dropped links.
O3. Listings: G2, Capterra, AlternativeTo (as an alternative to the script repos and to Microsoft 365 backup suites), Microsoft AppSource if the desktop distribution model is eligible. Consistent name, description ("Intune backup and restore desktop app for Windows and macOS") and pillar URLs everywhere.
O4. Digital PR assets that earn links from Intune bloggers: the coverage matrix (39 object types, what Graph cannot export) as a citable page, the restore drill checklist as a downloadable, and OpenIntuneBaseline release notes. Pitch the "Intune has no recycle bin" angle with the does-intune-have-backup guide as the source.
O5. Podcast and YouTube guest spots in the Intune community. One appearance usually brings a show-notes link, brand searches and the video embed for W3.

## Medium: content depth in this repo

M1. Docs bodies are already substantial (most pages 600 to 2,600 words; recount in the report). Do not pad them. Add screenshots per M2 instead, and only expand a page when support questions show a real gap.
M2. Screenshots for the three docs pillars (backup dialog, restore wizard review step, recovery readiness), named intune-backup-*, intune-restore-*, intune-disaster-recovery-* with matching alt text. This feeds image search and raises time on page.
M3. FAQ frontmatter on schedules, storage, modes and cross-tenant, sourced from real support questions. Same one-source pattern as D3.
M4. Keep llms.txt details in astro.config.mjs in sync with plan facts on www pricing. They are AI-facing canonical facts; drift there becomes wrong AI answers.

## What not to do

* Do not create a second page on docs or www that uses one of the three phrases as its title. The keyword map in the report has one owner per phrase; duplicates split the ranking between them.
* Do not buy links, use press-release syndication networks, or add aggregateRating without real reviews. All three are visible to competitors and two risk manual actions.
* Do not keyword-stuff the docs. Their specificity is the ranking asset.
* Do not promise positions to customers. Report GSC average position and impressions monthly instead.

## 90-day sequence

Weeks 1 to 2: Critical measurement. Merge this PR. W1 performance pass.
Weeks 3 to 6: W2 comparison pages, W5 internal links, O1 and O3 listings.
Weeks 7 to 10: W3 videos, O2 community cadence (two helpful answers per week), M1 and M2.
Weeks 11 to 13: W4 freshness rotation starts, O4 outreach, first 28-day GSC review against baseline. Reallocate effort to whichever pillar moved least.
