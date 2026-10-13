import { describe, expect, it } from "vitest"
import { RENDERER_STORAGE_VALUE_LIMIT, rendererStorageKey, rendererStorageValue } from "../src/main/renderer-storage"

describe("renderer storage bounds", () => {
  it("accepts ordinary keys and values", () => {
    expect(rendererStorageKey("tenuvault_tenants")).toBe("tenuvault_tenants")
    expect(rendererStorageValue("[]")).toBe("[]")
    expect(rendererStorageValue("x".repeat(RENDERER_STORAGE_VALUE_LIMIT))).toHaveLength(RENDERER_STORAGE_VALUE_LIMIT)
  })

  it("refuses non-string, empty and oversized keys", () => {
    expect(() => rendererStorageKey(42)).toThrow("storage key")
    expect(() => rendererStorageKey("")).toThrow("storage key")
    expect(() => rendererStorageKey("k".repeat(257))).toThrow("storage key")
  })

  it("refuses non-string and oversized values", () => {
    expect(() => rendererStorageValue(42)).toThrow("too large")
    expect(() => rendererStorageValue(null)).toThrow("too large")
    expect(() => rendererStorageValue("x".repeat(RENDERER_STORAGE_VALUE_LIMIT + 1))).toThrow("too large")
  })
})
