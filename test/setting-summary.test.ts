import { describe, expect, it } from "vitest"
import { summarizeSetting } from "../src/shared/frameworks/setting-summary"

describe("summarizeSetting", () => {
  it("summarizes a choice with nested children", () => {
    const value = {
      "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance",
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_parent",
      choiceSettingValue: {
        "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue",
        value: "device_vendor_msft_policy_config_fakebook_parent_1",
        children: [
          {
            "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance",
            settingDefinitionId: "device_vendor_msft_policy_config_fakebook_child",
            simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationBooleanSettingValue", value: true },
          },
          {
            "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance",
            settingDefinitionId: "device_vendor_msft_policy_config_fakebook_nested",
            choiceSettingValue: { value: "device_vendor_msft_policy_config_fakebook_nested_optionb" },
          },
        ],
      },
    }
    expect(summarizeSetting(value)).toEqual([
      "fakebook_parent: Selected option: 1",
      "  fakebook_child: Value: true",
      "  fakebook_nested: Selected option: optionb",
    ])
  })

  it("summarizes a simple value", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_minimumlength",
      simpleSettingValue: { value: 14 },
    })).toEqual(["fakebook_minimumlength: Value: 14"])
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_title",
      simpleSettingValue: { value: "Fakebook title" },
    })).toEqual(["fakebook_title: Value: Fakebook title"])
    expect(summarizeSetting({ simpleSettingValue: { value: false } })).toEqual(["Value: false"])
  })

  it("summarizes choice and simple collections, one line per entry", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_modes",
      choiceSettingCollectionValue: [
        { value: "device_vendor_msft_policy_config_fakebook_modes_alpha" },
        { value: "device_vendor_msft_policy_config_fakebook_modes_beta" },
      ],
    })).toEqual([
      "fakebook_modes: Selected option: alpha",
      "  Selected option: beta",
    ])
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_ports",
      simpleSettingCollectionValue: [{ value: 8080 }, { value: 8443 }],
    })).toEqual([
      "fakebook_ports: Value: 8080",
      "  Value: 8443",
    ])
  })

  it("recurses into a group setting collection", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_group",
      groupSettingCollectionValue: [
        {
          children: [
            {
              settingDefinitionId: "device_vendor_msft_policy_config_fakebook_first",
              simpleSettingValue: { value: "one" },
            },
            {
              settingDefinitionId: "device_vendor_msft_policy_config_fakebook_second",
              choiceSettingValue: { value: "device_vendor_msft_policy_config_fakebook_second_2" },
            },
          ],
        },
      ],
    })).toEqual([
      "fakebook_group: fakebook_first: Value: one",
      "  fakebook_second: Selected option: 2",
    ])
  })

  it("shortens the definition id prefix for the label", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_fakebook_thing",
      simpleSettingValue: { value: 3 },
    })).toEqual(["fakebook_thing: Value: 3"])
    expect(summarizeSetting({
      settingDefinitionId: "custom_fakebook_thing",
      simpleSettingValue: { value: 3 },
    })).toEqual(["custom_fakebook_thing: Value: 3"])
  })

  it("keeps a choice value that does not start with the definition id", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_mode",
      choiceSettingValue: { value: "standalone_option" },
    })).toEqual(["fakebook_mode: Selected option: standalone_option"])
  })

  it("falls back to compact JSON for unknown shapes", () => {
    expect(summarizeSetting({ unexpected: { nested: [1, 2] } })).toEqual(['{"unexpected":{"nested":[1,2]}}'])
    const long = summarizeSetting({ blob: "x".repeat(500) })
    expect(long).toHaveLength(1)
    expect(long[0]!.length).toBeLessThanOrEqual(200)
    expect(long[0]).toContain("...")
  })

  it("summarizes the screenshot shape with empty children and a suffixed choice value", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_mode",
      choiceSettingValue: { value: "device_vendor_msft_policy_config_fakebook_mode_1", children: [] },
    })).toEqual(["fakebook_mode: Selected option: 1"])
  })

  it("does not strip a definition id prefix without a separator", () => {
    expect(summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_mode",
      choiceSettingValue: { value: "device_vendor_msft_policy_config_fakebook_mode2_1" },
    })).toEqual(["fakebook_mode: Selected option: device_vendor_msft_policy_config_fakebook_mode2_1"])
  })

  it("caps deep nesting without throwing", () => {
    let value: unknown = { settingDefinitionId: "device_vendor_msft_policy_config_fakebook_leaf", simpleSettingValue: { value: "leaf" } }
    for (let i = 0; i < 30; i++) {
      value = {
        settingDefinitionId: `device_vendor_msft_policy_config_fakebook_level${i}`,
        choiceSettingValue: { value: `device_vendor_msft_policy_config_fakebook_level${i}_1`, children: [value] },
      }
    }
    let lines: string[] = []
    expect(() => { lines = summarizeSetting(value) }).not.toThrow()
    expect(lines.length).toBeLessThanOrEqual(50)
    expect(lines.join("\n")).toContain("Further nested values are in the raw Graph values below.")
  })

  it("truncates a huge scalar value", () => {
    const lines = summarizeSetting({
      settingDefinitionId: "device_vendor_msft_policy_config_fakebook_blob",
      simpleSettingValue: { value: "x".repeat(500) },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("...")
    expect(lines[0]!.length).toBeLessThanOrEqual(260)
  })

  it("never throws on null, arrays, or primitives", () => {
    expect(summarizeSetting(null)).toEqual(["null"])
    expect(summarizeSetting([1, 2])).toEqual(["[1,2]"])
    expect(summarizeSetting(42)).toEqual(["42"])
    expect(summarizeSetting(true)).toEqual(["true"])
    expect(summarizeSetting("plain")).toEqual(['"plain"'])
    expect(summarizeSetting(undefined)).toEqual(["undefined"])
  })
})
