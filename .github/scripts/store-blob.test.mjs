import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { assetDigest, publishToStore, storeFiles, summary } from "./store-blob.mjs"

const BASE = "https://store.public.blob.vercel-storage.com"
const sha = (text) => createHash("sha256").update(text).digest("hex")

function setup(contents = { x64: "x64 installer", arm64: "arm64 installer" }) {
  const dir = mkdtempSync(join(tmpdir(), "store-blob-"))
  const files = storeFiles("1.2.3").map((file, index) => {
    const body = Object.values(contents)[index]
    writeFileSync(join(dir, file.name), body)
    return { ...file, path: join(dir, file.name), sha256: sha(body) }
  })
  return { dir, files }
}

// A fake store: objects maps pathname to body; the public fetch serves them, or a configured answer.
function fakeStore(objects = {}, answers = {}) {
  const puts = []
  const blob = {
    head: async (pathname) => (pathname in objects ? { url: `${BASE}/${pathname}` } : null),
    put: async (pathname, path) => {
      puts.push({ pathname, path })
      objects[pathname] = readFileSync(path, "utf8")
      return { url: `${BASE}/${pathname}` }
    },
  }
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "manual")
    const pathname = new URL(url).pathname.slice(1)
    if (answers[pathname]) return answers[pathname]
    return pathname in objects ? new Response(objects[pathname]) : new Response("missing", { status: 404 })
  }
  return { blob, fetchImpl, puts, objects }
}

test("stable versions map to the Store pathnames, nightlies are refused", () => {
  assert.deepEqual(storeFiles("0.3.0"), [
    { name: "TenuVault-0.3.0-win-x64.exe", pathname: "desktop/v0.3.0/TenuVault-0.3.0-win-x64.exe" },
    { name: "TenuVault-0.3.0-win-arm64.exe", pathname: "desktop/v0.3.0/TenuVault-0.3.0-win-arm64.exe" },
  ])
  assert.throws(() => storeFiles("0.3.1-nightly.20261018120000"), /Only stable versions/)
  assert.throws(() => storeFiles("v0.3.0"), /Only stable versions/)
})

test("release asset digests must be SHA-256", () => {
  const digest = "a".repeat(64)
  assert.equal(assetDigest([{ name: "a.exe", digest: `sha256:${digest}` }], "a.exe"), digest)
  assert.throws(() => assetDigest([{ name: "a.exe", digest: null }], "a.exe"), /no SHA-256 digest for a.exe/)
  assert.throws(() => assetDigest([], "a.exe"), /no SHA-256 digest/)
})

test("uploads missing objects and verifies their public URLs", async () => {
  const { files } = setup()
  const store = fakeStore()
  const urls = await publishToStore({ files, ...store, log: () => {} })
  assert.deepEqual(urls, [`${BASE}/desktop/v1.2.3/TenuVault-1.2.3-win-x64.exe`, `${BASE}/desktop/v1.2.3/TenuVault-1.2.3-win-arm64.exe`])
  assert.deepEqual(store.puts.map((put) => put.pathname), files.map((file) => file.pathname))
})

test("a downloaded file that differs from the release digest is never uploaded", async () => {
  const { files } = setup()
  files[1].sha256 = sha("something else")
  const store = fakeStore()
  await assert.rejects(publishToStore({ files, ...store, log: () => {} }), /TenuVault-1.2.3-win-arm64.exe has SHA-256 .* but the release asset has/)
  assert.equal(store.puts.length, 0)
})

test("a re-run with identical objects succeeds without uploading", async () => {
  const { files } = setup()
  const store = fakeStore({ [files[0].pathname]: "x64 installer", [files[1].pathname]: "arm64 installer" })
  const urls = await publishToStore({ files, ...store, log: () => {} })
  assert.equal(urls.length, 2)
  assert.equal(store.puts.length, 0)
})

test("an existing object with different bytes fails and is not overwritten", async () => {
  const { files } = setup()
  const store = fakeStore({ [files[0].pathname]: "an older build" })
  await assert.rejects(publishToStore({ files, ...store, log: () => {} }), /already exists with SHA-256 .* it is not overwritten/)
  assert.equal(store.puts.length, 0)
  assert.equal(store.objects[files[0].pathname], "an older build")
})

test("a redirecting or failing public URL fails the upload", async () => {
  const { files } = setup()
  const redirect = new Response(null, { status: 302, headers: { location: "https://elsewhere.example/file.exe" } })
  await assert.rejects(
    publishToStore({ files, ...fakeStore({}, { [files[1].pathname]: redirect }), log: () => {} }),
    /answered HTTP 302 redirecting to https:\/\/elsewhere.example\/file.exe, expected 200 without redirects/,
  )
  const unavailable = new Response("busy", { status: 503 })
  await assert.rejects(publishToStore({ files, ...fakeStore({}, { [files[0].pathname]: unavailable }), log: () => {} }), /answered HTTP 503/)
})

test("a public URL serving other bytes fails the upload", async () => {
  const { files } = setup()
  const store = fakeStore({}, { [files[0].pathname]: new Response("tampered") })
  await assert.rejects(publishToStore({ files, ...store, log: () => {} }), /serves SHA-256 .* not /)
})

test("an object stored under another name fails the upload", async () => {
  const { files } = setup()
  const store = fakeStore()
  store.blob.put = async (pathname) => ({ url: `${BASE}/${pathname.replace(".exe", "-AbC123.exe")}` })
  await assert.rejects(publishToStore({ files, ...store, log: () => {} }), /was stored as .*-AbC123\.exe/)
})

test("the job summary lists both Store URLs", () => {
  assert.equal(summary("1.2.3", ["https://a/x64.exe", "https://a/arm64.exe"]), "## Microsoft Store package URLs for 1.2.3\n\n- https://a/x64.exe\n- https://a/arm64.exe\n")
})
