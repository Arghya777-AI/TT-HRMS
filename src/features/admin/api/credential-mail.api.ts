/**
 * credential-mail.api.ts — email an employee the login they have just been given.
 *
 * WHY THIS SITS NEXT TO THE MOMENT OF ISSUE, AND CANNOT SIT ANYWHERE ELSE.
 *
 * `employee-account-create` returns the temporary password exactly once and nulls
 * it on an idempotent replay; the database keeps only the bcrypt hash. So there is
 * no screen, query or function anywhere that can look up an existing temporary
 * password — not this module, not the roles panel, nothing. The only instant the
 * password exists in the app is the moment provisioning returns it.
 *
 * That is why the send button lives on the panel that is already holding the
 * credential, rather than being a general "email this person their password"
 * action on any row. An action of that second kind is impossible without either
 * storing passwords (which this system deliberately does not) or issuing a fresh
 * one first, which needs the Auth admin API and therefore a new edge function.
 *
 * DELIVERY. `communication-send` (Resend) with a one-off subject and body rather
 * than a `notification_templates` code: the credential is per person and the body
 * is assembled here so the exact words a joiner reads are visible in this file.
 * The audience is the single employee id, so a mistyped address cannot widen it.
 */
import { z } from "zod";
import { invokeEdgeFn } from "@/shared/api/invoke";
import { supabase } from "@/lib/supabase";

export const COMMUNICATION_SEND_FN = "communication-send";

/** Where a joiner signs in. Absolute, because it is going into an email. */
const SIGN_IN_URL = "https://tt-hrms.vercel.app/login";

/**
 * The function answers with the delivery counts; `sent` is what the caller shows.
 * Loose on purpose — a shape change in the response must not turn a delivered
 * email into an error on screen.
 */
const sendResultSchema = z
  .object({
    communicationId: z.string().optional(),
    sent: z.number().optional(),
    failed: z.number().optional(),
    sandboxed: z.boolean().optional(),
  })
  .passthrough();

export type CredentialMailResult = z.infer<typeof sendResultSchema>;

export interface CredentialMailInput {
  readonly employeeId: string;
  readonly displayName: string;
  /** The login identity — this is the "username" the employee types. */
  readonly loginEmail: string;
  /** As returned by `employee-account-create`, this once. */
  readonly tempPassword: string;
}

function bodyText(i: CredentialMailInput): string {
  return `Hello ${i.displayName},

Your Tamarind Tree HRMS account is ready. Here is how to sign in.

  Sign in at:          ${SIGN_IN_URL}
  Your username:       ${i.loginEmail}
  Temporary password:  ${i.tempPassword}

WHAT HAPPENS FIRST
The first time you sign in you will be asked to choose your own password. The
temporary one above stops working the moment you do, so it cannot be reused by
anyone who sees this message later.

Your new password needs at least 10 characters, with at least one letter and one
digit, and must not contain your name or your employee code.

If you were not expecting this email, tell HR before you sign in.`;
}

function bodyHtml(i: CredentialMailInput): string {
  // Inline styles and a table: email clients ignore stylesheets, and the three
  // facts have to survive being forwarded and printed.
  return `<p>Hello ${escapeHtml(i.displayName)},</p>
<p>Your Tamarind Tree HRMS account is ready. Here is how to sign in.</p>
<table cellpadding="8" style="border-collapse:collapse;border:1px solid #ddd">
  <tr><td style="border:1px solid #ddd"><b>Sign in at</b></td>
      <td style="border:1px solid #ddd"><a href="${SIGN_IN_URL}">${SIGN_IN_URL}</a></td></tr>
  <tr><td style="border:1px solid #ddd"><b>Your username</b></td>
      <td style="border:1px solid #ddd">${escapeHtml(i.loginEmail)}</td></tr>
  <tr><td style="border:1px solid #ddd"><b>Temporary password</b></td>
      <td style="border:1px solid #ddd"><code style="font-size:15px">${escapeHtml(i.tempPassword)}</code></td></tr>
</table>
<p><b>The first time you sign in you will be asked to choose your own password.</b>
The temporary one above stops working the moment you do, so it cannot be reused by
anyone who sees this message later.</p>
<p>Your new password needs at least 10 characters, with at least one letter and one
digit, and must not contain your name or your employee code.</p>
<p style="color:#666">If you were not expecting this email, tell HR before you sign in.</p>`;
}

/** The password goes into HTML, so it is escaped rather than trusted to be tame. */
function escapeHtml(s: string): string {
  // Regex replace, not replaceAll: the project's tsconfig lib predates it.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Send one employee their username and temporary password.
 *
 * `communication_kind: "custom"` — this is not a policy or a broadcast, and it
 * must not be swept up by anything that resends those.
 */
export async function sendCredentialEmail(
  input: CredentialMailInput,
): Promise<CredentialMailResult> {
  return invokeEdgeFn(
    COMMUNICATION_SEND_FN,
    {
      mode: "transactional",
      communication_kind: "custom",
      audience: { employee_ids: [input.employeeId] },
      message: {
        subject: "Your Tamarind Tree HRMS sign-in details",
        body_text: bodyText(input),
        body_html: bodyHtml(input),
      },
    },
    sendResultSchema,
  );
}

// -----------------------------------------------------------------------------
// Email a set-your-password link instead of a password
// -----------------------------------------------------------------------------

/**
 * Ask Supabase Auth to email this address a link that sets a new password.
 *
 * WHY THIS EXISTS ALONGSIDE `sendCredentialEmail`. That one can only run at the
 * instant a password is minted, because nothing stores it. This one works at any
 * time, for anybody, and never puts a secret in a mailbox — the recipient follows
 * a single-use link and chooses their own password.
 *
 * IT USES A DIFFERENT TRANSPORT, WHICH IS THE POINT. `sendCredentialEmail` goes
 * through `communication-send` → Resend, which needs a verified sending domain and
 * is currently refusing anything but the account owner's address. This goes through
 * Supabase Auth's own mailer, so whatever is configured there — the built-in
 * sender, or custom SMTP such as Gmail — carries it, with no domain verification
 * and no edge function involved.
 *
 * THE ANSWER IS DELIBERATELY THE SAME WHETHER OR NOT THE ADDRESS EXISTS. GoTrue
 * does not distinguish, by design, so this cannot be used to discover who has an
 * account. A resolved promise therefore means "accepted for delivery", not
 * "delivered" — the caller's wording has to be honest about that.
 *
 * TWO LIMITS WORTH KNOWING BEFORE SENDING IN BULK:
 *   · Auth applies its own per-hour cap on outgoing mail (Authentication → Rate
 *     Limits). On the default of a couple per hour, a run of eighteen quietly
 *     stops after the first two.
 *   · the address has to be a real mailbox. The synthetic
 *     `<employee_code>@tamarindtree.co` identities have none, so a link sent there
 *     goes nowhere and those people need a printed slip instead.
 */
export async function sendPasswordResetLink(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  // Surfaced rather than swallowed: an admin doing this deliberately for somebody
  // else needs to know it was refused. The anti-enumeration silence above is about
  // WHICH addresses exist, not about whether the request itself failed.
  if (error !== null) throw error;
}
