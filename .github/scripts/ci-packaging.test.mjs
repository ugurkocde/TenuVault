import assert from "node:assert/strict"
import test from "node:test"
import { requiresPackaging } from "./ci-packaging.mjs"

test("README and ignore-only PRs do not require installers", () => {
  assert.equal(requiresPackaging(["README.md", ".gitignore"]), false)
  assert.equal(requiresPackaging(["docs/assets/download-macos.svg", "docs-site/package.json"]), false)
})

test("app, dependencies, licensing assets and CI changes require installers", () => {
  for (const path of ["src/main/index.ts", "package.json", "package-lock.json", "EULA.txt", "resources/licenses/LICENSE.txt", "build/icon.png", "electron-builder.config.cjs", ".github/workflows/ci.yml", ".github/scripts/ci-packaging.mjs", "scripts/smoke.mjs", "new-build-input"]) {
    assert.equal(requiresPackaging(["README.md", path]), true, path)
  }
})

test("moving an app file into docs still requires installers", () => {
  assert.equal(requiresPackaging(["src/main/removed.ts", "docs/removed.ts"]), true)
})
