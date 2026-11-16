import { mkdtempSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BackupEngine, type BackupEngineDeps, type BackupJob, type BackupRequest } from "../../src/main/backup/engine"
import { handleLocalBlobRequest, localAccountFromUrl } from "../../src/main/storage/blob-emulator"
import { LocalBlobStore } from "../../src/main/storage/local-blob-store"
import { localStorageAccountName } from "../../src/shared/constants"
import { moduleForFolder } from "../../src/shared/services/modules"
import { INTUNE_TYPES, TYPE_BY_FOLDER, type IntuneType } from "../../src/shared/intune/registry"

/**
 * A backup engine over a local store and a scripted Microsoft Graph, and test-only types.
 *
 * Tests that prove what the engine can read isolate the registry and add their own type shapes. A test-only type takes the folder name of a type the permission manifest already
 * knows (shared/services/entra and defender), which gives it that folder's service and permissions.
 */

export const TENANT = "11111111-1111-1111-1111-111111111111"
export const CLIENT = "22222222-2222-2222-2222-222222222222"

/** An access token with these claims, as the permission check reads it. Not signed. */
export const jwt = (claims: { scp?: string; roles?: string[] }) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

/** A test-only type: a list of named objects unless the test says otherwise, and without a restore kind like every new type. */
export function testType(folder: string, path: string, extra: Partial<IntuneType> = {}): IntuneType {
  return { folder, label: `${folder} (test)`, area: "Tenant administration", path, nameKey: "displayName", ...extra }
}

/** Adds types to the registry for the tests of one file. Returns the function that removes them again. */
export function registerTestTypes(types: IntuneType[]): () => void {
  // Machinery tests use an isolated registry: the original services plus their test-only shapes.
  // Real Entra types have their own fixture and integration tests.
  const originals = [...INTUNE_TYPES]
  for (const type of originals) if (moduleForFolder(type.folder)?.module.id === "entra") {
    INTUNE_TYPES.splice(INTUNE_TYPES.indexOf(type), 1)
    TYPE_BY_FOLDER.delete(type.folder.toLowerCase())
  }
  for (const type of types) {
    if (TYPE_BY_FOLDER.has(type.folder.toLowerCase())) throw new Error(`${type.folder} is already a registry type`)
    INTUNE_TYPES.push(type)
    TYPE_BY_FOLDER.set(type.folder.toLowerCase(), type)
  }
  return () => {
    INTUNE_TYPES.splice(0, INTUNE_TYPES.length, ...originals)
    TYPE_BY_FOLDER.clear()
    for (const type of originals) TYPE_BY_FOLDER.set(type.folder.toLowerCase(), type)
  }
}

export type GraphRoute = unknown | ((request: Request) => Response | Promise<Response>)

/** A refused request as Microsoft Graph answers it. */
export const refusal = (status: number, code: string, message: string, headers: Record<string, string> = {}) => () =>
  Response.json({ error: { code, message } }, { status, headers })

/**
 * Microsoft Graph for a test: routes by decoded path and query, such as
 * "/v1.0/policies/x?$filter=a eq 'b'". A route is the JSON to answer with, or a function. Intune
 * lists a test does not mention are empty; any other path a test does not mention is not found.
 */
export function scriptedGraph(routes: Record<string, GraphRoute>) {
  const intune = INTUNE_TYPES.filter((type) => type.restore).map((type) => `/beta/${type.path}`)
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname + url.search)
    if (key in routes) {
      const route = routes[key]
      return typeof route === "function" ? (route as (request: Request) => Response | Promise<Response>)(request) : Response.json(route)
    }
    if (intune.includes(url.pathname) && !url.search) return Response.json(url.pathname.endsWith("/deviceManagement/settings") ? {} : { value: [] })
    if (url.pathname.endsWith("/assignments")) return Response.json({ value: [] })
    return Response.json({ error: { code: "NotInFixture", message: `The test does not answer ${key}` } }, { status: 404 })
  }
}

export interface Fixture {
  engine: BackupEngine
  store: LocalBlobStore
  account: string
  /** Every request sent to Microsoft Graph, as decoded path and query, with its headers. */
  requests: Array<{ path: string; headers: Headers }>
  /** Runs a backup to its end, including what it records after it stopped. */
  run: (request?: Partial<BackupRequest>) => Promise<BackupJob>
  manifest: (job: BackupJob) => Promise<Record<string, any>>
  /** A stored object of the backup, such as "AuthorizationPolicy/Authorization policy.json"; undefined when it was not written. */
  file: (job: BackupJob, name: string) => Promise<Record<string, any> | undefined>
  /** The names of every file the backup wrote, without its folder. */
  files: (job: BackupJob) => Promise<string[]>
}

export function fixture(graph: ReturnType<typeof scriptedGraph>, deps: Partial<BackupEngineDeps> = {}): Fixture {
  const store = new LocalBlobStore(mkdtempSync(join(tmpdir(), "tv-fixture-")), [randomBytes(32)])
  const account = localStorageAccountName(TENANT)
  const requests: Fixture["requests"] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (localAccountFromUrl(url)) return handleLocalBlobRequest(store, request)
    if (url.hostname !== "graph.microsoft.com") throw new Error(`unexpected ${url}`)
    requests.push({ path: decodeURIComponent(url.pathname + url.search), headers: request.headers })
    return graph(request)
  }) as typeof fetch
  const engine = new BackupEngine({ fetch: fetchImpl, getToken: async () => "token", services: () => ({ services: ["intune", "conditionalAccess", "entra", "defender"] }), ...deps })
  const files = async (job: BackupJob) => (await store.list(account, "intune-backups")).filter((blob) => blob.name.startsWith(`${job.backupFolder}/`)).map((blob) => blob.name.slice(job.backupFolder!.length + 1))
  return {
    engine,
    store,
    account,
    requests,
    run: async (request = {}) => engine.waitForJob(engine.start({ tenantId: TENANT, clientId: CLIENT, storageAccountName: account, ...request })),
    manifest: async (job) => JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/metadata.json`)).data.toString()),
    file: async (job, name) => ((await files(job)).includes(name) ? JSON.parse((await store.get(account, "intune-backups", `${job.backupFolder}/${name}`)).data.toString()) : undefined),
    files,
  }
}
