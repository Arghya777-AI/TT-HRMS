/**
 * auth-session-record — the missing writer for `public.sessions_audit`.
 * Auth model **U** (user JWT; no capability — every actor records their OWN
 * session events and nobody else's).
 *
 * WHY THIS EXISTS
 * ---------------
 * A live probe of the deployed database found `sessions_audit` contained ONLY
 * `kiosk_pin` rows. Not one `password` login had ever been recorded, including
 * logins performed minutes earlier. The cause is structural, not a bug in any
 * screen: `supabase.auth.signInWithPassword()` talks straight to GoTrue and
 * never touches an edge function, so no server-side code is on that path.
 *
 * `auth-identify` (step 1 of sign-in) deliberately writes nothing — its header
 * explains that `ck_sessions_audit__event` has no `identify` value, and the
 * `login_failed` value it does have drives `sessions_audit_apply_event()`.
 * `webauthn-login` and `kiosk-operator-auth` DO write, which is exactly why the
 * only rows present were passkey and kiosk ones.
 *
 * The consequence was that the employee-facing sign-in activity trail would show
 * a confident, complete-looking list that silently omitted every web login —
 * worse than showing nothing, because the user would trust it.
 *
 * THE SECURITY PROPERTY THAT MAKES THIS SAFE
 * ------------------------------------------
 * This endpoint requires a VALID SESSION. That is not incidental — it is the
 * whole design:
 *
 *   * The subject is taken from the verified JWT (`auth.userId`) and NEVER from
 *     the request body. A caller cannot write a row against another profile.
 *   * `login_failed` is therefore impossible to reach here: you cannot hold a
 *     session for a login that failed. That matters because
 *     `sessions_audit_apply_event()` increments `profiles.failed_login_count` on
 *     `login_failed` and DEACTIVATES the account after ten rows. An
 *     unauthenticated "record an event" endpoint would be a remote
 *     "deactivate any employee" button. This one structurally cannot be.
 *   * `ip` and `user_agent` come from request headers, not the body, so they
 *     cannot be spoofed by the client beyond what the network already allows.
 *
 * WHAT IS CLIENT-ATTESTED, STATED PLAINLY
 * ---------------------------------------
 * `authMethod`, `geo` and `deviceId` are asserted by the browser. A caller with
 * a valid session could claim it signed in by `password` when it used
 * `passkey`, or send coordinates from anywhere. This is inherent to recording a
 * GoTrue-native login from outside GoTrue, and it is why:
 *   * `webauthn-login` and `face-login` write their OWN rows server-side, and
 *     the client is told not to double-record those methods here;
 *   * geolocation is presented in the UI as "reported by the device", never as
 *     a verified fact.
 * Anything security-critical must key off the server-written rows, not these.
 *
 * DPDP NOTE: coordinates are personal data. They are stored only when the user
 * granted the browser permission, the employee can see every row about
 * themselves, and nothing here is written when permission was refused — the
 * event is still recorded, just without a location.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { methodNotAllowed, ok, toProblem, unprocessable } from "../_shared/errors.ts";
import { parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import {
  clientIpFrom,
  type RequestContext,
  requestIdFrom,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";

const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * The subset of `ck_sessions_audit__event` a CLIENT may record. The full enum
 * also has login_failed, password_reset_requested, password_changed,
 * passkey_registered and session_revoked — all of which are either written
 * server-side by the function that performs them, or (login_failed) deliberately
 * unreachable from an authenticated endpoint. See the header.
 */
const CLIENT_EVENTS = ["login_success", "logout", "token_refresh", "mfa_challenge"] as const;

/** `ck_sessions_audit__auth_method`, extended with 'face' by migration 20260801012200. */
const AUTH_METHODS = ["password", "passkey", "face", "magic_link", "otp"] as const;

const bodySchema = z.object({
  event: z.enum(CLIENT_EVENTS),
  authMethod: z.enum(AUTH_METHODS).optional(),
  /**
   * Browser geolocation, when the user granted it. Bounds are validated so a
   * malformed reading is rejected rather than stored as a nonsense point.
   */
  geo: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracyMetres: z.number().nonnegative().max(100_000).optional(),
    })
    .optional(),
  /** Stable per-browser id the app generates; not a trusted identifier. */
  deviceId: z.string().min(8).max(128).optional(),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = requestIdFrom(req);
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;

  const cors = corsHeaders(req);
  const log = createLogger({ fn: "auth-session-record", requestId });

  try {
    assertOriginAllowed(req);
    if (req.method !== "POST") throw methodNotAllowed(ALLOWED_METHODS);

    // A valid session is mandatory — see the security note in the header.
    const auth = await verifyUser(req);

    await enforce(RATE_LIMITS.mutation, limitKey("session_record", auth.userId), "SESSION_RECORD_RATE_LIMITED");

    const { data: body } = await parseBody(req, bodySchema, { maxBytes: 4 * 1024 });

    // `login_success` without a method would produce a row the activity screen
    // cannot label, which is the one thing this endpoint exists to prevent.
    if (body.event === "login_success" && body.authMethod === undefined) {
      throw unprocessable(
        [{ pointer: "/authMethod", code: "required", detail: "A login_success row must say which method was used." }],
        "authMethod is required for login_success.",
        "AUTH_METHOD_REQUIRED",
      );
    }

    const geo = body.geo === undefined
      ? null
      : {
        latitude: body.geo.latitude,
        longitude: body.geo.longitude,
        accuracy_metres: body.geo.accuracyMetres ?? null,
        // Provenance, so a reader never mistakes a browser reading for a
        // server-verified location.
        source: "browser_geolocation",
      };

    // The write MUST go through `withContext`, not a plain PostgREST insert.
    // sessions_audit has an AFTER INSERT trigger, `sessions_audit_apply_event()`,
    // which projects the event onto `public.profiles` (last_login_at,
    // failed_login_count). profiles carries the audit-chain triggers, and those
    // demand the transaction context (`app.reason`, `app.source`, actor) that
    // `setContext` installs. A bare insert fails — my first attempt returned
    // audit_write_failed for exactly this reason.
    //
    // `auditSession()` from _shared/audit.ts is the usual helper and is what
    // webauthn-login uses, but its INSERT does not carry `geo`. Rather than widen
    // a shared helper, the insert is written here with the same column list plus
    // geo, inside the same single transaction.
    const ctx: RequestContext = {
      actorId: auth.userId,
      source: "web_employee",
      sourceRoute: "auth-session-record",
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      deviceId: body.deviceId ?? null,
      reason: `session event: ${body.event}`,
    };

    const row = {
      profileId: auth.userId ?? null,
      event: body.event ?? null,
      authMethod: body.authMethod ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.ua ?? null,
      deviceId: ctx.deviceId ?? null,
      geo: geo === null ? null : JSON.stringify(geo),
    };

    try {
      await withContext(ctx, async (tx) => {
        await tx`
          INSERT INTO public.sessions_audit
            (profile_id, event, auth_method, ip, user_agent, device_id, geo)
          VALUES (
            ${row.profileId}::uuid,
            ${row.event}::text,
            ${row.authMethod}::text,
            ${row.ip}::inet,
            ${row.userAgent}::text,
            ${row.deviceId}::text,
            ${row.geo}::jsonb
          )
        `;
      });
    } catch (writeErr) {
      // Never fail the caller's sign-in over an audit write. The user is already
      // authenticated by this point; refusing here would strand them on a login
      // screen for a bookkeeping error. Log loudly instead.
      log.error("sessions_audit insert failed", { err: writeErr });
      return ok(
        { recorded: false, reason: "audit_write_failed" },
        { status: 200, headers: cors, requestId },
      );
    }

    log.info("session event recorded", {
      event: body.event,
      authMethod: body.authMethod ?? null,
      hasGeo: geo !== null,
    });

    return ok({ recorded: true }, { status: 201, headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId);
    if (problem.isServerFault) log.error("unhandled failure", { err, code: problem.code });
    else log.warn("request refused", { code: problem.code });
    return problem.toResponse(cors);
  }
});
