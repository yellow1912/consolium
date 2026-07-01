import { test, expect, describe } from "bun:test"
import { applyEvidenceGate, getVerificationFallbackVerdict, isEvidenceTrivial } from "./index"

describe("applyEvidenceGate", () => {
  test("step WITHOUT requiresVerification + approved + no evidence → stays approved", () => {
    const result = applyEvidenceGate(false, "approved", undefined)
    expect(result.verdict).toBe("approved")
    expect(result.downgraded).toBe(false)
  })

  test("step WITHOUT requiresVerification (undefined) + approved + no evidence → stays approved", () => {
    const result = applyEvidenceGate(undefined, "approved", undefined)
    expect(result.verdict).toBe("approved")
    expect(result.downgraded).toBe(false)
  })

  test("step WITH requiresVerification + approved + no evidence → downgraded to changes_requested", () => {
    const result = applyEvidenceGate(true, "approved", undefined)
    expect(result.verdict).toBe("changes_requested")
    expect(result.downgraded).toBe(true)
  })

  test("step WITH requiresVerification + approved + empty evidence → downgraded to changes_requested", () => {
    const result = applyEvidenceGate(true, "approved", "")
    expect(result.verdict).toBe("changes_requested")
    expect(result.downgraded).toBe(true)
  })

  test("step WITH requiresVerification + approved + whitespace-only evidence → downgraded to changes_requested", () => {
    const result = applyEvidenceGate(true, "approved", "   ")
    expect(result.verdict).toBe("changes_requested")
    expect(result.downgraded).toBe(true)
  })

  test("step WITH requiresVerification + approved + real evidence (contains $ and exit 0) → stays approved", () => {
    const evidence = "$ bun test\nAll tests passed in 42ms\nexit 0"
    const result = applyEvidenceGate(true, "approved", evidence)
    expect(result.verdict).toBe("approved")
    expect(result.downgraded).toBe(false)
  })

  test("step WITH requiresVerification + approved + trivial evidence ('should work now') → downgraded", () => {
    const result = applyEvidenceGate(true, "approved", "should work now")
    expect(result.verdict).toBe("changes_requested")
    expect(result.downgraded).toBe(true)
  })

  test("step WITH requiresVerification + changes_requested verdict → unchanged regardless of evidence", () => {
    const result = applyEvidenceGate(true, "changes_requested", undefined)
    expect(result.verdict).toBe("changes_requested")
    expect(result.downgraded).toBe(false)
  })
})

describe("getVerificationFallbackVerdict (parse-failure behavior)", () => {
  test("step WITH requiresVerification + parse failure → changes_requested (not approved)", () => {
    expect(getVerificationFallbackVerdict(true)).toBe("changes_requested")
  })

  test("step WITHOUT requiresVerification + parse failure → approved (legacy behavior)", () => {
    expect(getVerificationFallbackVerdict(false)).toBe("approved")
  })

  test("step WITHOUT requiresVerification (undefined) + parse failure → approved (legacy behavior)", () => {
    expect(getVerificationFallbackVerdict(undefined)).toBe("approved")
  })
})

describe("isEvidenceTrivial", () => {
  test("'should work now' is trivial without terminal markers", () => {
    expect(isEvidenceTrivial("should work now")).toBe(true)
  })

  test("'previous run showed OK' is trivial (matches previous run show)", () => {
    expect(isEvidenceTrivial("previous run showed all passing")).toBe(true)
  })

  test("'it should pass' is trivial without terminal markers", () => {
    expect(isEvidenceTrivial("it should pass based on the logic")).toBe(true)
  })

  test("'looks good' is trivial without terminal markers", () => {
    expect(isEvidenceTrivial("looks good to me")).toBe(true)
  })

  test("'trust me' is trivial without terminal markers", () => {
    expect(isEvidenceTrivial("trust me it works")).toBe(true)
  })

  test("evidence with $ terminal marker is NOT trivial", () => {
    expect(isEvidenceTrivial("$ bun test\nshould work now")).toBe(false)
  })

  test("evidence with exit keyword is NOT trivial", () => {
    expect(isEvidenceTrivial("exit 0 — should work now")).toBe(false)
  })

  test("evidence with PASS marker is NOT trivial", () => {
    expect(isEvidenceTrivial("PASS: 5 tests — looks good")).toBe(false)
  })

  test("evidence with digit+ms is NOT trivial", () => {
    expect(isEvidenceTrivial("ran in 123ms — looks good")).toBe(false)
  })

  test("evidence with backtick is NOT trivial", () => {
    expect(isEvidenceTrivial("`bun test` — looks good")).toBe(false)
  })

  test("evidence with Error marker is NOT trivial", () => {
    expect(isEvidenceTrivial("Error: 0 failures found — looks good")).toBe(false)
  })

  test("evidence with 0 failures is NOT trivial", () => {
    expect(isEvidenceTrivial("0 failures — looks good")).toBe(false)
  })

  test("unrelated text without trivial phrases is NOT trivial", () => {
    expect(isEvidenceTrivial("The implementation handles edge cases by checking null.")).toBe(false)
  })
})
