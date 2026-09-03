/**
 * The location trail, as an administrator reads it.
 *
 * ── THE ONE PROPERTY THIS FILE EXISTS TO PROTECT ─────────────────────────────
 * That nobody can read a gap as an absence of person.
 *
 * `employee_location_pings` holds a sample every five minutes WHILE THE APP IS OPEN — the
 * ceiling for a web application, since `watchPosition` is suspended when the page is hidden and
 * the Geolocation API is not exposed to service workers at all. There is no native app in this
 * product to do better.
 *
 * So an empty trail means the app was closed. An administrator opening this panel to decide
 * whether somebody was where they claimed could otherwise treat missing dots as proof of
 * absence — and act on it. The caveat is therefore rendered ABOVE the points, every time, full
 * or empty, and these assertions keep it there.
 *
 * Verified against live data before shipping: four points recorded by the employee herself,
 * read back by her, read by an administrator as "4 points, furthest 2,972 m, 1 too coarse,
 * 4 off-shift, 17:53 to 19:13", and read by a colleague as zero rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COARSE_ABOVE_M, summariseTrail, type LocationPing } from "./api/locationTrail.api";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const panel = strip(read("src", "features", "admin", "components", "LocationTrailPanel.tsx"));
const page = strip(read("src", "features", "admin", "pages", "EmployeeAttendance.page.tsx"));
const api = strip(read("src", "features", "admin", "api", "locationTrail.api.ts"));

const ping = (over: Partial<LocationPing> = {}): LocationPing => ({
  id: "p1",
  employee_id: "e1",
  captured_at: "2026-09-03T12:00:00.000Z",
  ist_date: "2026-09-03",
  lat: 12.864272,
  lng: 77.563372,
  accuracy_m: 12,
  source: "web_foreground",
  within_shift: true,
  distance_m: 0,
  /* Live by default; the offline cases set it explicitly. */
  captured_offline: false,
  synced_at: null,
  ...over,
});

describe("the caveat is unavoidable", () => {
  it("renders above the points, not below them", () => {
    /*
      Somebody scanning this panel reads the first line and the dots. A limitation in a
      footnote is a limitation nobody reads.
    */
    const caveat = panel.indexOf('t("admin.trail.caveat")');
    const list = panel.indexOf("pings.map");
    expect(caveat).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(caveat);
  });

  it("renders whether the trail is full or empty", () => {
    // Outside the empty/non-empty branch entirely, so neither path can skip it.
    const caveat = panel.indexOf('t("admin.trail.caveat")');
    const branch = panel.indexOf("summary.points === 0");
    expect(caveat).toBeLessThan(branch);
  });

  it("says a gap means the app was closed, in those words", () => {
    const copy = read("src", "shared", "i18n", "keys", "claim-evidence.ts");
    expect(copy).toContain("A gap means the app was closed, not that the person was elsewhere");
  });

  it("does not describe an empty day as an absence", () => {
    const copy = read("src", "shared", "i18n", "keys", "claim-evidence.ts");
    expect(copy).toContain("The app was not open, or location was not granted");
    expect(copy).not.toMatch(/was not at (the )?(venue|work)/i);
  });
});

describe("the summary an administrator actually asked for", () => {
  it("reports the FURTHEST point, not an average", () => {
    /*
      "I just want to make sure that he is there only." An average over a day spent mostly at
      the venue would hide the hour spent somewhere else.
    */
    const s = summariseTrail([ping({ distance_m: 0 }), ping({ id: "p2", distance_m: 2972 }), ping({ id: "p3", distance_m: 40 })]);
    expect(s.furthestMetres).toBe(2972);
  });

  it("counts points taken outside the shift window", () => {
    const s = summariseTrail([ping({ within_shift: true }), ping({ id: "p2", within_shift: false })]);
    expect(s.outsideShift).toBe(1);
  });

  it("counts fixes too coarse to place anybody rather than dropping them", () => {
    /*
      An administrator reading "4 points" deserves to know one of them was accurate to
      kilometres. Filtering it away silently would overstate the trail.
    */
    const s = summariseTrail([ping(), ping({ id: "p2", accuracy_m: 4500 })]);
    expect(s.coarse).toBe(1);
    expect(s.points).toBe(2);
    expect(COARSE_ABOVE_M).toBe(2_000);
  });

  it("survives a day with no points", () => {
    expect(summariseTrail([])).toEqual({
      points: 0, firstAt: null, lastAt: null, furthestMetres: null,
      outsideShift: 0, coarse: 0, replayed: 0,
    });
  });

  it("handles numerics arriving as strings, and a null distance", () => {
    // Postgres `numeric` comes back as a string over PostgREST; Number(null) is 0, a real
    // coordinate, which is why the coercion is explicit.
    const s = summariseTrail([
      ping({ distance_m: "1500" as unknown as number }),
      ping({ id: "p2", distance_m: null, accuracy_m: null }),
    ]);
    expect(s.furthestMetres).toBe(1500);
    expect(s.coarse).toBe(0);
  });
});

describe("what the panel shows per point", () => {
  it("shows accuracy beside every fix", () => {
    // A fix good to 8 m and one good to 2 km look identical on a map.
    expect(panel).toContain('t("admin.trail.accuracy"');
    expect(panel).toContain('t("admin.trail.coarse"');
  });

  it("marks a coarse fix rather than rendering it as a place", () => {
    expect(panel).toContain("accuracy !== null && accuracy > COARSE_ABOVE_M");
  });

  it("says so when a row carries no coordinates at all", () => {
    expect(panel).toContain('t("admin.trail.noFix")');
  });

  it("links out through the shared map helper, not a hand-built URL", () => {
    expect(panel).toContain("openStreetMapUrl(fix)");
    expect(panel).not.toMatch(/https:\/\/(www\.)?(openstreetmap|google)/);
  });
});

describe("where it is mounted, and what it reads", () => {
  it("sits on the day panel, keyed to that day", () => {
    expect(page).toContain("<LocationTrailPanel employeeId={employeeId} istDate={row.ist_date} />");
  });

  it("orders the trail oldest first, because it is read as a journey", () => {
    expect(api).toContain('order: [{ column: "captured_at", ascending: true }]');
  });

  it("filters by employee and day only — RLS decides whose day it may be", () => {
    expect(api).toContain('filters: [eq("employee_id", employeeId), eq("ist_date", istDate)]');
    expect(api).not.toContain("is_admin");
    expect(api).not.toContain("admin_scope_covers");
  });

  it("bounds the read", () => {
    expect(api).toContain("limit: TRAIL_ROW_CAP");
    expect(api).toContain("TRAIL_ROW_CAP = 400");
  });
});

describe("a replayed fix is marked, not disguised", () => {
  it("counts fixes taken with no signal", () => {
    /*
      Worth its own figure. A day with many of these is a day spent somewhere without signal —
      which is itself an answer to "where were they" — and it means the trail was not live at
      the time, so nobody could have been watching it.
    */
    const s = summariseTrail([
      ping(),
      ping({ id: "p2", captured_offline: true }),
      ping({ id: "p3", captured_offline: true }),
    ]);
    expect(s.replayed).toBe(2);
    expect(s.points).toBe(3);
  });

  it("says so on the row", () => {
    expect(panel).toContain("ping.captured_offline");
    expect(panel).toContain('t("admin.trail.replayed")');
  });

  it("does not treat it as less accurate", () => {
    // GPS needs no network: an offline fix is exactly as precise as a live one, and nothing
    // here may downgrade it. Only its ARRIVAL was late.
    const s = summariseTrail([ping({ captured_offline: true, accuracy_m: 8, distance_m: 4064 })]);
    expect(s.coarse).toBe(0);
    expect(s.furthestMetres).toBe(4064);
  });
});
