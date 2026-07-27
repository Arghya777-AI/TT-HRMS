/**
 * employee-account-create — catalogue #17, auth model **U+**
 * (`employee.account.create`, which `public.role_capabilities` marks
 * `requires_step_up`).
 *
 * Gives an existing `public.employees` row a login, and NOTHING else:
 *
 *   1. an `auth.users` row created through the ADMIN API with a printable
 *      temporary password;
 *   2. `public.profiles` reconciled and `must_change_password = true`;
 *   3. `employees.profile_id` pointed at the new user;
 *   4. the `employee` role only — never manager, admin or super_admin.
 *
 * "WITHOUT DISTURBING THE ADMIN'S SESSION" — the mechanism, since that is the
 * whole point of this endpoint existing:
 *   `supabase.auth.signUp()` / `signInWithPassword()` REPLACE the session on the
 *   client that calls them, which is why creating a colleague's login from the
 *   browser would sign the admin out and in as the new employee. This function
 *   instead calls `auth.admin.createUser()` with the service-role key, server
 *   side. That call mints no session, sets no cookie, returns no refresh token,
 *   and touches no other user's tokens: the admin's tab is untouched because the
 *   admin's tab never authenticated anything. The service-role key never leaves
 *   the function (spec-architecture §5).
 *
 * THE TEMPORARY PASSWORD IS SHOWN EXACTLY ONCE. It is returned in the live
 * response for the admin to print or read out (Q19: ops staff have no company
 * email; the default is a printed slip plus a forced change), and then:
 *   - the copy stored under the idempotency key is REDACTED, so a replay returns
 *     the account without the secret — a retry must not be a way to re-read it;
 *   - `log.ts`'s redactor drops any field whose name matches /password/, so it
 *     cannot reach a log line;
 *   - nothing writes it to the database. `auth.users` holds only bcrypt.
 * Losing it is not a problem: the recovery path is a password reset, not a
 * lookup.
 *
 * WHAT THIS FUNCTION REFUSES TO DO, on purpose:
 *   - grant any role beyond `employee` — `role.grant` is a super_admin
 *     capability with its own step-up and its own audit action (`grant_role`);
 *   - create the employee record. It must already exist (see `employee-import`
 *     or `employee.create`), because a login without an HR record is exactly the
 *     orphan `verifyUser` refuses to authenticate;
 *   - give a login to someone who has left. `exited` / `retired` / `absconding`
 *     is a 409, not a silent success.
 *
 * DB GAPS (reported, not invented):
 *   - There is no `portal_state` column anywhere in migrations 001–050. The
 *     invited state is therefore DERIVED and returned as `portalState`, from
 *     facts that DO exist: a profile that is active, has
 *     `must_change_password = true` and has never logged in is `invited`; once
 *     `last_login_at` is set it is `active`; `is_active = false` is `disabled`.
 *     A real column (or a view) would be better and is worth a migration.
 *   - `ck_sessions_audit__event` has no `account_created` value, so the security
 *     timeline records the true and permitted `password_changed` (an admin set
 *     this account's password) rather than inventing an enum value.
 *   - Supabase Auth needs an email address, and Q19's default login identity is
 *     the employee CODE. Until a `security.login_email_domain` setting exists,
 *     this function requires an address it can use and says so in the 422 rather
 *     than fabricating a domain.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  conflict,
  methodNotAllowed,
  notFound,
  ok,
  serverError,
  toProblem,
  unprocessable,
} from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { toIso } from "../_shared/datetime.ts";
import {
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { requireCapWithStepUp, verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";
import {
  claim,
  release,
  replayResponse,
  requestHash,
  requireIdempotencyKey,
  store,
} from "../_shared/idempotency.ts";
import { auditSession, writeAudit } from "../_shared/audit.ts";

const FN_NAME = "employee-account-create";
const CAP = "employee.account.create";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** Never below this, whatever `security.password_min_length` says. */
const TEMP_PASSWORD_MIN_LENGTH = 14;
const TEMP_PASSWORD_MAX_LENGTH = 32;

/** Statuses that must not be given a new login. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["exited", "retired", "absconding"]);

const Body = z
  .object({
    /** Identify the employee by id or by code — exactly one. */
    employeeId: common.uuid.optional(),
    employeeCode: common.employeeCode.optional(),
    /**
     * Login address. Optional: the employee's `work_email`, else
     * `personal_email`, is used when present.
     */
    loginEmail: common.email.optional(),
    /** Written to `profiles.locale`; the UI is English at v1 (A-8). */
    locale: z.enum(["en-IN", "kn-IN"]).default("en-IN"),
    reason: common.reason,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.employeeId === undefined) === (value.employeeCode === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["employeeId"],
        message: "Give either employeeId or employeeCode, not both and not neither.",
      });
    }
  });

// ═════════════════════════════════════════════════════════════════════════════
// Temporary password
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Alphabets chosen for a password that will be READ ALOUD at a gate office or
 * copied off a printed slip: no `O`/`0`, no `I`/`l`/`1`, no punctuation that
 * differs between keyboard layouts.
 */
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "@#$%*+=?";
const PW_ALL = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;

/**
 * Uniform random index. Rejection sampling, not `% length`: modulo would bias the
 * first few characters of every alphabet, and a biased temporary password is a
 * smaller keyspace than it looks.
 */
function randomIndex(bound: number): number {
  const limit = Math.floor(256 / bound) * bound;
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0] as number;
    if (byte < limit) return byte % bound;
  }
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)] as string;
}

/** One character from each class, then fill, then a Fisher-Yates shuffle. */
function generateTempPassword(length: number): string {
  const size = Math.min(TEMP_PASSWORD_MAX_LENGTH, Math.max(TEMP_PASSWORD_MIN_LENGTH, length));
  const chars = [pick(PW_UPPER), pick(PW_LOWER), pick(PW_DIGIT), pick(PW_SYMBOL)];
  while (chars.length < size) chars.push(pick(PW_ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    const swap = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = swap;
  }
  return chars.join("");
}

// ═════════════════════════════════════════════════════════════════════════════
// Employee lookup
// ═════════════════════════════════════════════════════════════════════════════

interface EmployeeRow {
  id: string;
  employee_code: string;
  display_name: string;
  first_name: string;
  last_name: string;
  work_email: string | null;
  personal_email: string | null;
  mobile: string | null;
  employment_status: string;
  profile_id: string | null;
  existing_profile_email: string | null;
  in_scope: boolean;
}

/** `portal_state` does not exist as a column — this is the derivation (see header). */
function derivePortalState(input: {
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}): "invited" | "active" | "disabled" {
  if (!input.isActive) return "disabled";
  if (input.lastLoginAt === null && input.mustChangePassword) return "invited";
  return "active";
}

// ═════════════════════════════════════════════════════════════════════════════
// Handler
// ═════════════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request): Promise<Response> => {
  // ── STEP 1 · OPTIONS / CORS ────────────────────────────────────────────────
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  // ── STEP 2 · Method allowlist ──────────────────────────────────────────────
  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  // ── STEP 3 · request_id + timer ────────────────────────────────────────────
  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;

  let status = 500;
  let idempotencyKey: string | null = null;
  /** Set once the auth user exists, so a failed transaction can undo it. */
  let createdUserId: string | null = null;
  /**
   * True the instant the business transaction COMMITS. After that the account is
   * real and must survive any later failure (a logging or idempotency-store
   * hiccup): deleting the auth user then would cascade the profile away and leave
   * audit rows describing an account that no longer exists.
   */
  let committed = false;

  try {
    assertOriginAllowed(req);

    // ── STEP 4 · Auth (model U+) ────────────────────────────────────────────
    const auth = await verifyUser(req);
    const db = sql();

    // ── STEP 5 · Authority, from the DATABASE ───────────────────────────────
    await requireCapWithStepUp(db, auth, CAP);

    // ── STEP 6 · Rate limit ─────────────────────────────────────────────────
    await enforce(RATE_LIMITS.mutation, limitKey(FN_NAME, auth.userId), "ACCOUNT_CREATE_RATE_LIMITED");

    // ── STEP 7 · Validate ───────────────────────────────────────────────────
    const { data: body, raw } = await parseBody(req, Body);

    // ── STEP 8 · Idempotency claim ──────────────────────────────────────────
    // Mandatory: a retried create would either 409 on the email or, worse, mint a
    // second login for the same person.
    idempotencyKey = requireIdempotencyKey(req);
    const claimed = await claim({
      key: idempotencyKey,
      fnName: FN_NAME,
      requestHash: await requestHash(FN_NAME, raw, auth.userId),
      actorId: auth.userId,
    });
    if (claimed.state === "replay") {
      status = claimed.status;
      log.info("idempotent replay", { key: idempotencyKey });
      return replayResponse(claimed, { ...cors, "x-request-id": requestId });
    }

    const ctx: RequestContext = {
      actorId: auth.userId,
      actorRole: auth.role,
      source: "web_admin",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      // `public.employees` and `public.profiles` updates below are audited, and
      // `employees` is in `audit.reason_required_tables`.
      reason: body.reason,
    };

    // ── Resolve the employee, inside the caller's own scope ─────────────────
    // `app.admin_scope_covers()` reads `app.actor_id`, so the read happens inside
    // a context transaction. Out-of-scope and absent are indistinguishable to the
    // caller (§4: "404, never exists-but-forbidden").
    const employee = await withContext(ctx, async (tx) => {
      const rows = await tx`
        SELECT e.id,
               e.employee_code,
               e.display_name,
               e.first_name,
               e.last_name,
               e.work_email,
               e.personal_email,
               e.mobile,
               e.employment_status::text            AS employment_status,
               e.profile_id,
               p.email                              AS existing_profile_email,
               (app.is_super_admin() OR app.admin_scope_covers(e.id)) AS in_scope
          FROM public.employees e
          LEFT JOIN public.profiles p ON p.id = e.profile_id
         WHERE e.deleted_at IS NULL
           AND (${body.employeeId ?? null}::uuid IS NULL OR e.id = ${body.employeeId ?? null}::uuid)
           AND (${body.employeeCode ?? null}::text IS NULL
                OR upper(e.employee_code) = upper(${body.employeeCode ?? null}::text))
         LIMIT 1
      `;
      return firstRow(rows as unknown as EmployeeRow[]);
    });

    if (employee === null || employee.in_scope !== true) {
      throw notFound("No such employee, or they are outside your scope.", "EMPLOYEE_NOT_FOUND");
    }
    if (employee.profile_id !== null) {
      throw conflict(
        `${employee.employee_code} already has a login (${employee.existing_profile_email ?? "linked"}). ` +
          "Reset the password instead of creating a second account.",
        "ACCOUNT_ALREADY_EXISTS",
      );
    }
    if (CLOSED_STATUSES.has(employee.employment_status)) {
      throw conflict(
        `${employee.employee_code} is ${employee.employment_status}; a login is not created for a ` +
          "closed record.",
        "EMPLOYMENT_CLOSED",
      );
    }

    // ── Login address ───────────────────────────────────────────────────────
    // Preference order: an address the caller supplied, then the employee's own
    // work or personal address. Only when there is NOTHING on record do we fall
    // back to a login IDENTITY minted from the employee code and the configured
    // `security.login_email_domain` (migration 063). That setting is deliberately
    // a `.invalid` domain by default (RFC 2606), so a synthesised identity can
    // never be mistaken for a mailbox — see the migration for the consequences,
    // chiefly that such an account cannot receive password-reset mail and is
    // recovered by an admin reset.
    //
    // The domain is read from settings rather than hardcoded because it must
    // become the venue's real domain the moment they own one, without a deploy.
    let email = (body.loginEmail ?? employee.work_email ?? employee.personal_email ?? "")
      .trim()
      .toLowerCase();

    if (email === "") {
      const { data: domainRow } = await serviceClient()
        .from("settings")
        .select("value")
        .eq("key", "security.login_email_domain")
        .maybeSingle();

      const domain = typeof domainRow?.value === "string" ? domainRow.value.trim().toLowerCase() : "";
      if (domain !== "") {
        email = `${employee.employee_code.trim().toLowerCase()}@${domain}`;
      }
    }

    if (email === "") {
      throw unprocessable(
        [{
          pointer: "/loginEmail",
          code: "required",
          detail: "This employee has no work or personal email on record, and no " +
            "`security.login_email_domain` setting is configured to mint a login identity from " +
            "their employee code. Add an address to the employee record, pass loginEmail, or " +
            "configure that setting — an address is never invented here.",
        }],
        "No login address is available for this employee.",
        "LOGIN_EMAIL_REQUIRED",
      );
    }

    // `profiles` is 1:1 with `auth.users`, so this is the cheap, RLS-free way to
    // detect a collision without paging the Auth admin API.
    const collisionRows = await db`
      SELECT p.id, e.employee_code
        FROM public.profiles p
        LEFT JOIN public.employees e ON e.profile_id = p.id AND e.deleted_at IS NULL
       WHERE lower(p.email) = ${email}
       LIMIT 1
    `;
    const collision = firstRow(collisionRows as unknown as { id: string; employee_code: string | null }[]);
    if (collision !== null) {
      throw conflict(
        `${email} is already the login for ${collision.employee_code ?? "another account"}.`,
        "EMAIL_ALREADY_IN_USE",
      );
    }

    // ── Temporary password ──────────────────────────────────────────────────
    // Length comes from `settings` (`security.password_min_length`) so policy is
    // configuration, not a constant in 27 functions (P11).
    const settingRows = await db`SELECT app.setting('security.password_min_length') AS value`;
    const configured = Number((settingRows as unknown as { value: string | null }[])[0]?.value ?? "");
    const tempPassword = generateTempPassword(
      Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) + 4 : TEMP_PASSWORD_MIN_LENGTH,
    );

    // ── Create the auth user (admin API — no session anywhere is touched) ────
    const fullName = employee.display_name !== ""
      ? employee.display_name
      : `${employee.first_name} ${employee.last_name}`.trim();

    const createResult = await serviceClient().auth.admin.createUser({
      email,
      password: tempPassword,
      // No verification email: the credential is handed over in person, and
      // `hr@tamarindtree.co` deliverability is a comms-layer concern.
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        // `handle_new_user()` (migration 004 §8.1) reads this to create the
        // `profiles` row and link the employee by code. Belt and braces: the
        // transaction below asserts the linkage rather than trusting it.
        employee_code: employee.employee_code,
      },
      app_metadata: { created_by_fn: FN_NAME, request_id: requestId },
    });
    if (createResult.error !== null || createResult.data.user === null) {
      const message = createResult.error?.message ?? "unknown";
      log.error("auth admin createUser failed", { err: createResult.error });
      // A duplicate is the one failure the caller can act on.
      if (/already|registered|exists/i.test(message)) {
        throw conflict(`${email} is already registered as a login.`, "EMAIL_ALREADY_IN_USE", {
          cause: createResult.error,
        });
      }
      throw serverError(requestId, "The login could not be created. Nothing was changed.", {
        code: "AUTH_CREATE_FAILED",
        cause: createResult.error,
      });
    }
    createdUserId = createResult.data.user.id;

    // ── STEP 9/10 · One transaction: profile, linkage, role, audit ──────────
    const result = await withContext(ctx, async (tx) => {
      const userId = createdUserId as string;

      // `handle_new_user()` has already inserted the profile in its own
      // (committed) transaction. This is the idempotent reconciliation, which
      // also covers a database where the trigger has been dropped.
      await tx`
        INSERT INTO public.profiles (id, email, full_name, phone, locale, is_active, must_change_password)
        VALUES (
          ${userId}::uuid,
          ${email}::text,
          ${fullName}::text,
          ${employee.mobile === null ? null : `+91${employee.mobile}`}::text,
          ${body.locale}::text,
          true,
          true
        )
        ON CONFLICT (id) DO UPDATE
          SET full_name            = EXCLUDED.full_name,
              phone               = COALESCE(profiles.phone, EXCLUDED.phone),
              locale              = EXCLUDED.locale,
              is_active           = true,
              -- The invited state: the temporary password must be replaced on
              -- first sign-in (cutover plan: "self-service opened, forced change").
              must_change_password = true
      `;

      // The linkage. Conditional on `profile_id IS NULL` so two concurrent calls
      // cannot both claim the employee; zero rows means someone won the race.
      const linked = await tx`
        UPDATE public.employees
           SET profile_id = ${userId}::uuid
         WHERE id = ${employee.id}::uuid
           AND deleted_at IS NULL
           AND (profile_id IS NULL OR profile_id = ${userId}::uuid)
         RETURNING id
      `;
      if ((linked as unknown as unknown[]).length === 0) {
        throw conflict(
          "This employee was linked to a login by another request. Nothing was changed.",
          "ACCOUNT_RACE_LOST",
        );
      }

      // The employee tier and nothing more. `role.grant` is a separate
      // super-admin capability with its own step-up and its own audit action.
      await tx`
        INSERT INTO public.user_roles (user_id, role, granted_by, granted_reason)
        VALUES (
          ${userId}::uuid,
          'employee'::public.app_role,
          ${auth.userId}::uuid,
          ${`account created for ${employee.employee_code}: ${body.reason}`}::text
        )
        ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING
      `;

      const stateRows = await tx`
        SELECT p.is_active, p.must_change_password, p.last_login_at
          FROM public.profiles p
         WHERE p.id = ${userId}::uuid
         LIMIT 1
      `;
      const state = firstRow(
        stateRows as unknown as {
          is_active: boolean;
          must_change_password: boolean;
          last_login_at: Date | string | null;
        }[],
      );

      // The account creation itself, on the hash chain. The field-level rows for
      // `employees.profile_id` and the `profiles` columns come from their own
      // audit triggers (migration 038); what no trigger can say is that a named
      // admin provisioned this login, for this reason, in this request.
      await writeAudit(tx, ctx, {
        action: "insert",
        entityTable: "public.profiles",
        entityId: userId,
        entityLabel: email,
        subjectEmployeeId: employee.id,
        newValue: {
          employee_code: employee.employee_code,
          email,
          roles: ["employee"],
          portal_state: "invited",
          must_change_password: true,
          temp_password_issued: true,
          // Deliberately absent: the password itself. `auth.users` holds bcrypt;
          // the audit log holds the fact, never the secret.
        },
      });

      // `ck_sessions_audit__event` has no `account_created`; an admin setting the
      // initial password IS a `password_changed` event, so the security timeline
      // stays complete without inventing an enum value.
      await auditSession(tx, ctx, {
        event: "password_changed",
        profileId: userId,
        attemptedEmail: email,
        authMethod: "password",
      });

      return {
        lastLoginAt: state?.last_login_at ?? null,
        isActive: state?.is_active ?? true,
        mustChangePassword: state?.must_change_password ?? true,
      };
    });

    committed = true;

    const portalState = derivePortalState({
      isActive: result.isActive,
      mustChangePassword: result.mustChangePassword,
      lastLoginAt: result.lastLoginAt === null ? null : toIso(result.lastLoginAt),
    });

    const responseBody = {
      employee: {
        id: employee.id,
        employeeCode: employee.employee_code,
        displayName: fullName,
      },
      account: {
        profileId: createdUserId,
        email,
        locale: body.locale,
        roles: ["employee"],
        portalState,
        mustChangePassword: result.mustChangePassword,
        emailSent: false,
      },
      /** Shown ONCE. Never stored, never logged, never replayed. */
      tempPassword,
      tempPasswordShownOnce: true,
      handover:
        "Print or read this password to the employee, then destroy the copy. They must change it at " +
        "first sign-in. If it is lost, use a password reset — it cannot be retrieved.",
      reason: body.reason,
      requestId,
    };
    status = 200;

    // ── STEP 11 · Store the response under the idempotency key — REDACTED ───
    // A replay must return the account, not the credential: the idempotency
    // store is a database table, and a temporary password does not belong in one.
    await store(idempotencyKey, status, {
      ...responseBody,
      tempPassword: null,
      tempPasswordShownOnce: false,
      handover:
        "This is a replay of an earlier request. The temporary password is shown only in the original " +
        "response; issue a password reset if it was not captured.",
    });

    log.info("login provisioned", {
      employee_id: employee.id,
      employee_code: employee.employee_code,
      profile_id: createdUserId,
      portal_state: portalState,
    });
    return ok(responseBody, { status, headers: cors, requestId });
  } catch (err) {
    const asProblem = toProblem(err, requestId).withContext({ requestId, instance });
    status = asProblem.status;

    // ── Compensate: an auth user with no employee linkage is an orphan login,
    // and `verifyUser` would refuse it anyway. Remove it — but ONLY while the
    // business transaction has not committed.
    if (createdUserId !== null && !committed) {
      try {
        const { error } = await serviceClient().auth.admin.deleteUser(createdUserId);
        if (error !== null) throw error;
        log.warn("rolled back orphan auth user", { profile_id: createdUserId });
      } catch (deleteErr) {
        // Worth a page: a login exists that no employee owns.
        log.error("orphan auth user left behind", { profile_id: createdUserId, err: deleteErr });
      }
    }

    if (idempotencyKey !== null) {
      try {
        if (status >= 500) await release(idempotencyKey);
        else await store(idempotencyKey, status, asProblem.problem);
      } catch (storeErr) {
        log.warn("could not finalise idempotency key", { key: idempotencyKey, err: storeErr });
      }
    }

    if (asProblem.isServerFault) log.error("unhandled failure", { err, code: asProblem.code });
    else log.warn("request refused", { code: asProblem.code, status });
    return asProblem.toResponse(cors);
  } finally {
    // ── STEP 12 · One structured log line per invocation ────────────────────
    log.finish(status, { idempotency_key: idempotencyKey });
  }
});

/** Exported so `supabase/tests` and the admin console assert against one schema. */
export { Body, derivePortalState, generateTempPassword };
