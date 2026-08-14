/**
 * report-subjects.test.ts — the line a browser download must not cross.
 *
 * `exportReport` writes no `export_log` row, no content hash and no row count. It
 * is therefore sanctioned for governed analytics output the user is already
 * looking at, and NOT for statutory registers or salary-bearing extracts — those
 * are a PII egress and belong behind a server function that writes the register
 * row in the same breath as it produces the file, so the two can never disagree.
 *
 * Wiring a payroll subject to the browser engine is a ONE-LINE change that would
 * look like a helpful improvement in review. This file is what makes it fail
 * instead.
 */
import { describe, expect, it } from "vitest";
import { RENDERABLE_SUBJECTS, whyNotRenderable } from "./report-subjects";
import { reportSubjectValues, type ReportSubject } from "./scheduled-reports.api";

/** The two that carry pay. Named here as well, so the rule is not one map away. */
const PAYROLL_SUBJECTS: readonly ReportSubject[] = ["payroll_register", "payroll_statutory"];

describe("report subjects", () => {
  it("never renders a payroll subject in the browser", () => {
    for (const subject of PAYROLL_SUBJECTS) {
      expect(RENDERABLE_SUBJECTS[subject]).toBeUndefined();
      expect(whyNotRenderable(subject)).toBe("pii");
    }
  });

  it("keeps 'governed elsewhere' and 'not built yet' apart", () => {
    /*
      Two different reasons with two different fixes: one needs a server function
      and a decision about who may receive pay data, the other needs somebody to
      write a column list. Collapsing them into "unavailable" loses the only part
      that tells you who to ask.
    */
    expect(whyNotRenderable("payroll_register")).toBe("pii");
    expect(whyNotRenderable("payroll_statutory")).toBe("pii");
    expect(whyNotRenderable("attendance_muster")).toBeNull();
  });

  it("renders every subject that is not payroll", () => {
    /*
      The eight non-payroll subjects all have a renderer now. If somebody adds a
      ninth to `ck_schedrep__subject` and forgets the renderer, this fails rather
      than the screen quietly showing "no renderer yet" forever.
    */
    for (const subject of reportSubjectValues) {
      if (PAYROLL_SUBJECTS.includes(subject)) continue;
      expect(RENDERABLE_SUBJECTS[subject], `${subject} has no renderer`).toBeDefined();
    }
  });

  it("keeps headcount an aggregate rather than an employee list", () => {
    /*
      "Headcount" read literally is a dump of the employee master, which the
      export engine excludes. It is rendered from the monthly aggregate instead,
      so the file counts people without naming them.
    */
    const def = RENDERABLE_SUBJECTS.headcount;
    expect(def?.title).toMatch(/department/i);
  });

  it("only claims subjects that exist in the database vocabulary", () => {
    // A renderer keyed to a subject `ck_schedrep__subject` would refuse is a
    // renderer nothing can ever reach.
    for (const key of Object.keys(RENDERABLE_SUBJECTS)) {
      expect(reportSubjectValues).toContain(key);
    }
  });

  it("keys every renderer to its own subject", () => {
    // A copy-paste that leaves `subject` pointing at the row above would export
    // the wrong report under the right name — silent, and wrong in a file.
    for (const [key, def] of Object.entries(RENDERABLE_SUBJECTS)) {
      expect(def?.subject).toBe(key);
    }
  });

  it("gives every renderer a filename and a title", () => {
    for (const def of Object.values(RENDERABLE_SUBJECTS)) {
      expect(def?.title.length).toBeGreaterThan(0);
      expect(def?.filename.length).toBeGreaterThan(0);
    }
  });

  it("answers for every subject the database permits", () => {
    // No subject may fall through the screen's rendering decision unanswered.
    for (const subject of reportSubjectValues) {
      const why = whyNotRenderable(subject);
      const renderable = RENDERABLE_SUBJECTS[subject] !== undefined;
      expect(renderable ? why === null : why !== null).toBe(true);
    }
  });
});
