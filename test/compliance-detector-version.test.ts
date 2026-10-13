import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_DETECTOR_VERSION } from "../src/shared/compliance/detector-version";

// Prior fingerprint entries are immutable. Adding a new version entry is the only allowed table change.
const fingerprints: Record<number, string> = {
  2: "f22c2916e8549627242224115b3bb5f810a52c3d70a7632813beda89c416ac27",
  3: "43d185f62238cafbe477637cf408ad5864adc56227f3141737be6162a6e99a29",
  4: "05cdbc32a1d40eed6fa8e8427cd0479ad6cebddcb0fdcca8fa313d00262c6c36",
  5: "12276622cd7d852a5e446343d4a31868ca2292fc8158e2a765b2eb9d21536a3a",
};
const detectorFiles = [
  "src/main/features/scores/formula.ts",
  "src/shared/compliance/framework-summary.ts",
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
  it("preserves every known previous fingerprint", () => {
    const previousFingerprints: Record<number, string> = { 2: "f22c2916e8549627242224115b3bb5f810a52c3d70a7632813beda89c416ac27", 3: "43d185f62238cafbe477637cf408ad5864adc56227f3141737be6162a6e99a29" };
    for (const [version, fingerprint] of Object.entries(previousFingerprints))
      expect(fingerprints[Number(version)], `Detector version ${version} fingerprint is immutable.`).toBe(fingerprint);
  });

  it("requires a version bump when the detector source changes", () => {
    const source = detectorFiles.map(file => `${file}\n${readFileSync(file, "utf8").replace(/\r\n/g, "\n")}`).join("\n");
    const fingerprint = createHash("sha256").update(source).digest("hex");
    expect(fingerprint, "Increment COMPLIANCE_DETECTOR_VERSION and add its fingerprint when detector logic changes.").toBe(fingerprints[COMPLIANCE_DETECTOR_VERSION]);
  });
});
