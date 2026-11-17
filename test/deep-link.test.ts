import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { parseConnectLink } from "../src/shared/deep-link"
import { ConnectLinkIntake, connectLinksFromArgv, shouldRegisterProtocol } from "../src/main/deep-link"

const tenantId = "abcdef01-2345-6789-abcd-0123456789ab"
const clientId = "fedcba01-2345-6789-abcd-0123456789ab"
const link = `tenuvault://connect?v=1&tenant=${tenantId}&client=${clientId}`

describe("parseConnectLink", () => {
  it("accepts IDs, lowercases GUIDs and decodes a printable plain text name", () => {
    expect(parseConnectLink(`${link.toUpperCase().replace("?V", "?v").replace("&TENANT", "&tenant").replace("&CLIENT", "&client")}&name=Caf%C3%A9%20%26%20Co`)).toEqual({ tenantId, clientId, displayName: "Café & Co" })
  })
  it("accepts an optional launcher slash and a 64 character name", () => {
    expect(parseConnectLink(link.replace("connect?", "connect/?"))).toEqual({ tenantId, clientId })
    expect(parseConnectLink(`${link}&name=${"a".repeat(64)}`)?.displayName).toHaveLength(64)
  })
  it.each(["", "+++", "%20%20%20"])("treats an empty or whitespace-only name as absent: %s", name => {
    expect(parseConnectLink(`${link}&name=${name}`)).toEqual({ tenantId, clientId })
  })
  it.each(["++Contoso+%26+Co++", "%20Contoso%20%26%20Co", "Contoso%20%26%20Co%20"])("trims plain spaces around the optional name: %s", name => {
    expect(parseConnectLink(`${link}&name=${name}`)).toEqual({ tenantId, clientId, displayName: "Contoso & Co" })
  })
  it.each(["%0A", "%09", "%0D"])("rejects decoded controls before trimming the optional name: %s", control => {
    for (const name of [control, `${control}Contoso`, `Contoso${control}`, `${control}Contoso${control}`]) {
      expect(parseConnectLink(`${link}&name=${name}`)).toBeNull()
    }
  })
  it.each([
    ["another scheme", link.replace("tenuvault:", "https:")],
    ["another host", link.replace("connect?", "other?")],
    ["a path", link.replace("connect?", "connect/path?")],
    ["a normalized path", link.replace("connect?", "connect/path/..?")],
    ["multiple slashes", link.replace("connect?", "connect//?")],
    ["credentials", link.replace("connect?", "user@connect?")],
    ["a port", link.replace("connect?", "connect:1?")],
    ["a fragment", `${link}#extra`],
    ["a domain tenant", link.replace(tenantId, "contoso.onmicrosoft.com")],
    ["a non-GUID tenant", link.replace(tenantId, "no")],
    ["a non-GUID client", link.replace(clientId, "no")],
    ["missing v", link.replace("v=1&", "")],
    ["unknown v", link.replace("v=1", "v=2")],
    ["an unknown parameter", `${link}&other=x`],
    ["a duplicate parameter", `${link}&tenant=${tenantId}`],
    ["an encoded duplicate", `${link}&%76=1`],
    ["a raw link over 512 characters", `${link}&name=${"a".repeat(512)}`],
    // 64 encoded three-byte characters: a valid name, so only the raw length limit refuses it.
    ["a raw link over 512 characters with a valid name", `${link}&name=${"%E6%97%A5".repeat(64)}`],
    ["a name over 64 characters", `${link}&name=${"a".repeat(65)}`],
    ["an encoded control", `${link}&name=abc%00def`],
    ["a raw newline", `${link}&name=abc\ndef`],
    ["an invisible format character", `${link}&name=%E2%80%AEabc`],
    ["an HTML payload", `${link}&name=%3Cb%3EContoso%3C%2Fb%3E`],
    ["a script tag", `${link}&name=%3Cscript%3Ealert(1)%3C%2Fscript%3E`],
    ["a script payload", `${link}&name=javascript:alert(1)`],
    ["a malformed percent escape", `${link}&name=%ZZ`],
    ["invalid UTF-8", `${link}&name=%FF`],
    ...["license", "token", "secret", "scopes", "login_hint", "redirect"].map(key => [`a ${key} parameter`, `${link}&${key}=value`]),
  ])("rejects %s", (_name, raw) => expect(parseConnectLink(raw!)).toBeNull())
})

describe("ConnectLinkIntake", () => {
  it("extracts Windows argv URLs including quoted URLs, ignoring switches and executable paths", () => {
    expect(connectLinksFromArgv(["TenuVault.exe", "--hidden", link, `"${link}"`, "https://example.test", `--url=${link}`])).toEqual([link, link])
  })
  it("keeps only the newest valid link across cold start, second instance and open-url intake", () => {
    const notify = vi.fn(), focus = vi.fn()
    const intake = new ConnectLinkIntake(notify, focus)
    intake.argv(["app.exe", link])
    intake.argv(["app.exe", `${link}&name=Second`])
    intake.accept(`${link}&name=Newest`)
    expect(intake.take().pending?.details.displayName).toBe("Newest")
    expect(focus).toHaveBeenCalledTimes(3)
    expect(notify).toHaveBeenCalledTimes(3)
  })
  it("reports rejection without losing the pending valid link or forwarding raw input", () => {
    const intake = new ConnectLinkIntake(vi.fn(), vi.fn())
    intake.accept(link)
    intake.accept("tenuvault://bad?token=secret")
    expect(intake.take()).toEqual({ pending: { id: 1, details: { tenantId, clientId } }, rejected: true })
    expect(intake.take().rejected).toBe(true)
    intake.dismissRejection()
    expect(intake.take().rejected).toBe(false)
  })
  it("retains a link for a late mount or reload until acknowledged, with stale dismissal harmless", () => {
    const intake = new ConnectLinkIntake(vi.fn(), vi.fn())
    intake.accept(link)
    expect(intake.take()).toEqual(intake.take())
    intake.accept(`${link}&name=New`)
    intake.dismiss(1)
    expect(intake.take().pending?.id).toBe(2)
    intake.dismiss(2)
    expect(intake.take().pending).toBeNull()
  })
  it("leaves plain and hidden launches to the existing second-instance behavior", () => {
    expect(new ConnectLinkIntake(vi.fn(), vi.fn()).argv(["app.exe", "--hidden"])).toBe(false)
  })
  it("registers packaged builds and only explicitly opted-in development builds", () => {
    expect(shouldRegisterProtocol(true, undefined)).toBe(true)
    expect(shouldRegisterProtocol(false, undefined)).toBe(false)
    expect(shouldRegisterProtocol(false, "0")).toBe(false)
    expect(shouldRegisterProtocol(false, "1")).toBe(true)
  })
})

describe("connection link clipboard pickup", () => {
  const output = `Tenant id: ${tenantId}\nApplication (client) id: ${clientId}`
  it("returns nothing while a link is pending, before focusing the window", async () => {
    const read = vi.fn(async () => output)
    const pickups: Promise<unknown>[] = []
    const intake = new ConnectLinkIntake(vi.fn(), () => { pickups.push(intake.clipboardIds(read)) })
    expect(await intake.clipboardIds(read)).toEqual({ tenantId, clientId })
    read.mockClear()
    intake.argv(["app.exe", link])
    intake.accept(link)
    expect(await Promise.all(pickups)).toEqual([null, null])
    expect(read).not.toHaveBeenCalled()
  })
  it("Cancel prevents the same clipboard pair from being returned on later focus", async () => {
    const intake = new ConnectLinkIntake(vi.fn(), vi.fn())
    intake.accept(link)
    intake.dismiss(intake.take().pending!.id)
    expect(await intake.clipboardIds(async () => output.toUpperCase())).toBeNull()
    expect(await intake.clipboardIds(async () => output)).toBeNull()
    const other = output.replace(clientId, tenantId)
    expect(await intake.clipboardIds(async () => other)).toEqual({ tenantId, clientId: tenantId })
  })
  it("suppresses an in-flight clipboard read when a link arrives and is cancelled", async () => {
    const intake = new ConnectLinkIntake(vi.fn(), vi.fn())
    let finish!: (value: string) => void
    const pickup = intake.clipboardIds(() => new Promise(resolve => { finish = resolve }))
    intake.accept(link)
    intake.dismiss(intake.take().pending!.id)
    finish(output)
    expect(await pickup).toBeNull()
  })
  it("does not clear the clipboard guard when an old dialog dismisses a newer link", async () => {
    const intake = new ConnectLinkIntake(vi.fn(), vi.fn())
    intake.accept(link)
    intake.accept(`${link}&name=Newest`)
    intake.dismiss(1)
    expect(await intake.clipboardIds(async () => output)).toBeNull()
  })
})

it("registers the packaged executable before window or store setup, without hidden-launch arguments", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const bootstrap = main.slice(main.indexOf("async function bootstrap()"))
  expect(bootstrap).toContain('app.setAsDefaultProtocolClient("tenuvault", process.execPath, [])')
  expect(bootstrap.indexOf('app.setAsDefaultProtocolClient("tenuvault", process.execPath, [])')).toBeLessThan(bootstrap.indexOf("const cipher = osCipher()"))
  expect(bootstrap.slice(0, bootstrap.indexOf("const cipher = osCipher()"))).not.toContain("startedHidden")
})

it("clears the pending connection link focus when returning to the app", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const body = main.slice(main.indexOf("function returnToApp(): void {"), main.indexOf("function rendererUrl()"))
  expect(body.indexOf("linkRequestedFocus = false")).toBeGreaterThan(0)
  expect(body.indexOf("linkRequestedFocus = false")).toBeLessThan(body.indexOf("showWindow()"))
})
