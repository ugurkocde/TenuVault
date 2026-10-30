import { describe, expect, it } from "vitest"
import { nameAfterRefresh } from "../src/portal/lib/tenant-refresh"

describe("tenant name after a details refresh", () => {
  it("keeps the name the tenant has now, including a rename made while the refresh was running", () => {
    expect(nameAfterRefresh("Renamed during refresh", "Contoso Ltd")).toBe("Renamed during refresh")
    expect(nameAfterRefresh("Contoso custom", "Contoso Ltd")).toBe("Contoso custom")
  })

  it("replaces only the placeholder names with the organization name", () => {
    expect(nameAfterRefresh("Loading...", "Contoso Ltd")).toBe("Contoso Ltd")
    expect(nameAfterRefresh("New Tenant", "Contoso Ltd")).toBe("Contoso Ltd")
  })
})
