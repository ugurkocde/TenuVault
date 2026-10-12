import { COMPLIANCE_CAPABILITIES } from "./capabilities";
import type { FrameworkDefinition } from "./types";

/** Keep original prose, but derive capability lists from the mappings used by evaluation. */
export function withCapabilitySummaries(framework: FrameworkDefinition): FrameworkDefinition {
  for (const control of Object.values(framework.controls)) {
    const names = Object.entries(framework.mappings)
      .filter(([, ids]) => ids.includes(control.id))
      .map(([id]) => COMPLIANCE_CAPABILITIES.find(capability => capability.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length) control.summary = `TenuVault compares selected capabilities: ${names.join(", ")}. ${control.summary}`;
  }
  return framework;
}
