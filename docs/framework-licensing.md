# Framework content and naming decisions

Reviewed 30 September 2026. The implementation provides independently authored Intune setting comparisons for a selected technical subset. Framework names identify the referenced publication; TenuVault is the product name. There are no publisher logos, official badges, partnership claims, certificates or audit opinions.

| Framework | Distributed content | Basis and limitations |
| --- | --- | --- |
| NIST CSF 2.0, SP 800-53 Rev. 5, SP 800-171 Revs. 2/3 | Selected employee-authored references, independently adapted summaries and Intune checks | NIST technical-publication reuse terms, attribution and modification notice. Third-party supplements excluded. |
| ASD Essential Eight | Selected November 2023 requirement entries and adapted technical mappings | CC BY 4.0. ASD/Commonwealth attribution, license link and changes retained. Logos excluded. |
| Cyber Essentials | Five themes and independently adapted technical descriptions | NCSC public-sector information under OGL v3. Crown copyright and license link retained. Logos and certification branding excluded. |
| ISO/IEC 27001:2022 | Factual full standard reference, selected Annex A identifiers and original detector descriptions | No ISO standard text, copied titles, PDF or logo. ISO expressly permits fair references to standards using their full reference. |
| SOC 2 | Factual name, selected criterion identifiers and original detector descriptions | No AICPA criteria text, points of focus, publisher PDF or logo. No attestation claim. |
| BSI IT-Grundschutz | Edition 2023 identifiers, requirement/building-block granularity and original detector descriptions | Publisher-style titles and summaries from the source implementation replaced. No Kompendium PDF, official requirement wording or logo. |
| Def Stan 05-138 | Issue 4 identifiers, factual risk-level applicability and original detector descriptions | Official document is marked “Copying Only as Agreed with DStan.” Publisher text/PDF is excluded; checks and descriptions are original. No defence-contract fulfilment claim. |
| CIS | Plain-text catalog references with “Coming soon” | No active comparison, import or creation, and no bundled benchmark/Controls/Build Kit content. Enable only within the signed commercial-use agreement. Before certification, CIS Benchmarks is enabled only for installations that receive the server-issued internal claim. Their packs and recommendation lists (recommendation text for the Manual and "Not assessed by this tool" sections) are downloaded at runtime from the authenticated delivery service and kept in protected local storage; none of this content is in the repository or the installer. |

Source code was adapted from the owner's IntuneDocumentation repository at `bb689bd025cbfb6f85ad97d230df907f7162f92c`, with the detector fix from `38998301541c06a6a4a2f6e099277a6c39eb84f6` (template booleans left at "Not configured") applied on 1 October 2026. The framework mappings still come from the first commit. Its Elastic License 2.0 is retained in the installed notice file. This code license is separate from publisher content. TenuVault does not claim ownership of third-party open material or restrict reuse rights granted by its original license. OIB code and deployment behavior are outside this change.

The machine-readable [rights manifest](../src/shared/compliance/rights.json) records source editions, URLs, hashes, distribution decisions, publishers and licenses. The [installed notices](../resources/framework-NOTICES.txt) record attribution and changes. Electron builds reject unreviewed provider files or changed content hashes. Historical results retain source and ruleset hashes, and reports export stored results rather than regenerating them with updated mappings.

The framework-reference approach is based on honest factual identification. German trademark law §23(1)(3) and EU Trade Mark Regulation Article 14 allow necessary referential use subject to honest commercial practices. This is an implementation basis, not publisher approval or a universal legal opinion. Free Community availability does not itself waive copyright or trademark rights. Restricted official content remains excluded regardless of pricing.

Primary sources:

- [ISO name and logo guidelines](https://www.iso.org/iso-name-and-logo.html)
- [NIST copyright and technical-publication reuse terms](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications)
- [ASD copyright and attribution](https://www.cyber.gov.au/about-us/copyright)
- [NCSC website content terms](https://www.ncsc.gov.uk/section/about-this-website/terms-and-conditions)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [Open Government Licence v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
- [German MarkenG §23](https://www.gesetze-im-internet.de/markeng/__23.html)
- [EU Trade Mark Regulation Article 14](https://eur-lex.europa.eu/eli/reg/2017/1001/oj)
- [Def Stan Issue 4 publication](https://www.gov.uk/government/publications/cyber-security-for-defence-suppliers-def-stan-05-138-issue-4)
