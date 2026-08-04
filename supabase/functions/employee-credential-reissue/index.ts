/**
 * employee-credential-reissue — give an existing account a fresh temporary
 * password, and optionally email it to the person it belongs to.
 *
 * WHY THIS EXISTS. `employee-account-create` is the only thing that ever issued a
 * temporary password, and it refuses any employee whose `profile_id` is already
 * set — with a 409 whose own message says to "reset the password instead", a
 * feature that existed nowhere. Four other places in the codebase name "an admin
 * reset" as the recovery path for accounts that cannot receive mail, because their
 * login is a synthetic identity on a domain with no mailboxes. None of it was
 * built. So an admin had no way to:
 *
 *   · re-send credentials to somebody who lost the printed slip;
 *   · rotate a credential that was shared or shoulder-surfed;
 *   · email the 75 people whose logins were backfilled, whose passwords were
 *     returned once and are not recoverable from the database.
 *
 * WHAT IT DOES, IN ORDER
 *   1. verifies the caller is an admin whose scope covers this employee;
 *   2. mints a temporary password with the same generator and alphabet as
 *      `employee-account-create` — one character per class, rejection-sampled,
 *      shuffled — so both paths produce credentials of the same strength;
 *   3. sets it through the Auth admin API (the only way to set another user's
 *      password) and forces `must_change_password = true`;
 *   4. optionally emails it, through Resend directly.
 *
 * WHY IT MAILS DIRECTLY RATHER THAN THROUGH `communication-send`. That function
 * currently fails after its first transaction — recipients are left `queued` and
 * even `mode: send_pending` raises a 500 — so routing a credential through it
 * would leave the admin unable to tell whether the person received their password.
 * This sends one message to one address and reports the provider's own answer.
 *
 * THE PASSWORD IS RETURNED EXACTLY ONCE and is never stored: `auth.users` holds
 * only bcrypt, no row here keeps the plaintext, and the log redactor drops any
 * field matching /password/. Losing it means running this again.
 *
 * NOT DONE HERE, on purpose:
 *   · no role is changed. Rotating a credential is not a promotion.
 *   · no account is created. An employee with no login goes through
 *     `employee-account-create`, which also links the profile.
 *   · exited / retired / absconding are refused, exactly as account-create does:
 *     a leaver does not get a working credential.
 */
import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { conflict, forbidden, methodNotAllowed, notFound, ok, serverError, toProblem, unprocessable } from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { clientIpFrom, firstRow, requestIdFrom, serviceClient, sql, userAgentFrom, withContext } from "../_shared/db.ts";
import { requireCapDb, verifyUser } from "../_shared/auth.ts";
import { requireIdempotencyKey } from "../_shared/idempotency.ts";
import { auditSession, writeAudit } from "../_shared/audit.ts";

const TEMP_PASSWORD_LENGTH = 16;
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["exited", "retired", "absconding"]);

/** Same alphabet as employee-account-create: no look-alike glyphs. */
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "@#$%*+=?";
const PW_ALL = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;

/** Rejection sampling, not `% length`, which would bias the first characters. */
function randomIndex(bound: number): number {
  const limit = Math.floor(256 / bound) * bound;
  const buffer = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0] as number;
    if (byte < limit) return byte % bound;
  }
}
const pick = (alphabet: string): string => alphabet[randomIndex(alphabet.length)] as string;

function generateTempPassword(): string {
  const chars = [pick(PW_UPPER), pick(PW_LOWER), pick(PW_DIGIT), pick(PW_SYMBOL)];
  while (chars.length < TEMP_PASSWORD_LENGTH) chars.push(pick(PW_ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    const swap = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = swap;
  }
  return chars.join("");
}

const Body = z
  .object({
    employeeId: common.uuid,
    /** Send the credential by email as well as returning it. */
    sendEmail: z.boolean().default(true),
    reason: common.reason,
  })
  .strict();

const SIGN_IN_URL = "https://tt-hrms.vercel.app/login";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mailBodies(name: string, email: string, password: string): { html: string; text: string } {
  const text = `Hello ${name},

Your Tamarind Tree HRMS sign-in details.

  Sign in at:          ${SIGN_IN_URL}
  Your username:       ${email}
  Temporary password:  ${password}

The first time you sign in you will be asked to choose your own password. The
temporary one above stops working the moment you do, so it cannot be reused by
anyone who reads this message later.

Your new password needs at least 10 characters, with at least one letter and one
digit, and must not contain your name or your employee code.

If you were not expecting this, tell HR before you sign in.`;

  const html = `<p>Hello ${escapeHtml(name)},</p>
<p>Your Tamarind Tree HRMS sign-in details.</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #ddd">
  <tr><td style="border:1px solid #ddd"><b>Sign in at</b></td>
      <td style="border:1px solid #ddd"><a href="${SIGN_IN_URL}">${SIGN_IN_URL}</a></td></tr>
  <tr><td style="border:1px solid #ddd"><b>Your username</b></td>
      <td style="border:1px solid #ddd">${escapeHtml(email)}</td></tr>
  <tr><td style="border:1px solid #ddd"><b>Temporary password</b></td>
      <td style="border:1px solid #ddd"><code style="font-size:15px">${escapeHtml(password)}</code></td></tr>
</table>
<p><b>The first time you sign in you will be asked to choose your own password.</b>
The temporary one above stops working the moment you do, so it cannot be reused by
anyone who reads this message later.</p>
<p>Your new password needs at least 10 characters, with at least one letter and one
digit, and must not contain your name or your employee code.</p>
<p style="color:#666">If you were not expecting this, tell HR before you sign in.</p>`;

  return { html, text };
}

/**
 * One message, one address, the provider's own verdict returned to the caller.
 * A delivery failure is NOT fatal: the password has already been changed by the
 * time this runs, so throwing would leave the admin believing the old one still
 * works. The response says `emailSent: false` and carries the reason.
 */
async function sendMail(
  to: string,
  subject: string,
  bodies: { html: string; text: string },
): Promise<{ sent: boolean; detail: string | null }> {
  const key = (Deno.env.get("RESEND_API_KEY") ?? "").trim();
  if (key === "") return { sent: false, detail: "RESEND_API_KEY is not configured" };
  const from = (Deno.env.get("RESEND_FROM_EMAIL") ?? "onboarding@resend.dev").trim();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `Tamarind Tree HRMS <${from}>`,
        to: [to],
        subject,
        html: bodies.html,
        text: bodies.text,
      }),
    });
    if (res.ok) return { sent: true, detail: null };
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return { sent: false, detail: `${res.status}: ${detail}` };
  } catch (err) {
    return { sent: false, detail: `network: ${String(err)}` };
  }
}

interface Subject {
  employee_id: string;
  employee_code: string;
  display_name: string;
  employment_status: string;
  profile_id: string | null;
  login_email: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handlePreflight(req);
  if (pre !== null) return pre;
  const origin = req.headers.get("origin");
  try {
    assertOriginAllowed(origin);
  } catch (err) {
    return toProblem(err, origin);
  }

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: "employee-credential-reissue", requestId });

  try {
    if (req.method !== "POST") throw methodNotAllowed(["POST"]);

    // A retried network call must not silently mint a second password.
    const idempotencyKey = requireIdempotencyKey(req);
    const auth = await verifyUser(req);
    const { data: body } = await parseBody(req, Body);

    await requireCapDb(sql(), auth, "employee.account.create");

    const subject = await firstRow<Subject>(
      sql()`
        SELECT e.id            AS employee_id,
               e.employee_code AS employee_code,
               e.display_name  AS display_name,
               e.employment_status::text AS employment_status,
               e.profile_id    AS profile_id,
               p.email         AS login_email
          FROM public.employees e
          LEFT JOIN public.profiles p ON p.id = e.profile_id
         WHERE e.id = ${body.employeeId}
           AND e.deleted_at IS NULL
           AND app.admin_scope_covers(e.id)
      `,
    );

    if (subject === null) {
      // Out of scope reads the same as absent, deliberately: an admin must not be
      // able to probe for employees they cannot administer.
      throw notFound("That employee could not be found.", "EMPLOYEE_NOT_FOUND");
    }
    if (subject.profile_id === null) {
      throw conflict(
        `${subject.employee_code} has no login yet. Create one first — there is no password to reissue.`,
        "ACCOUNT_MISSING",
      );
    }
    if (CLOSED_STATUSES.has(subject.employment_status)) {
      throw conflict(
        `${subject.employee_code} is ${subject.employment_status}. A leaver is not given a working credential.`,
        "EMPLOYEE_CLOSED",
      );
    }
    if (subject.login_email === null || subject.login_email.trim() === "") {
      throw unprocessable("That account has no login address.", "LOGIN_EMAIL_MISSING");
    }

    const password = generateTempPassword();

    const updated = await serviceClient().auth.admin.updateUserById(subject.profile_id, {
      password,
    });
    if (updated.error !== null) {
      log.error("auth admin updateUserById failed", { err: updated.error });
      throw serverError("The password could not be changed.");
    }

    // From here the OLD password no longer works, so nothing below may throw in a
    // way that hides that fact from the caller.
    const ctx = {
      actorId: auth.profileId,
      actorRole: auth.role,
      actorSource: "web_admin" as const,
      reason: body.reason,
      requestId,
      ip: clientIpFrom(req),
      userAgent: userAgentFrom(req),
    };

    await withContext(ctx, async (tx) => {
      await tx`
        UPDATE public.profiles
           SET must_change_password = true, updated_at = now()
         WHERE id = ${subject.profile_id}
      `;
      await writeAudit(tx, ctx, {
        action: "password_changed",
        entityTable: "public.profiles",
        entityId: subject.profile_id,
        entityLabel: subject.login_email,
        newValues: {
          employee_code: subject.employee_code,
          must_change_password: true,
          temp_password_issued: true,
          reissued_by_admin: true,
        },
      });
      await auditSession(tx, {
        profileId: subject.profile_id,
        event: "password_changed",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      }).catch(() => {
        // The session timeline is a nicety; the audit row above is the record.
      });
    });

    let emailSent = false;
    let emailDetail: string | null = null;
    if (body.sendEmail) {
      const result = await sendMail(
        subject.login_email,
        "Your Tamarind Tree HRMS sign-in details",
        mailBodies(subject.display_name, subject.login_email, password),
      );
      emailSent = result.sent;
      emailDetail = result.detail;
      if (!result.sent) log.warn("credential email not delivered", { detail: result.detail });
    }

    return ok(
      {
        employeeCode: subject.employee_code,
        displayName: subject.display_name,
        loginEmail: subject.login_email,
        // Once. Nothing stores it.
        tempPassword: password,
        mustChangePassword: true,
        emailSent,
        emailDetail,
      },
      { origin, idempotencyKey },
    );
  } catch (err) {
    return toProblem(err, origin, corsHeaders(origin));
  }
});
