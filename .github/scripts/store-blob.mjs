/**
 * Copies the Windows installers of a stable release to Vercel Blob, so the Microsoft Store gets
 * download URLs that do not redirect (Partner Center rejects GitHub release asset URLs).
 *
 *   node .github/scripts/store-blob.mjs <version> <directory with the installers> <release assets JSON>
 *
 * The assets JSON is the release's `assets` array from the GitHub API, which carries each file's
 * SHA-256 digest. Microsoft requires that the file behind a submitted URL never changes, so an
 * object that already exists is never overwritten: identical bytes pass (a re-run), different
 * bytes fail. Reads the store token from BLOB_READ_WRITE_TOKEN.
 */

import { createHash } from "node:crypto"
import { appendFileSync, createReadStream, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const ARCHES = ["x64", "arm64"]
// One year: a published installer never changes.
export const CACHE_MAX_AGE = 31_536_000

export function storeFiles(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Only stable versions go to the Store, not ${version}`)
  return ARCHES.map((arch) => {
    const name = `TenuVault-${version}-win-${arch}.exe`
    return { name, pathname: `desktop/v${version}/${name}` }
  })
}

export function assetDigest(assets, name) {
  const digest = assets.find((asset) => asset.name === name)?.digest
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest ?? "")
  if (!match) throw new Error(`The release has no SHA-256 digest for ${name}`)
  return match[1]
}

async function sha256(stream) {
  const hash = createHash("sha256")
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest("hex")
}

export const sha256File = (path) => sha256(createReadStream(path))

// Fetches a public URL the way Partner Center does: any redirect or non-200 answer fails.
export async function publicSha256(fetchImpl, url) {
  const res = await fetchImpl(url, { redirect: "manual", headers: { "cache-control": "no-cache" } })
  if (res.status !== 200 || res.redirected) {
    await res.body?.cancel()
    const location = res.headers.get("location")
    throw new Error(`${url} answered HTTP ${res.status}${location ? ` redirecting to ${location}` : ""}, expected 200 without redirects`)
  }
  return sha256(res.body)
}

/**
 * Uploads each file unless its object exists, then checks every public URL. `blob` provides
 * head(pathname), which resolves to null when the object does not exist, and put(pathname, path).
 * Returns the public URLs.
 */
export async function publishToStore({ files, blob, fetchImpl, log = console.log }) {
  for (const file of files) {
    const actual = await sha256File(file.path)
    if (actual !== file.sha256) throw new Error(`${file.name} has SHA-256 ${actual}, but the release asset has ${file.sha256}`)
  }
  const urls = []
  for (const file of files) {
    let url
    const existing = await blob.head(file.pathname)
    if (existing) {
      const stored = await publicSha256(fetchImpl, existing.url)
      if (stored !== file.sha256) {
        throw new Error(`${existing.url} already exists with SHA-256 ${stored}, not ${file.sha256}. Store URLs must never change, so it is not overwritten.`)
      }
      log(`${file.pathname} already holds this release's file.`)
      url = existing.url
    } else {
      url = (await blob.put(file.pathname, file.path)).url
      log(`Uploaded ${file.pathname}.`)
    }
    if (new URL(url).pathname !== `/${file.pathname}`) throw new Error(`${file.pathname} was stored as ${url}`)
    urls.push(url)
  }
  for (const [index, url] of urls.entries()) {
    const served = await publicSha256(fetchImpl, url)
    if (served !== files[index].sha256) throw new Error(`${url} serves SHA-256 ${served}, not ${files[index].sha256}`)
    log(`Verified ${url}: HTTP 200, no redirects, SHA-256 ${served}.`)
  }
  return urls
}

export function summary(version, urls) {
  return [`## Microsoft Store package URLs for ${version}`, "", ...urls.map((url) => `- ${url}`), ""].join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, dir, assetsPath] = process.argv.slice(2)
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (!token) throw new Error("Stable releases need the VERCEL_BLOB_READ_WRITE_TOKEN secret")
  const { head, put, BlobNotFoundError } = await import("@vercel/blob")
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"))
  const files = storeFiles(version).map((file) => ({ ...file, path: join(dir, file.name), sha256: assetDigest(assets, file.name) }))
  const blob = {
    head: (pathname) => head(pathname, { token }).catch((error) => {
      if (error instanceof BlobNotFoundError) return null
      throw error
    }),
    put: (pathname, path) => put(pathname, createReadStream(path), {
      token,
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/octet-stream",
      cacheControlMaxAge: CACHE_MAX_AGE,
      multipart: true,
    }),
  }
  const urls = await publishToStore({ files, blob, fetchImpl: fetch })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(version, urls))
}
