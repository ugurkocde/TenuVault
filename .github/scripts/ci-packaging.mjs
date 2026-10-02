import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Only known non-packaged paths are exempt. Unknown paths require installers.
export function requiresPackaging(paths) {
  return paths.some(path => !(
    path === ".gitignore" ||
    /^[^/]+\.md$/i.test(path) ||
    path.startsWith("docs/") ||
    path.startsWith("docs-site/")
  ))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let required = true
  if (process.env.EVENT_NAME === "pull_request") {
    const { BASE_SHA: base, HEAD_SHA: head } = process.env
    if (!/^[a-f0-9]{40}$/.test(base ?? "") || !/^[a-f0-9]{40}$/.test(head ?? "")) {
      throw new Error("Missing or invalid pull request commit IDs")
    }
    // The complete PR diff, including both sides of renames and deleted files.
    const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], { encoding: "utf8" })
      .split("\0").filter(Boolean)
    required = requiresPackaging(paths)
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `package_required=${required}\n`)
  console.log(required ? "Installer builds required." : "Only documentation or ignore rules changed; installer builds not needed.")
}
