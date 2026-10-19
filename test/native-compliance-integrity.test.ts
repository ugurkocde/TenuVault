import { describe, expect, it } from "vitest";
import { assessCapabilities, assessCompliance } from "../src/shared/compliance/engine";
import { COMPLIANCE_CAPABILITIES } from "../src/shared/compliance/capabilities";
import { ISO_27001, SOC_2, BSI_IT_GRUNDSCHUTZ, DEF_STAN_05_138 } from "../src/shared/compliance";
import { capabilityComparison } from "../src/shared/compliance/native";
import { assignmentDetails } from "../src/shared/compliance/assignments";
import type { DetailedExportData } from "../src/shared/compliance/input";
import type { ComplianceCapability } from "../src/shared/compliance/types";

const assigned = [
  { target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } },
];
const policy = (
  type: string,
  settings: Record<string, unknown>,
  id = "policy",
) => ({
  id,
  displayName: id,
  "@odata.type": `#microsoft.graph.${type}`,
  assignments: assigned,
  // Assigned compliance requirements now need their collected block action.
  ...(type.toLowerCase().endsWith("compliancepolicy") ? { scheduledActionsForRule: [{ scheduledActionConfigurations: [{ actionType: "block", gracePeriodHours: 0 }] }] } : {}),
  ...settings,
});
function data(...policies: any[]): DetailedExportData {
  return {
    settingsCatalog: [],
    deviceConfigurations: policies,
    administrativeTemplates: [],
    compliancePolicies: [],
    securityBaselines: [],
    scripts: { windows: [], macOS: [] },
  };
}
function capability(exportData: DetailedExportData, id: string) {
  return assessCapabilities(exportData).find(
    (result) => result.capability.id === id,
  )!;
}

describe("evidence integrity regressions", () => {
  it("derives each summary capability list from the actual mapping and keeps the prose", () => {
    for (const framework of [ISO_27001, SOC_2, BSI_IT_GRUNDSCHUTZ, DEF_STAN_05_138]) {
      for (const control of Object.values(framework.controls)) {
        const names = Object.entries(framework.mappings).filter(([, ids]) => ids.includes(control.id))
          .map(([id]) => COMPLIANCE_CAPABILITIES.find(capability => capability.id === id)!.name);
        expect(control.summary).toBe(`TenuVault compares selected capabilities: ${names.join(", ")}. Check selection and expected values are our interpretation.`);
      }
    }
  });

  it("scores required setting groups only when one assigned policy has every group", () => {
    const domain = policy("windows10EndpointProtectionConfiguration", { firewallProfileDomain: { firewallEnabled: "allowed" } }, "domain");
    const other = policy("windows10EndpointProtectionConfiguration", { firewallProfilePrivate: { firewallEnabled: "allowed" }, firewallProfilePublic: { firewallEnabled: "allowed" } }, "other");
    const exportData = data(domain, other);
    exportData.collectedAt = "2026-10-12T10:00:00Z";
    expect(capabilityComparison(capability(exportData, "windows-firewall"))).toBe("missing");
    exportData.deviceConfigurations = [{ ...domain, ...other, id: "complete", firewallProfileDomain: { firewallEnabled: "allowed" } }];
    expect(capabilityComparison(capability(exportData, "windows-firewall"))).toBe("matches");
  });

  it("evaluates technical checks in every framework and explains skipped Conditional Access", () => {
    const exportData = data();
    exportData.collectionSkippedFamilies = ["conditionalAccessPolicies"];
    const result = assessCompliance(exportData);
    const mfa = result.capabilities.find(
      (row) => row.capability.id === "tenant-mfa-required",
    )!;
    expect(mfa.status).toBe("collectionIncomplete");
    expect(mfa.limitations.join(" ")).toContain(
      "Select Conditional Access under Platforms in scope",
    );
    const evaluatedIds = new Set(
      result.capabilities.map((row) => row.capability.id),
    );
    for (const framework of result.frameworks) {
      for (const control of framework.controls) {
        for (const id of control.capabilityIds)
          expect(evaluatedIds.has(id)).toBe(true);
        if (control.capabilityIds.includes("tenant-mfa-required")) {
          expect(control.unassessedAspects.join(" ")).toContain(
            "Conditional Access policies were not collected",
          );
        }
      }
    }
    expect(
      result.capabilities.find(
        (row) => row.capability.id === "windows-firewall",
      )?.status,
    ).toBe("noEvidence");
  });

  it("does not invalidate technical checks when only legacy WIP collection fails", () => {
    const exportData = data();
    exportData.fetchErrors = [
      {
        policyId: "windowsInformationProtectionPolicies",
        policyName: "Windows Information Protection (legacy)",
        policyType: "applications",
        familyKey: "applications",
        error: "Graph omitted the collection value array",
      },
    ];
    expect(
      assessCapabilities(exportData).some(
        (row) => row.status === "collectionIncomplete",
      ),
    ).toBe(false);
  });

  it("does not treat a template default of false as switched off", () => {
    // Device restriction profiles return every boolean; an untouched Defender
    // section reads false (observed on a live profile that only blocks
    // Microsoft accounts).
    const enabled = policy("windows10GeneralConfiguration", {
      defenderRequireBehaviorMonitoring: true,
    });
    const untouched = {
      ...policy("windows10GeneralConfiguration", {
        defenderRequireBehaviorMonitoring: false,
        microsoftAccountBlocked: true,
      }),
      id: "untouched",
    };
    expect(
      capability(data(enabled, untouched), "windows-behavior-monitoring")
        .status,
    ).toBe("enforced");
    const alone = capability(data(untouched), "windows-behavior-monitoring");
    expect(alone.status).toBe("noEvidence");
    expect(alone.checks.some((check) => check.result === "different")).toBe(
      false,
    );
  });
  it("does not report unconfigured compliance requirements as different values", () => {
    // A compliance policy that only requires the firewall still returns
    // bitLockerEnabled and storageRequireEncryption as false.
    const firewallOnly = policy("windows10CompliancePolicy", {
      activeFirewallRequired: true,
      bitLockerEnabled: false,
      storageRequireEncryption: false,
    });
    const encryption = capability(
      data(firewallOnly),
      "windows-disk-encryption",
    );
    expect(encryption.evidence).toHaveLength(0);
    expect(
      encryption.checks.filter((check) => check.policyId === firewallOnly.id),
    ).toHaveLength(0);
  });
  it.each([
    [{ rtpEnabled: true }, "requirementAssigned"],
    [{ defenderEnabled: true, rtpEnabled: false }, "noEvidence"],
    [{ antivirusRequired: true }, "noEvidence"],
  ])("uses real-time protection semantics for %j", (settings, status) => {
    expect(
      capability(
        data(policy("windows10CompliancePolicy", settings)),
        "windows-realtime-antimalware",
      ).status,
    ).toBe(status);
  });
  it("records antivirus presence without claiming Defender real-time protection", () => {
    const result = capability(
      data(policy("windows10CompliancePolicy", { antivirusRequired: true })),
      "windows-antivirus-required",
    );
    expect(result.status).toBe("requirementAssigned");
    expect(result.evidence[0]?.kind).toBe("complianceRequirement");
  });
  it("recognizes fully managed Android integrity requirements", () => {
    const result = capability(
      data(
        policy("androidDeviceOwnerCompliancePolicy", {
          securityBlockJailbrokenDevices: true,
        }),
      ),
      "android-device-integrity",
    );
    expect(result.status).toBe("requirementAssigned");
  });
  it("keeps disabled firewall profiles visible in the capability and framework", () => {
    const exportData = data(
      policy("windows10EndpointProtectionConfiguration", {
        firewallProfileDomain: { firewallEnabled: "allowed" },
        firewallProfilePublic: { firewallEnabled: "blocked" },
      }),
    );
    expect(capability(exportData, "windows-firewall").status).toBe(
      "conflictingEvidence",
    );
    const iso = assessCompliance(exportData).frameworks.find(
      (framework) => framework.framework.id === "iso-27001-2022",
    )!;
    expect(
      iso.controls.find((control) => control.control.id === "8.20")?.status,
    ).toBe("conflictingEvidence");
  });
  it("requires all firewall profiles on the same policy", () => {
    const domain = policy(
      "windows10EndpointProtectionConfiguration",
      { firewallProfileDomain: { firewallEnabled: "allowed" } },
      "domain",
    );
    const other = policy(
      "windows10EndpointProtectionConfiguration",
      {
        firewallProfilePrivate: { firewallEnabled: "allowed" },
        firewallProfilePublic: { firewallEnabled: "allowed" },
      },
      "other",
    );
    expect(capability(data(domain, other), "windows-firewall").status).toBe(
      "partialConfiguration",
    );
    expect(
      capability(
        data({
          ...domain,
          firewallProfilePrivate: { firewallEnabled: "allowed" },
          firewallProfilePublic: { firewallEnabled: "allowed" },
        }),
        "windows-firewall",
      ).status,
    ).toBe("enforced");
  });
  it("does not drop disabled duplicate catalog values", () => {
    const id = "device_vendor_msft_bitlocker_requiredeviceencryption";
    const result = capability(
      data(
        policy("deviceManagementConfigurationPolicy", {
          settings: [0, 1].map((value) => ({
            settingInstance: {
              settingDefinitionId: id,
              choiceSettingValue: { value: `${id}_${value}` },
            },
          })),
        }),
      ),
      "windows-disk-encryption",
    );
    expect(result.status).toBe("conflictingEvidence");
    expect(result.evidence.map((item) => item.verdict).sort()).toEqual([
      "disabled",
      "enforced",
    ]);
  });
  it("preserves filters and exclusions in portable evidence", () => {
    const result = capability(
      data(
        policy("windows10CompliancePolicy", {
          bitLockerEnabled: true,
          assignments: [
            {
              target: {
                ...assigned[0]!.target,
                deviceAndAppManagementAssignmentFilterId: "corporate-windows",
                deviceAndAppManagementAssignmentFilterType: "include",
              },
            },
            {
              target: {
                "@odata.type":
                  "#microsoft.graph.exclusionGroupAssignmentTarget",
                groupId: "exempt",
              },
            },
          ],
        }),
      ),
      "windows-disk-encryption",
    );
    const assignment = result.evidence[0]!.assignment;
    expect(assignment).toMatchObject({
      state: "assigned",
      exclusions: ["Group: exempt"],
      filters: [{ id: "corporate-windows", mode: "include" }],
      coverage: "unverified",
    });
    expect(assignmentDetails(assignment).join(" ")).toContain(
      "Excluded: Group: exempt",
    );
  });
  it.each([
    undefined,
    [{ target: { "@odata.type": "#microsoft.graph.futureAssignmentTarget" } }],
  ])("preserves unknown assignment state for %j", (assignments) => {
    expect(
      capability(
        data(
          policy("windows10CompliancePolicy", {
            bitLockerEnabled: true,
            assignments,
          }),
        ),
        "windows-disk-encryption",
      ).status,
    ).toBe("assignmentUnknown");
  });
  it("retains grace periods and the Conditional Access dependency", () => {
    const result = capability(
      data(
        policy("iosCompliancePolicy", {
          securityBlockJailbrokenDevices: true,
          scheduledActionsForRule: [
            {
              scheduledActionConfigurations: [
                { actionType: "block", gracePeriodHours: 720 },
              ],
            },
          ],
        }),
      ),
      "ios-jailbreak-block",
    );
    expect(result.evidence[0]?.note).toContain("720 hours");
    expect(result.evidence[0]?.note).toContain("Conditional Access");
    expect(result.status).toBe("requirementAssigned");
  });
  it("uses explicit platform scope and leaves unsupported controls unassessed", () => {
    const exportData = data(
      policy("windows10CompliancePolicy", { bitLockerEnabled: true }),
    );
    exportData.assessmentScope = { platforms: ["windows"] };
    const result = assessCompliance(exportData);
    const nist = result.frameworks.find(
      (framework) => framework.framework.id === "nist-800-53-r5",
    )!;
    expect(
      nist.controls.find((control) => control.control.id === "SC-28")
        ?.capabilityIds,
    ).toEqual(["windows-disk-encryption"]);
    const bsi = result.frameworks.find(
      (framework) => framework.framework.id === "bsi-it-grundschutz",
    )!;
    expect(
      bsi.controls.find((control) => control.control.id === "SYS.2.4.A6")
        ?.status,
    ).toBe("notApplicable");
    exportData.assessmentScope = { platforms: ["ios"] };
    const iosNist = assessCompliance(exportData).frameworks.find(
      (framework) => framework.framework.id === "nist-800-53-r5",
    )!;
    expect(
      iosNist.controls.find((control) => control.control.id === "SC-7")?.status,
    ).toBe("notApplicable");
  });
  it("does not infer scope from empty platform inventory or policy absence", () => {
    const exportData = data();
    exportData.deviceCounts = { windows: 20, macos: 0, android: 0, ios: 0 };
    expect(capability(exportData, "macos-disk-encryption").status).toBe(
      "noEvidence",
    );
  });
  it("filters Def Stan levels without changing other frameworks", () => {
    const result = assessCompliance(data(), { defStanRiskLevel: 0 });
    const defStan = result.frameworks.find(
      (framework) => framework.framework.id === "def-stan-05-138-i4",
    )!;
    expect(defStan.summary.applicableControls).toBe(0);
    expect(defStan.summary.notApplicable).toBe(defStan.summary.totalControls);
    expect(
      result.frameworks.find(
        (framework) => framework.framework.id === "iso-27001-2022",
      )?.summary.notApplicable,
    ).toBe(0);
  });
  it("keeps minimum OS evidence partial even when a value is present", () => {
    const bsi = assessCompliance(
      data(policy("macOSCompliancePolicy", { osMinimumVersion: "10.1" })),
    ).frameworks.find(
      (framework) => framework.framework.id === "bsi-it-grundschutz",
    )!;
    const control = bsi.controls.find(
      (control) => control.control.id === "SYS.2.4.A6",
    )!;
    expect(control.status).toBe("partialEvidence");
    expect(control.unassessedAspects.join(" ")).toContain("support");
  });
  it("reports collection failures as not assessed rather than absent", () => {
    const exportData = data();
    exportData.fetchErrors = [
      {
        policyId: "N/A",
        policyName: "Settings Catalog",
        policyType: "Settings Catalog",
        error: "Forbidden",
      },
    ];
    const result = assessCompliance(exportData);
    expect(
      result.collectionCoverage.find((row) => row.family === "settingsCatalog")
        ?.status,
    ).toBe("incomplete");
    expect(capability(exportData, "windows-disk-encryption").status).toBe(
      "collectionIncomplete",
    );
    expect(
      result.frameworks[0]!.controls.find(
        (control) => control.control.id === "SC-28",
      )?.status,
    ).toBe("notAssessed");
  });
});

describe("compound detectors and legacy representations", () => {
  it.each([
    ["full", "monday", "enforced"],
    ["quick", "everyday", "enforced"],
    ["disabled", "monday", "disabledByPolicy"],
    ["full", "noScheduledScan", "disabledByPolicy"],
    ["userDefined", "monday", "noEvidence"],
  ])("evaluates periodic scans %s/%s", (scan, day, status) => {
    expect(
      capability(
        data(
          policy("windows10GeneralConfiguration", {
            defenderScanType: scan,
            defenderSystemScanSchedule: day,
            defenderScheduledScanTime: "02:00:00",
          }),
        ),
        "windows-periodic-antimalware-scan",
      ).status,
    ).toBe(status);
  });
  it.each([
    [2, 7, 2, false, "enforced"],
    [8, 7, 0, false, "noEvidence"],
    [0, 7, 0, true, "disabledByPolicy"],
    [undefined, 7, 0, false, "noEvidence"],
  ])(
    "checks the complete quality-update timing tuple",
    (deferral, deadline, grace, paused, status) => {
      expect(
        capability(
          data(
            policy("windowsUpdateForBusinessConfiguration", {
              automaticUpdateMode: "autoInstallAtMaintenanceTime",
              qualityUpdatesDeferralPeriodInDays: deferral,
              deadlineForQualityUpdatesInDays: deadline,
              deadlineGracePeriodInDays: grace,
              qualityUpdatesPaused: paused,
            }),
          ),
          "windows-quality-update-deadline",
        ).status,
      ).toBe(status);
    },
  );
  it.each([
    "auditComponentsAndStoreApps",
    "auditComponentsStoreAppsAndSmartlocker",
  ])("does not count application-control audit mode %s", (mode) => {
    expect(
      capability(
        data(
          policy("windows10EndpointProtectionConfiguration", {
            appLockerApplicationControl: mode,
          }),
        ),
        "windows-application-control",
      ).status,
    ).toBe("disabledByPolicy");
  });
  it.each([
    ["enabled", "AND", ["mfa", "compliantDevice"], "enforced"],
    ["enabled", "OR", ["mfa"], "enforced"],
    ["enabled", "OR", ["mfa", "compliantDevice"], "noEvidence"],
    ["enabledForReportingButNotEnforced", "AND", ["mfa"], "noEvidence"],
    ["disabled", "AND", ["mfa"], "noEvidence"],
  ])(
    "evaluates enabled CA requirements without optional OR grants",
    (state, operator, builtInControls, status) => {
      const exportData = data();
      exportData.conditionalAccessPolicies = [
        {
          id: "ca",
          state,
          grantControls: { operator, builtInControls },
          conditions: {
            users: { includeUsers: ["All"], excludeGroups: ["emergency"] },
            applications: { includeApplications: ["All"] },
          },
        },
      ];
      const result = capability(exportData, "tenant-mfa-required");
      expect(result.status).toBe(status);
      if (status === "enforced")
        expect(result.evidence[0]?.assignment.targets.join(" ")).toContain(
          "emergency",
        );
    },
  );
  it.each([
    [{ includeUsers: ["None"] }, { includeApplications: ["All"] }],
    [{ includeUsers: ["All"] }, { includeApplications: ["None"] }],
  ])(
    "does not count a CA policy that targets the None sentinel",
    (users, applications) => {
      const exportData = data();
      exportData.conditionalAccessPolicies = [
        {
          id: "ca",
          state: "enabled",
          grantControls: { operator: "AND", builtInControls: ["mfa"] },
          conditions: { users, applications },
        },
      ];
      expect(capability(exportData, "tenant-mfa-required").status).toBe(
        "noEvidence",
      );
    },
  );
  it("does not accept an OR alternative in authentication strength as mandatory MFA", () => {
    const exportData = data();
    exportData.conditionalAccessPolicies = [
      policy("conditionalAccessPolicy", {
        state: "enabled",
        grantControls: {
          operator: "OR",
          builtInControls: ["mfa"],
          authenticationStrength: { id: "strength" },
        },
        conditions: {
          users: { includeUsers: ["All"] },
          applications: { includeApplications: ["All"] },
        },
      }),
    ];
    expect(capability(exportData, "tenant-mfa-required").status).toBe(
      "noEvidence",
    );
  });
  it("detects verified OMA-URI settings without coercing strings to numbers", () => {
    const uri = "./Device/Vendor/MSFT/BitLocker/RequireDeviceEncryption";
    expect(
      capability(
        data(
          policy("windows10CustomConfiguration", {
            omaSettings: [{ omaUri: uri, value: 1 }],
          }),
        ),
        "windows-disk-encryption",
      ).status,
    ).toBe("enforced");
    expect(
      capability(
        data(
          policy("windows10CustomConfiguration", {
            omaSettings: [{ omaUri: uri, value: "1" }],
          }),
        ),
        "windows-disk-encryption",
      ).status,
    ).toBe("noEvidence");
  });
  it("matches equivalent device-scope OMA-URI spellings, not user scope", () => {
    const status = (...uris: Array<[string, number]>) =>
      capability(
        data(
          ...uris.map(([omaUri, value], index) =>
            policy(
              "windows10CustomConfiguration",
              { omaSettings: [{ omaUri, value }] },
              `policy-${index}`,
            ),
          ),
        ),
        "windows-disk-encryption",
      ).status;
    expect(status(["./Vendor/MSFT/BitLocker/RequireDeviceEncryption", 1])).toBe(
      "enforced",
    );
    expect(
      status(
        ["./Device/Vendor/MSFT/BitLocker/RequireDeviceEncryption", 1],
        ["./Vendor/MSFT/BitLocker/RequireDeviceEncryption", 0],
      ),
    ).toBe("conflictingEvidence");
    expect(
      status(["./User/Vendor/MSFT/BitLocker/RequireDeviceEncryption", 1]),
    ).toBe("noEvidence");
  });
  it("reports an AppLocker AuditOnly override in another profile as conflicting", () => {
    const types = { EXE: "Exe", DLL: "Dll", MSI: "Msi", Script: "Script" };
    const rules = policy(
      "windows10CustomConfiguration",
      {
        omaSettings: Object.entries(types).map(([path, type]) => ({
          omaUri: `./Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/group/${path}/Policy`,
          value: `<RuleCollection Type="${type}" EnforcementMode="Enabled"><FilePathRule Id="rule" Name="Approved" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="%PROGRAMFILES%\\*"/></Conditions></FilePathRule></RuleCollection>`,
        })),
      },
      "rules",
    );
    const override = policy(
      "windows10CustomConfiguration",
      {
        omaSettings: [
          {
            omaUri:
              "./Device/Vendor/MSFT/AppLocker/ApplicationLaunchRestrictions/group/EXE/EnforcementMode",
            value: "AuditOnly",
          },
        ],
      },
      "override",
    );
    expect(
      capability(data(rules), "windows-applocker-rule-collections").status,
    ).toBe("enforced");
    expect(
      capability(data(rules, override), "windows-applocker-rule-collections")
        .status,
    ).toBe("conflictingEvidence");
  });
  it.each(["administrativeTemplate", "securityBaseline"] as const)(
    "matches exact verified %s identifiers only",
    (source) => {
      const rule: ComplianceCapability = {
        id: "fixture",
        name: "Fixture",
        description: "Adapter test",
        platform: "windows",
        signals: [
          {
            source,
            settingId: "verified-definition",
            enforcedWhen: { kind: "equals", value: true },
          },
        ],
      };
      const exportData = data(
        policy("fixture", {
          definitionValues: [
            { definition: { id: "verified-definition" }, enabled: true },
          ],
          categories: [
            {
              settings: [
                { definitionId: "verified-definition", valueJson: "true" },
              ],
            },
          ],
        }),
      );
      expect(assessCapabilities(exportData, [rule])[0]?.status).toBe(
        "enforced",
      );
      rule.signals = [
        {
          source,
          settingId: "lookalike",
          enforcedWhen: { kind: "equals", value: true },
        },
      ];
      expect(assessCapabilities(exportData, [rule])[0]?.status).toBe(
        "noEvidence",
      );
    },
  );
});

describe("enum settings left at their Graph default", () => {
  const collected = (...policies: any[]) => ({
    ...data(...policies),
    collectedAt: "2026-10-12T10:00:00Z",
  });
  it.each([
    [
      "windows-firewall",
      "windows10EndpointProtectionConfiguration",
      {
        firewallProfileDomain: { firewallEnabled: "notConfigured" },
        firewallProfilePrivate: { firewallEnabled: "notConfigured" },
        firewallProfilePublic: { firewallEnabled: "notConfigured" },
      },
    ],
    [
      "windows-telemetry-minimized",
      "windows10GeneralConfiguration",
      { diagnosticsDataSubmissionMode: "userDefined" },
    ],
    [
      "windows-office-child-process-block",
      "windows10EndpointProtectionConfiguration",
      { defenderOfficeAppsLaunchChildProcessType: "userDefined" },
    ],
  ])("reads %s as missing, not different", (id, type, settings) => {
    const result = capability(collected(policy(type, settings)), id);
    expect(result.status).toBe("noEvidence");
    expect(capabilityComparison(result)).toBe("missing");
  });
  it.each([null, "02:00:00"])(
    "reads an untouched scheduled scan with time %s as missing",
    (time) => {
      const result = capability(
        collected(
          policy("windows10GeneralConfiguration", {
            defenderScanType: "userDefined",
            defenderSystemScanSchedule: "userDefined",
            defenderScheduledScanTime: time,
          }),
        ),
        "windows-periodic-antimalware-scan",
      );
      expect(result.status).toBe("noEvidence");
      expect(capabilityComparison(result)).toBe("missing");
    },
  );
});
