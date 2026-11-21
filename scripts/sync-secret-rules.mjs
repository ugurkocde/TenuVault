import { readFileSync, writeFileSync } from "node:fs"

const rules = new URL("../src/shared/intune/secret-rules.json", import.meta.url)
const runbook = new URL("../resources/runbooks/Invoke-TenuVaultBackup.ps1", import.meta.url)
const source = readFileSync(runbook, "utf8")
const block = /(?<=# BEGIN GENERATED SECRET RULES\r?\n)[\s\S]*?(?=\r?\n# END GENERATED SECRET RULES)/
if (!block.test(source)) throw new Error("Secret rules block is missing from the runbook")
const json = readFileSync(rules, "utf8").trim()
const eol = source.includes("\r\n") ? "\r\n" : "\n"
const next = source.replace(block, () => `$script:SecretRules = @'\n${json}\n'@ | ConvertFrom-Json -AsHashtable`.replace(/\r?\n/g, eol))
if (process.argv.includes("--check")) {
  if (next !== source) throw new Error("Run node scripts/sync-secret-rules.mjs to update the runbook")
} else if (source !== next) {
  writeFileSync(runbook, next)
}
