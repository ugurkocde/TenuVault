import { describe, expect, it } from "vitest"
import { TRIAL_USED_MESSAGE } from "../src/shared/constants"
import { isTrialKeyRefusal } from "../src/shared/trial-notices"

describe("the shared trial key refusal predicate", () => {
  it.each([TRIAL_USED_MESSAGE, `Sign-in refused: ${TRIAL_USED_MESSAGE} Try again.`])("recognizes actions with surrounding context: %s", message => {
    expect(isTrialKeyRefusal(message)).toBe(true)
  })
  it.each(["Sign-in failed.", "Sign-in cancelled.", "This tenant already had a Pro trial.", ""])("leaves other errors eligible for feedback: %s", message => {
    expect(isTrialKeyRefusal(message)).toBe(false)
  })
})
