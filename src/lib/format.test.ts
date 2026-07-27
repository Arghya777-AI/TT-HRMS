import { describe, expect, it } from "vitest";
import {
  dash,
  formatNumber,
  formatPercent,
  formatShare,
  maskAadhaar,
  maskAccount,
  maskPan,
  maskTail,
} from "./format";

describe("formatNumber (Indian grouping)", () => {
  it("groups the Indian way", () => {
    expect(formatNumber(220000)).toBe("2,20,000");
    expect(formatNumber(110000)).toBe("1,10,000");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(null)).toBe("—");
  });
});

describe("formatPercent (already a percentage; just append %)", () => {
  it("does not re-multiply", () => {
    expect(formatPercent(17)).toBe("17.0%");
    expect(formatPercent(75.25, { digits: 2 })).toBe("75.25%");
    expect(formatPercent(null)).toBe("—");
  });
  it("clamps shares when asked", () => {
    expect(formatPercent(140, { clamp: true })).toBe("100.0%");
    expect(formatPercent(-5, { clamp: true })).toBe("0.0%");
  });
});

describe("formatShare guards divide-by-zero", () => {
  it("returns an em dash when the denominator is zero", () => {
    expect(formatShare(3, 0)).toBe("—");
    expect(formatShare(3, 4)).toBe("75.0%");
  });
});

describe("PII masking (§P4)", () => {
  it("masks tails", () => {
    expect(maskTail("1234567890")).toBe("XXXXXX7890");
    expect(maskAccount("50100234567890")).toBe("XXXXXXXXXX7890");
  });
  it("masks PAN keeping first 4 + last 1", () => {
    expect(maskPan("CWOPB1234Q")).toBe("CWOPXXXXXQ");
  });
  it("masks Aadhaar to last 4 only", () => {
    expect(maskAadhaar("234512340484")).toBe("XXXX XXXX 0484");
    expect(maskAadhaar("2345")).toBe("—");
  });
});

describe("dash renders empties as em dash, never 0/blank", () => {
  it("handles empties", () => {
    expect(dash(null)).toBe("—");
    expect(dash("")).toBe("—");
    expect(dash("  ")).toBe("—");
    expect(dash("Banquet")).toBe("Banquet");
    expect(dash(0)).toBe("0");
  });
});
