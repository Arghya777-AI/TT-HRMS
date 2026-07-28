/**
 * punchLocationCoverage.test.ts — a grep guard over the punch surfaces.
 *
 * WHY A GREP TEST AND NOT A RENDER TEST
 *
 * The failure this defends against is not "the component renders wrongly" — that
 * is `punchPlace.test.ts`'s job. It is "somebody added a punch list and did not
 * show where the punch happened", or worse, "somebody selected lat and lng and
 * forgot the accuracy". Neither is visible to a type checker or to a unit test of
 * any single file, and both were REAL during this build:
 *
 *   - `punchRowSchema` (admin) carried lat and lng and no accuracy, and because
 *     the component's prop was optional at the time, the admin punch log
 *     typechecked clean and rendered "accuracy not reported" on every row for a
 *     column that was sitting in the database.
 *   - `v_team_punches` never projected the coordinate at all, so the manager
 *     screens could not answer a question the admin screens could, over identical
 *     rows.
 *
 * The accuracy pairing is now also enforced by the type system
 * (`PunchLocationColumns.location_accuracy_m` is required), which catches it at
 * the component boundary. This test catches it one step earlier — at the SCHEMA —
 * where a coordinate can be selected and never handed to the component at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `process.cwd()`, matching `src/app/link-targets.test.ts` — the repo's convention
 *  for grep guards. An `import.meta.url` relative walk resolved wrongly under the
 *  vitest transform and every assertion failed on a missing file rather than on
 *  what it was actually checking. */
const ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/**
 * Every screen that lists individual punches. Day-level screens are deliberately
 * absent — a day summary has no single coordinate, and asserting one would be
 * asserting a lie.
 */
const PUNCH_SURFACES: readonly { path: string; what: string }[] = [
  { path: "src/features/admin/pages/PunchLog.page.tsx", what: "the admin punch log" },
  { path: "src/features/admin/pages/KioskAbuse.page.tsx", what: "the abuse review queue" },
  {
    path: "src/features/attendance/components/PunchTimeline.tsx",
    what: "an employee's own day timeline",
  },
  {
    path: "src/features/attendance/components/SelfPunchCard.tsx",
    what: "the web punch confirmation",
  },
  { path: "src/features/team/pages/ReporteeProfile.page.tsx", what: "a manager's reportee scans" },
];

/**
 * Row schemas that carry a punch coordinate. Each must ALSO carry the accuracy:
 * six decimal places of latitude with no stated uncertainty is the one
 * presentation of location data that actively misleads.
 */
const PUNCH_SCHEMAS: readonly { path: string; schema: string }[] = [
  { path: "src/features/admin/api/attendance.api.ts", schema: "punchRowSchema" },
  { path: "src/features/attendance/api/attendance.api.ts", schema: "attendancePunchSchema" },
  { path: "src/features/admin/api/kiosk-governance.api.ts", schema: "abusePunchSchema" },
  { path: "src/features/team/api/team.api.ts", schema: "teamPunchSchema" },
];

describe("every per-punch surface shows where the punch happened", () => {
  for (const surface of PUNCH_SURFACES) {
    it(`${surface.what} renders PunchLocation`, () => {
      const source = read(surface.path);
      expect(
        source.includes("PunchLocation"),
        `${surface.path} lists punches but never renders PunchLocation — ${surface.what} would show a time and no place.`,
      ).toBe(true);
    });
  }
});

describe("a coordinate is never selected without its accuracy", () => {
  for (const { path, schema } of PUNCH_SCHEMAS) {
    it(`${schema} carries location_accuracy_m alongside lat/lng`, () => {
      const source = read(path);
      expect(source.includes(`${schema} = z.object(`), `${schema} not found in ${path}`).toBe(true);

      // Scoped to the schema body, so an unrelated `lat` elsewhere in a 1,400-line
      // api module cannot satisfy or break this.
      const start = source.indexOf(`${schema} = z.object(`);
      const body = source.slice(start, start + 6_000);
      const hasLat = /^\s*lat:/m.test(body);
      const hasAccuracy = /^\s*location_accuracy_m:/m.test(body);

      expect(hasLat, `${schema} should carry lat`).toBe(true);
      expect(
        hasAccuracy,
        `${schema} selects lat/lng but NOT location_accuracy_m. Every surface reading it will render "accuracy not reported" for a column that exists — the exact silent defect this test was written for.`,
      ).toBe(true);
    });
  }
});

describe("explicit column lists include the accuracy", () => {
  /*
    Two of the fetchers pass an explicit `columns:` string rather than defaulting to
    `*`. A schema field with no matching column is a PostgREST 400 at runtime and
    invisible until somebody opens the screen — so the column list and the schema
    have to be checked separately.
  */
  it("TEAM_PUNCH_COLUMNS selects lat, lng and location_accuracy_m", () => {
    const source = read("src/features/team/api/team.api.ts");
    const start = source.indexOf("const TEAM_PUNCH_COLUMNS");
    const body = source.slice(start, start + 1_200);
    for (const column of ["lat", "lng", "location_accuracy_m"]) {
      expect(body.includes(column), `TEAM_PUNCH_COLUMNS is missing ${column}`).toBe(true);
    }
  });

  it("ABUSE_COLUMNS selects lat, lng and location_accuracy_m", () => {
    const source = read("src/features/admin/api/kiosk-governance.api.ts");
    const start = source.indexOf("const ABUSE_COLUMNS");
    const body = source.slice(start, start + 1_200);
    for (const column of ["lat", "lng", "location_accuracy_m"]) {
      expect(body.includes(`"${column}"`), `ABUSE_COLUMNS is missing ${column}`).toBe(true);
    }
  });
});

describe("the geofence verdict is gone from the punch UI", () => {
  /*
    The client asked for the actual place instead of an inside/outside badge. The
    verdict's NULL case — "never evaluated", which was EVERY punch, because the
    venue has no coordinates configured — sat one word away from "outside the
    venue" on a screen a manager skims. `geofence_ok` is still written and still in
    the views; it must simply not be drawn.
  */
  const verdictKeys = [
    "admin.punch.location.inside",
    "admin.punch.location.outside",
    "admin.punch.location.notChecked",
    "me.punch.done.insideFence",
    "me.punch.done.outsideFence",
    "me.punch.done.noFence",
  ];

  for (const surface of PUNCH_SURFACES) {
    it(`${surface.what} renders no fence verdict`, () => {
      const source = read(surface.path);
      for (const key of verdictKeys) {
        expect(
          source.includes(`t("${key}")`),
          `${surface.path} still renders the geofence verdict ${key}.`,
        ).toBe(false);
      }
    });
  }
});
