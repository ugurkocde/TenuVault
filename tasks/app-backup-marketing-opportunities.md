# App Backup: CMO visibility and launch review

Reviewed 2026-11-12. Advisory only. PR #342 is unreleased; nothing below has been published or submitted. Product claims follow the local implementation and screenshot evidence, not a claim that the stable download already includes it.

## Recommendation

Lead with **keeping original Win32 installers safely**, rather than recovering lost installers. The useful promise available now is free encrypted storage and exact original-file export. The app-first inventory makes the workflow easier to understand, but production capture is still unavailable.

Suggested headline: **Free encrypted storage for your Intune Win32 installers.**

Supporting copy: “Find your Win32 apps, keep the original .intunewin files you already have, and export them when you need them. App Backup is free for every configured tenant. Saved installers remain accessible while signed out.”

Alternative tutorial headline: **Keep your .intunewin originals before you need them again.** Microsoft's packaging guide explains that the Content Prep Tool turns source installation files into `.intunewin` packages; retaining those originals is a clear adjacent workflow. This is a positioning inference, not measured demand. [Microsoft packaging guide](https://learn.microsoft.com/intune/intune-service/apps/apps-win32-prepare)

## What the public surfaces currently miss

The [homepage](https://www.tenuvault.com/) and [pricing page](https://www.tenuvault.com/pricing) emphasize the one-tenant Community plan and do not explain App Backup's separate free policy. At release, add the exception prominently so MSPs do not assume installer storage requires a paid tenant slot. Keep the rest of the product's plan rules intact.

The public [backup overview](https://www.tenuvault.com/intune-backup) describes missing installer payloads as a recovery limitation. That is a natural place to explain the separate administrator-supplied installer store and link to its guide, without suggesting policy backups now contain installers. The proposed [App Backup guide](https://docs.tenuvault.com/apps/app-backup/) could not be fetched during this review; do not send a launch audience there until it is deployed and checked.

## Priorities

| Priority | Opportunity and concrete deliverable | Location / owner | Why now |
| --- | --- | --- | --- |
| P0 | Publish the completed guide, availability table, offline quick start, reconnect steps and limitations. Add links from coverage, restore limitations and licensing. | This repo, docs | Makes the actual shipped workflow findable and prevents capture expectations. |
| P0 | Add an App Backup feature row and a short homepage/use-case block saying it is free for every configured tenant. Link to the guide and version that includes it. | Marketing site, separate execution | Removes the paid-slot ambiguity on the existing acquisition path. |
| P1 | Create one focused `/intune-app-backup` page: problem, three screenshots, attach/export walkthrough, capability limits, FAQ and download/guide CTAs. | Marketing site | Gives feature-intent searches a specific destination instead of the broad policy-backup page. |
| P1 | Record a 60–90 second demonstration: choose an app, explain preparation, attach an existing file, export its original bytes. Add captions and a written walkthrough. | Video/social asset | Shows the real result while exposing the current capture boundary. |
| P1 | Publish a practical installer-retention checklist: original file, version label, encrypted store, separate recovery key, reconnect/export rehearsal. | Guide plus downloadable checklist | Gives admins something useful to bookmark and share without installing first. |
| P2 | Offer a short demo to existing Intune community contacts and MSP customers, requesting feedback on the manual workflow and missing capture step. | Founder outreach, later authorization | Tests whether retention is valuable before making stronger acquisition claims. |

Use descriptive links from existing relevant pages rather than orphaning a new landing page. Google's guidance explicitly supports crawlable links and useful anchor text. [Link best practices](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)

## Search and answer visibility

These are **intent hypotheses**, not keyword-volume or ranking forecasts:

- “back up intunewin files” and “store original Intune Win32 installers”: retention tutorial and feature page.
- “free Intune app backup”: feature page with the exact implemented scope near the top.
- “export saved intunewin original”: short procedural section in the guide.
- “Intune app backup vs policy backup”: a plain comparison explaining what each retained artifact contains.
- “download intunewin from Intune”: answer the current limitation honestly in an FAQ; do not use it as a headline promising a working download tool.

Keep the docs procedural and the marketing page outcome-focused, with distinct titles and their own canonical URLs. Avoid a cluster of near-duplicate pages. Add concise visible answers to “Is it free?”, “Does it download from Intune?”, “Can I export offline?” and “Does this restore apps?” Google recommends original, useful content grounded in experience; its AI Search guidance also says normal SEO fundamentals apply, with no special AI markup required. Neither indexing nor AI citations are guaranteed. [Helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), [AI features guidance](https://developers.google.com/search/docs/appearance/ai-features)

## Distribution and release sequence

1. **Before release:** prepare copy and synthetic screenshots; verify the guide, download destination, supported platforms and exact feature availability. Keep all assets marked unreleased.
2. **Release day:** after a signed release containing the feature is available, publish release notes, docs and marketing changes together. Use “Free App Backup: keep your original .intunewin installers” for a founder LinkedIn post, with one screenshot and a guide link.
3. **Following days:** publish the short demo and retention checklist. Share a substantive tutorial in relevant communities only after checking their current rules; disclose the TenuVault affiliation. The [r/Intune rules page](https://www.reddit.com/r/Intune/about/rules/) did not expose rule text to this review, so permission for promotional posts is unverified. Ask moderators when uncertain, rather than posting a launch link repeatedly.
4. **After indexing:** inspect the deployed URLs in existing search tools. Consider IndexNow for updated public URLs if not already integrated; it notifies participating search engines, not a guarantee of ranking. [Bing guidance](https://www.bing.com/webmasters/help/?topicid=62f2860b)

For a video, use an accessible stable thumbnail and captions. A tutorial/watch page is optional; do not promise video search placement merely because a product page embeds a clip. [Google video guidance](https://developers.google.com/search/docs/appearance/video)

## Measurement without tenant telemetry

Record a pre-launch baseline, then review weekly for four weeks: feature-query impressions/clicks and landing-page CTR in existing Search Console; guide entrances and aggregate download-link clicks by campaign; release-asset downloads; useful feedback and recurring misunderstanding. Use channel-specific campaign parameters on public links, never tenant or device identifiers. GitHub supports release-asset download counts; they are download events, not unique users or successful installations. [Search Console](https://developers.google.com/search/docs/monitor-debug/search-console-start), [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

Do not add installer names, tenant IDs, inventory or source hashes to analytics. With no activation telemetry, use voluntary interviews to learn whether people completed an attach/export round trip. Set numerical targets after the baseline, not from invented traffic or conversion estimates.

## Claims to avoid

Do not claim automatic backup of every Intune app, capture after installation, recovery of lost installers, automatic cache watching, verified equivalence to an Intune version, app-content restore, upload, full disaster recovery, or support beyond the implemented 2 GiB package limit. State that capture is unavailable, manual files are administrator selected, and the Windows device check is read-only. Do not present synthetic app-list screenshots as a live customer tenant or a successful capture demonstration.

The immediate growth opportunity is a useful free retention tool that earns trust and introduces admins to TenuVault. Future capture deserves a separate launch only after it works and passes its release gates.
