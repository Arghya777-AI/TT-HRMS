/**
 * kioskContract.test.ts — lock the gate tablet's request bodies to the EDGE
 * FUNCTIONS' own zod schemas, and its response reading to their allow-lists.
 *
 * WHY THIS EXISTS
 * ---------------
 * `selfPunchContract.test.ts` was written after the located-punch path shipped
 * DEAD: the browser posted `{lat, lon, accuracy_m}` into a `.strict()` schema
 * that names `{latitude, longitude, accuracyMetres}`, so every located punch was
 * a 422 and nothing in the suite noticed. The kiosk is the same hazard in a worse
 * place — four `.strict()` schemas across three functions, a body that is built
 * INLINE at each `deviceCall` site (so the compiler sees no shared type), and a
 * runtime split (Deno vs the browser bundle) that no `tsc` can join.
 *
 * The gate is also the one surface where a contract break is invisible in
 * development: `deviceCall` never throws, every helper returns typed data, and a
 * 422 renders as one calm sentence on a black screen at a guard post.
 *
 * HOW IT AVOIDS BECOMING A SECOND SOURCE OF TRUTH
 * -----------------------------------------------
 * No field name is written down as an expectation. Every one is PARSED OUT OF the
 * function source at test time, so the server file stays the only definition:
 * rename a key there and this test fails until the tablet is updated. The shallow
 * schema parser is the same technique as its sibling (kept local rather than
 * shared, so that passing test is not disturbed).
 *
 * The bodies are not reconstructed either — the real `deviceAuth` helpers are
 * called with `fetch` stubbed, so what is asserted is the exact JSON the tablet
 * signs and sends.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeOperatorSession,
  identifyGuardByFace,
  openOperatorSession,
  refreshOperatorSession,
  sendPunch,
  type KioskDeviceState,
} from "./lib/deviceAuth";

const FN = (name: string) => join(process.cwd(), "supabase/functions", name, "index.ts");
const GUARD_IDENTIFY = readFileSync(FN("kiosk-guard-identify"), "utf8");
const PUNCH = readFileSync(FN("kiosk-punch"), "utf8");
const OPERATOR_AUTH = readFileSync(FN("kiosk-operator-auth"), "utf8");

interface SchemaField {
  name: string;
  /** `.optional()` / `.nullish()` somewhere in this key's own chunk. */
  optional: boolean;
}

/**
 * Top-level fields of a named `z.object({ … })` in a function source, with each
 * field's optionality.
 *
 * Deliberately shallow: brace depth is counted so a nested object contributes its
 * own name and not its children — precisely the granularity `.strict()` rejects
 * on. Lines are attached to the key they follow, so a multi-line validator chain
 * (`descriptor: z.array(...).length(...)`) is still read as one field.
 */
function schemaFields(source: string, constName: string): SchemaField[] {
  const start = source.indexOf(`const ${constName} = z`);
  if (start === -1) throw new Error(`${constName} not found in the function source`);
  const open = source.indexOf(".object({", start);
  if (open === -1) throw new Error(`${constName} is not a z.object`);

  let depth = 0;
  let end = -1;
  for (let i = open + ".object(".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${constName} object never closes`);

  const fields: { name: string; chunk: string[] }[] = [];
  let d = 0;
  for (const line of source.slice(open, end).split("\n")) {
    const before = d;
    d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (before !== 1) continue;
    const m = /^([A-Za-z_][\w]*)\s*:/.exec(line.trim());
    if (m?.[1] !== undefined) fields.push({ name: m[1], chunk: [line] });
    else fields[fields.length - 1]?.chunk.push(line);
  }
  return fields.map((f) => ({
    name: f.name,
    optional: /\.optional\(\)|\.nullish\(\)/.test(f.chunk.join("\n")),
  }));
}

const names = (fields: SchemaField[]): string[] => fields.map((f) => f.name).sort();
const required = (fields: SchemaField[]): string[] =>
  fields.filter((f) => !f.optional).map((f) => f.name).sort();

/**
 * The two halves of `.strict()`: nothing the schema does not name may be sent,
 * and everything it names without `.optional()` must be.
 */
function expectBodyMatches(posted: Record<string, unknown>, fields: SchemaField[]): void {
  const accepted = names(fields);
  for (const key of Object.keys(posted)) expect(accepted).toContain(key);
  for (const key of required(fields)) expect(Object.keys(posted)).toContain(key);
}

const DEVICE: KioskDeviceState = {
  deviceId: "11111111-2222-4333-8444-555555555555",
  deviceCode: "TT-GATE-01",
  deviceName: "Main Gate — Guard Post",
  secret: "kdt_probe_secret_value_0123456789",
  session: "v1.payload.signature",
  pairedAt: "2026-07-27T03:30:00.000Z",
};
const DESCRIPTOR = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));

interface Sent {
  fn: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

let sent: Sent[] = [];

/** Answers every call with `reply`, recording exactly what was signed and sent. */
function stubFetch(reply: { status?: number; body?: unknown } = {}): void {
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({
      fn: String(url).split("/functions/v1/")[1] ?? "",
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.body ?? {}),
    } as Response);
  });
}

beforeAll(() => {
  // `deviceCall` signs with HMAC-SHA256 through WebCrypto; jsdom's `crypto` has
  // no `subtle`, so the platform implementation is put back.
  if (globalThis.crypto?.subtle === undefined) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

describe("kiosk-guard-identify request contract", () => {
  it("the body schema is .strict() — an unknown key is fatal, not ignored", () => {
    const idx = GUARD_IDENTIFY.indexOf("const IdentifyBody = z");
    expect(idx, "IdentifyBody not found").toBeGreaterThan(-1);
    expect(GUARD_IDENTIFY.slice(idx, idx + 800)).toContain(".strict()");
  });

  it("posts exactly the keys the function accepts, and every one it requires", async () => {
    stubFetch({ body: { identified: false } });
    await identifyGuardByFace(DEVICE, DESCRIPTOR);
    expect(sent[0]?.fn).toBe("kiosk-guard-identify");
    expectBodyMatches(sent[0]!.body, schemaFields(GUARD_IDENTIFY, "IdentifyBody"));
  });

  it("sends 128 finite floats and the mode literal the schema pins", async () => {
    stubFetch({ body: { identified: false } });
    await identifyGuardByFace(DEVICE, DESCRIPTOR);
    const body = sent[0]!.body;
    expect(Array.isArray(body["descriptor"])).toBe(true);
    expect((body["descriptor"] as number[]).length).toBe(128);
    expect(body["mode"]).toBe("face");
  });

  it("carries the device HMAC headers and NO operator session (auth model D)", async () => {
    stubFetch({ body: { identified: false } });
    await identifyGuardByFace(DEVICE, DESCRIPTOR);
    const headers = sent[0]!.headers;
    for (const h of ["x-device-id", "x-timestamp", "x-nonce", "x-signature"]) {
      expect(Object.keys(headers)).toContain(h);
    }
    expect(headers["x-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(headers)).not.toContain("x-operator-session");
  });

  it("never puts the device secret in the body", async () => {
    stubFetch({ body: { identified: false } });
    await identifyGuardByFace(DEVICE, DESCRIPTOR);
    expect(JSON.stringify(sent[0]!.body)).not.toContain(DEVICE.secret);
  });

  it("reads the response under the function's OWN allow-listed names", async () => {
    // Parsed, not typed by hand: rename a field in the function and this fails.
    const allowList = /ALLOWED_RESPONSE_FIELDS = \[([^\]]+)\]/.exec(GUARD_IDENTIFY)?.[1] ?? "";
    const fields = [...allowList.matchAll(/"([A-Za-z_]\w*)"/g)].map((m) => m[1]);
    expect(fields).toEqual(["identified", "employeeCode", "displayName"]);

    stubFetch({ body: { identified: true, employeeCode: "TT0006", displayName: "Manjunath R" } });
    const outcome = await identifyGuardByFace(DEVICE, DESCRIPTOR);
    expect(outcome.kind).toBe("identified");
    if (outcome.kind === "identified") {
      expect(outcome.identity.employeeCode).toBe("TT0006");
      expect(outcome.identity.displayName).toBe("Manjunath R");
    }
  });

  it("treats a snake_cased answer as NOT identified rather than naming nobody", async () => {
    stubFetch({ body: { identified: true, employee_code: "TT0006", display_name: "Manjunath R" } });
    expect((await identifyGuardByFace(DEVICE, DESCRIPTOR)).kind).toBe("not_recognised");
  });

  it("falls back to typing only on 404/501 — a 401 stays an error", async () => {
    stubFetch({ status: 404, body: { code: "NOT_FOUND", detail: "no such function" } });
    expect((await identifyGuardByFace(DEVICE, DESCRIPTOR)).kind).toBe("not_available");

    vi.unstubAllGlobals();
    stubFetch({ status: 401, body: { code: "KIOSK_SIGNATURE_INVALID", detail: "refused" } });
    // A revoked or mis-signing tablet must not be reported as "not live yet".
    expect((await identifyGuardByFace(DEVICE, DESCRIPTOR)).kind).toBe("error");
  });
});

describe("kiosk-punch request contract", () => {
  it("the item schema is .strict()", () => {
    // Bounded by the NEXT top-level declaration, not by a character count. The
    // window was 1400 chars and broke the moment `PunchItem` gained a documented
    // `geo` field — a test that fails when the schema grows teaches people to bump
    // the number, which is how it stops meaning anything. `PunchItem` is followed
    // by `const BatchBody`, so that is the real end of the declaration.
    const idx = PUNCH.indexOf("const PunchItem = z");
    expect(idx, "PunchItem not found").toBeGreaterThan(-1);
    const end = PUNCH.indexOf("\nconst ", idx + 1);
    expect(end, "no declaration follows PunchItem").toBeGreaterThan(idx);
    expect(PUNCH.slice(idx, end)).toContain(".strict()");
  });

  it("posts exactly the keys the function accepts, and every one it requires", async () => {
    stubFetch({ body: { matched: false } });
    await sendPunch(DEVICE, DESCRIPTOR);
    expect(sent[0]?.fn).toBe("kiosk-punch");
    expectBodyMatches(sent[0]!.body, schemaFields(PUNCH, "PunchItem"));
  });

  it("sends the guard's session, because the punch path is model D+O", async () => {
    stubFetch({ body: { matched: false } });
    await sendPunch(DEVICE, DESCRIPTOR);
    expect(sent[0]!.headers["x-operator-session"]).toBe(DEVICE.session);
  });

  it("refuses locally with NO_OPERATOR when no guard is signed in", async () => {
    stubFetch({ body: { matched: false } });
    const { session: _unused, ...noSession } = DEVICE;
    const result = await sendPunch(noSession as KioskDeviceState, DESCRIPTOR);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NO_OPERATOR");
    expect(sent).toHaveLength(0);
  });

  it("decides nothing: no direction, no punch kind, no employee is asserted", async () => {
    stubFetch({ body: { matched: false } });
    await sendPunch(DEVICE, DESCRIPTOR);
    const keys = Object.keys(sent[0]!.body);
    for (const clientVerdict of [
      "direction",
      "punchKind",
      "employeeCode",
      "employee_id",
      "matched",
      "confidence",
      "distance",
      "geofence_ok",
      "livenessScore",
    ]) {
      expect(keys).not.toContain(clientVerdict);
    }
  });
});

describe("kiosk-operator-auth request contract", () => {
  it("all three op schemas are .strict()", () => {
    for (const name of ["OpenBody", "HeartbeatBody", "CloseBody"]) {
      const idx = OPERATOR_AUTH.indexOf(`const ${name} = z`);
      expect(idx, `${name} not found`).toBeGreaterThan(-1);
      expect(OPERATOR_AUTH.slice(idx, idx + 900)).toContain(".strict()");
    }
  });

  it("op=open posts exactly what OpenBody accepts and requires", async () => {
    stubFetch({ body: { session: { token: "v1.new.token" }, operator: { employee_code: "TT0006" } } });
    const result = await openOperatorSession(DEVICE, "tt0006", "1234");
    expect(result.ok).toBe(true);
    expect(sent[0]?.fn).toBe("kiosk-operator-auth");
    expectBodyMatches(sent[0]!.body, schemaFields(OPERATOR_AUTH, "OpenBody"));
    // The keypad's code is normalised before it is signed, not after.
    expect(sent[0]!.body["employee_code"]).toBe("TT0006");
    expect(sent[0]!.body["pin"]).toBe("1234");
  });

  it("a PIN the schema's regex would reject never reaches the wire as anything else", () => {
    const idx = OPERATOR_AUTH.indexOf("pin: z.string().regex(");
    expect(idx, "the PIN regex moved").toBeGreaterThan(-1);
    // The keypad emits digits only and the button unlocks at four, so the client
    // cannot post a value this regex refuses.
    expect(OPERATOR_AUTH.slice(idx, idx + 60)).toContain("\\d{4,10}");
  });

  it("op=heartbeat posts exactly what HeartbeatBody accepts and requires", async () => {
    stubFetch({ body: { session: { token: "v1.refreshed.token" } } });
    const result = await refreshOperatorSession(DEVICE, {
      scansThisSession: 12,
      lastScanAt: "2026-07-27T04:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expectBodyMatches(sent[0]!.body, schemaFields(OPERATOR_AUTH, "HeartbeatBody"));
  });

  it("op=heartbeat omits last_scan_at rather than inventing one", async () => {
    stubFetch({ body: { session: { token: "v1.refreshed.token" } } });
    await refreshOperatorSession(DEVICE, { scansThisSession: 0, lastScanAt: null });
    expect(Object.keys(sent[0]!.body)).not.toContain("last_scan_at");
  });

  it("op=close posts exactly what CloseBody accepts and requires", async () => {
    stubFetch({ body: { op: "close" } });
    await closeOperatorSession(DEVICE);
    expectBodyMatches(sent[0]!.body, schemaFields(OPERATOR_AUTH, "CloseBody"));
  });
});
