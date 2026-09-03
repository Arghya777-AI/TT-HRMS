import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const page = readFileSync(join(process.cwd(), "src/features/leave/pages/LeaveApplication.page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const launcher = readFileSync(join(process.cwd(), "src/features/apply/pages/ApplyLauncher.page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
describe("the leave form no longer contradicts itself", () => {
  it("asks for the day count instead of saying 'too many'", () => {
    expect(page).toContain('total <= 0\n                    ? t("leave.app.problem.noTotal")');
  });
  it("keeps the allocation while the Days box is being retyped", () => {
    expect(page).toContain("if (after !== before) setAllocations([]);");
    expect(page).not.toMatch(/setTotalDays\(event\.target\.value\);\s*setAllocations\(\[\]\);/);
  });
});
describe("resignation is off the Apply menu", () => {
  it("is suppressed, not deleted", () => {
    expect(launcher).toMatch(/SUPPRESSED_CODES[\s\S]{0,220}"RESIGNATION"/);
    expect(launcher).toContain('RESIGNATION: "/me/apply/resignation"');
  });
});
