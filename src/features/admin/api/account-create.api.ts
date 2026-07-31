/**
 * account-create.api.ts — give an employee a way into the portal.
 *
 * WHY THIS MODULE IS NEW AND THE FUNCTION IS NOT. `employee-account-create` has existed all
 * along and does exactly the right thing: creates the auth user, links it to the employee,
 * forces a password change, and hands back a temporary password ONCE. Nothing in the app ever
 * called it. `employees.api.ts` even says the account is "created afterwards by the
 * `employee-account-create` edge function" — and afterwards never came, so every employee
 * added through People ended up with no login at all. Sunil M (TT0016) is the reported case:
 * a live, confirmed employee with no profile, no email and no roles.
 *
 * THE TEMPORARY PASSWORD IS RETURNED ONCE AND IS NOT STORED. The function's idempotency
 * replay deliberately nulls it, so a second call with the same key returns the row without the
 * password and says so. That shapes the UI: it has to be shown at the moment it arrives,
 * because there is no second chance to read it — only a password reset.
 *
 * NO EMAIL YET, AND THE RESPONSE SAYS SO. `account.emailSent` comes back `false`: the function
 * provisions the login and does not send anything. Handing the slip over is currently a human
 * act, which is why the screen shows the password rather than implying a mail is on its way.
 */
import { z } from "zod";
import { invokeEdgeFn } from "@/shared/api/invoke";

export const EMPLOYEE_ACCOUNT_CREATE_FN = "employee-account-create";

/** `invited` = provisioned and never signed in; `active` once they have. */
export const portalStates = ["none", "invited", "active", "suspended"] as const;
export type PortalState = (typeof portalStates)[number];

const accountCreatedSchema = z.object({
  employee: z.object({
    id: z.string(),
    employeeCode: z.string(),
    displayName: z.string().nullable(),
  }),
  account: z.object({
    profileId: z.string().nullable(),
    email: z.string().nullable(),
    roles: z.array(z.string()),
    portalState: z.enum(portalStates),
    mustChangePassword: z.boolean(),
    /** False today: the function provisions, it does not post. */
    emailSent: z.boolean(),
  }),
  /**
   * Shown once and never stored. `null` on an idempotent replay — the caller must treat
   * absence as "you have already been given this and did not keep it".
   */
  tempPassword: z.string().nullable(),
  tempPasswordShownOnce: z.boolean(),
  handover: z.string().nullable().optional(),
});

export type AccountCreated = z.infer<typeof accountCreatedSchema>;

/**
 * Provision a portal login for an employee who has none.
 *
 * `loginEmail` is optional — the function falls back to the employee's work email, then their
 * personal email. It is passed explicitly only when neither is on file, which is exactly
 * Sunil's situation and the reason the form asks for one.
 */
export async function createEmployeeAccount(input: {
  readonly employeeId: string;
  readonly loginEmail?: string;
  readonly reason: string;
}): Promise<AccountCreated> {
  return invokeEdgeFn(
    EMPLOYEE_ACCOUNT_CREATE_FN,
    {
      employeeId: input.employeeId,
      ...(input.loginEmail !== undefined && input.loginEmail.trim() !== ""
        ? { loginEmail: input.loginEmail.trim() }
        : {}),
      locale: "en-IN",
      reason: input.reason,
    },
    accountCreatedSchema,
  );
}
