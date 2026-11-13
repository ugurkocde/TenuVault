import { describe, expect, it, vi } from "vitest"
import { copySignInLink } from "../src/main/auth/sign-in-link"

const URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=c&state=s"

describe("copySignInLink", () => {
  it("copies the waiting sign-in's own address and returns only whether it did", () => {
    const write = vi.fn()
    expect(copySignInLink("signin", { signin: () => URL, setup: () => null }, write)).toBe(true)
    expect(write).toHaveBeenCalledWith(URL)
    expect(copySignInLink("setup", { signin: () => null, setup: () => URL }, write)).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it("copies nothing when no sign-in waits or the address is not Microsoft's login", () => {
    const write = vi.fn()
    expect(copySignInLink("signin", { signin: () => null, setup: () => URL }, write)).toBe(false)
    expect(copySignInLink("setup", { signin: () => URL, setup: () => "https://example.invalid/" }, write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("refuses an unknown sign-in", () => {
    expect(() => copySignInLink("other", { signin: () => URL, setup: () => URL }, vi.fn())).toThrow("Unknown sign-in.")
  })
})
