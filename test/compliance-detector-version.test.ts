import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_DETECTOR_VERSION } from "../src/shared/compliance/detector-version";

// Add a new version entry when detector logic changes. Keep prior entries immutable.
const fingerprints: Record<number, string> = { 2: "f22c2916e8549627242224115b3bb5f810a52c3d70a7632813beda89c416ac27" };
const detectorFiles = [
  "src/shared/compliance/engine.ts",
  "src/shared/compliance/native.ts",
  "src/shared/compliance/policy-checks.ts",
  "src/shared/compliance/policy-check-observation.ts",
  "src/shared/compliance/assignments.ts",
  "src/shared/compliance/coverage.ts",
  "src/shared/compliance/check-results.ts",
  "src/shared/compliance/applocker.ts",
  "src/shared/compliance/oma-uri.ts",
  "src/main/frameworks/collector.ts",
];

describe("detector version contract", () => {
  it("requires a version bump when the detector source changes", () => {
    const source = detectorFiles.map(file => `${file}\n${readFileSync(file, "utf8").replace(/\r\n/g, "\n")}`).join("\n");
    const fingerprint = createHash("sha256").update(source).digest("hex");
    expect(fingerprint, "Increment COMPLIANCE_DETECTOR_VERSION and add its fingerprint when detector logic changes.").toBe(fingerprints[COMPLIANCE_DETECTOR_VERSION]);
  });
});
