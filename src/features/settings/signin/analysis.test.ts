/**
 * analysis.test.ts — guards the four claims the sign-in trail makes about a row.
 *
 * What is actually at stake, in the order it would hurt:
 *  1. A place must never be invented. `geo = null` (which is EVERY row this build
 *     writes today — no auth path populates the column) must resolve to "no place",
 *     and an IP address must never become one. A location trail an employee cannot
 *     dispute is the one thing worse than no trail at all.
 *  2. "New device" must mean first-ever, so it is only emitted when the caller can
 *     prove the rows are the whole history, and never on the earliest event, which
 *     has nothing before it to be new against.
 *  3. Out-of-hours is an IST wall-clock fact. 20:00 UTC is 01:30 IST — the check
 *     must flag it. Getting this from the UTC hour is the bug class this repo was
 *     built to make unrepresentable.
 *  4. A `login_success` is described by its METHOD, and an unknown event value is
 *     still rendered rather than dropped.
 */
import { describe, expect, it } from "vitest";
import {
  buildSignInTrail,
  describeSignInEvent,
  isOutsideNormalHours,
  readDevice,
  readPlace,
  signInMethodLabel,
} from "./analysis";
import type { SignInEventRow } from "../api/signin-activity.api";

function row(overrides: Partial<SignInEventRow> & { id: string; recorded_at: string }): SignInEventRow {
  return {
    event: "login_success",
    auth_method: "passkey",
    ip: null,
    user_agent: null,
    device_id: null,
    geo: null,
    failure_reason: null,
    attempted_email: null,
    ...overrides,
  };
}

describe("readPlace", () => {
  it("returns null for the shapes the deployed writers actually produce", () => {
    expect(readPlace(null)).toBeNull();
    expect(readPlace(undefined)).toBeNull();
    expect(readPlace({})).toBeNull();
    expect(readPlace([])).toBeNull();
    expect(readPlace("Bengaluru")).toBeNull();
  });

  it("never derives a place from an address-shaped payload", () => {
    // `ip` lives in its own column and is shown as an address. Even if something
    // put one in `geo`, no place may come out of it.
    expect(readPlace({ ip: "203.0.113.7" })).toBeNull();
  });

  it("names a place when the row carried one", () => {
    const place = readPlace({ city: "Bengaluru", region: "Karnataka", country: "IN" });
    expect(place?.label).toBe("Bengaluru, Karnataka, IN");
    expect(place?.hasCoordinates).toBe(false);
  });

  it("falls back to coordinates, stated as coordinates", () => {
    const place = readPlace({ latitude: 12.97159, longitude: "77.59457", accuracy_m: 35.4 });
    expect(place?.label).toContain("12.9716");
    expect(place?.label).toContain("77.5946");
    expect(place?.hasCoordinates).toBe(true);
    expect(place?.accuracy).toContain("35");
  });
});

describe("readDevice", () => {
  it("names a browser and platform, keeping the raw agent for the detail block", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
    const device = readDevice({ device_id: null, user_agent: ua, auth_method: "password" });
    expect(device.label).toBe("Chrome on Android");
    expect(device.userAgent).toBe(ua);
    expect(device.key).toBe(ua);
  });

  it("calls a kiosk PIN sign-in what it is", () => {
    const device = readDevice({ device_id: "kiosk-gate-1", user_agent: null, auth_method: "kiosk_pin" });
    expect(device.label).toBe("Kiosk device at the venue");
    expect(device.key).toBe("kiosk-gate-1");
  });

  it("says so when neither a device id nor an agent was recorded", () => {
    const device = readDevice({ device_id: null, user_agent: null, auth_method: null });
    expect(device.label).toBe("Device not recorded");
    expect(device.key).toBeNull();
  });
});

describe("isOutsideNormalHours", () => {
  it("uses the IST wall clock, not the UTC hour", () => {
    // 2026-07-25T20:00:00Z = 01:30 IST on the 26th — out of hours.
    expect(isOutsideNormalHours("2026-07-25T20:00:00Z")).toBe(true);
    // 2026-07-25T04:00:00Z = 09:30 IST — an ordinary morning.
    expect(isOutsideNormalHours("2026-07-25T04:00:00Z")).toBe(false);
    // 2026-07-25T16:00:00Z = 21:30 IST — from 21:00, so out of hours.
    expect(isOutsideNormalHours("2026-07-25T16:00:00Z")).toBe(true);
  });
});

describe("describeSignInEvent and signInMethodLabel", () => {
  it("describes a success by its method", () => {
    expect(describeSignInEvent({ event: "login_success", auth_method: "password" })).toBe(
      "You signed in with your password",
    );
    expect(describeSignInEvent({ event: "login_success", auth_method: "kiosk_pin" })).toBe(
      "You were signed in at a kiosk with your PIN",
    );
    expect(describeSignInEvent({ event: "login_success", auth_method: null })).toBe("You signed in");
  });

  /**
   * `face-login` writes ONE row: `login_success` with `auth_method = 'face'`
   * (migration 20260801012200 extends `ck_sessions_audit__auth_method`). If this
   * ever falls back to the generic sentence, the employee's own record stops
   * telling them their face opened the session — the single fact they would most
   * need to dispute.
   */
  it("names a face sign-in as a face sign-in, not a generic one", () => {
    expect(describeSignInEvent({ event: "login_success", auth_method: "face" })).toBe(
      "You signed in with your face",
    );
    expect(signInMethodLabel("face")).toBe("Face");
  });

  it("renders an event value the CHECK constraint has grown, rather than dropping it", () => {
    expect(describeSignInEvent({ event: "impersonation_started", auth_method: null })).toContain(
      "impersonation_started",
    );
  });

  it("has a label for all six permitted methods and for NULL", () => {
    expect(signInMethodLabel("password")).toBe("Password");
    expect(signInMethodLabel("passkey")).toBe("Passkey");
    expect(signInMethodLabel("magic_link")).toBe("Email link");
    expect(signInMethodLabel("otp")).toBe("One-time code");
    expect(signInMethodLabel("kiosk_pin")).toBe("Kiosk PIN");
    expect(signInMethodLabel("face")).toBe("Face");
    expect(signInMethodLabel(null)).toBe("Method not recorded");
  });
});

describe("buildSignInTrail", () => {
  const oldPhone = "Mozilla/5.0 (iPhone) AppleWebKit/605.1 Safari/604.1";
  const newLaptop = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

  // Newest first, as the read returns them.
  const rows: readonly SignInEventRow[] = [
    row({ id: "c", recorded_at: "2026-07-25T05:00:00Z", user_agent: newLaptop }),
    row({ id: "b", recorded_at: "2026-07-24T05:00:00Z", user_agent: oldPhone }),
    row({ id: "a", recorded_at: "2026-07-23T05:00:00Z", user_agent: oldPhone }),
  ];

  it("flags the new device and never the earliest event", () => {
    const trail = buildSignInTrail(rows, { historyComplete: true });
    const byId = new Map(trail.map((r) => [r.id, r]));
    expect(byId.get("c")?.flags).toContain("newDevice");
    expect(byId.get("b")?.flags).not.toContain("newDevice");
    // 'a' is the oldest row: nothing came before it, so nothing is "new".
    expect(byId.get("a")?.flags).not.toContain("newDevice");
  });

  it("withholds novelty entirely when the history is truncated", () => {
    const trail = buildSignInTrail(rows, { historyComplete: false });
    for (const view of trail) {
      expect(view.flags).not.toContain("newDevice");
      expect(view.flags).not.toContain("newPlace");
    }
  });

  it("keeps the caller's newest-first order", () => {
    const trail = buildSignInTrail(rows, { historyComplete: true });
    expect(trail.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("marks the row that came from this very browser", () => {
    const trail = buildSignInTrail(rows, { historyComplete: true, currentUserAgent: oldPhone });
    const byId = new Map(trail.map((r) => [r.id, r]));
    expect(byId.get("b")?.flags).toContain("thisBrowser");
    expect(byId.get("c")?.flags).not.toContain("thisBrowser");
  });

  it("flags a refusal from the event and from a stated reason", () => {
    const trail = buildSignInTrail(
      [
        row({ id: "f1", recorded_at: "2026-07-25T05:00:00Z", event: "login_failed", auth_method: "password", failure_reason: "wrong password" }),
        row({ id: "f2", recorded_at: "2026-07-24T05:00:00Z", event: "mfa_challenge", auth_method: null, failure_reason: "code expired" }),
      ],
      { historyComplete: true },
    );
    expect(trail[0]?.flags).toContain("failed");
    expect(trail[1]?.flags).toContain("failed");
  });

  it("says the location was not shared when geo is null, which is every row today", () => {
    const trail = buildSignInTrail(rows, { historyComplete: true });
    for (const view of trail) expect(view.place).toBeNull();
  });

  it("flags a genuinely new place once one has been recorded before", () => {
    const trail = buildSignInTrail(
      [
        row({ id: "p2", recorded_at: "2026-07-25T05:00:00Z", geo: { city: "Mysuru" } }),
        row({ id: "p1", recorded_at: "2026-07-24T05:00:00Z", geo: { city: "Bengaluru" } }),
      ],
      { historyComplete: true },
    );
    const byId = new Map(trail.map((r) => [r.id, r]));
    expect(byId.get("p2")?.flags).toContain("newPlace");
    expect(byId.get("p1")?.flags).not.toContain("newPlace");
  });
});
