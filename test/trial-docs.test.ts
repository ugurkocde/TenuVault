import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
describe("tenant trial guidance", () => {
  it("distinguishes signed trial claims from response fields and server authorization", () => {
    const network = read("docs/license-network-checks.md")
    expect(network).toContain("The signed v2 token carries the tenant, installation, activation, plan, `trial` and `keyExp`.")
    expect(network).toContain("`source` and `canEnd` are plain response fields, not signed claims.")
    expect(network).toContain("the server enforces who may end the trial")
  })
  it("explains the installation limit and removal from a joining installation", () => {
    const index = read("docs-site/src/content/docs/licensing/index.md")
    expect(index).toContain("An installation has a limited number of trials")
    expect(index).toContain("This installation has already started its available tenant trials.")
    expect(index).toContain("Remove the saved email address for this trial")
    expect(index).toContain("any installation that joined it")
    expect(read("docs-site/src/content/docs/licensing/manage.md")).toContain("When tenant trials are on, the welcome screen")
  })
  it.each(["docs/license-network-checks.md", "tasks/reverse-trial-2026-11-09.md"])("keeps the definitive refusal and retry window rule in %s", path => {
    const text = read(path)
    expect(text).toMatch(/`used`, `licensed`(?:,| and) `install_limit`/)
    expect(text).toMatch(/`disabled`, `app_update_required` and (?:an unknown|unsupported) action/)
    expect(text).not.toContain("A refusal ends retries.")
  })
  it("includes extended trials and pre-existing history in the retention follow-up", () => {
    const plan = read("tasks/reverse-trial-2026-11-09.md")
    expect(plan).toContain("at the first successful backup after coverage ends")
    expect(plan).toContain("trials with an extension, or tenants that had older backups before the trial")
    expect(plan).not.toContain("Trials are not\n  affected")
  })
})
