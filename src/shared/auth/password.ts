/**
 * password.ts — the ONE password policy (spec-employee E-01.5, applied
 * everywhere a password is set: /reset-password, /first-run, E-18 change).
 *
 * ≥10 chars · ≥1 letter · ≥1 digit · must not contain employee_code /
 * first_name / brand words / trivial sequences. "Not last 3 passwords" is
 * server-enforced (edge fn) — the client cannot know password history.
 */
import { z } from "zod";

const STATIC_BLOCKLIST = ["tamarind", "venue", "123456", "password"] as const;

export interface PasswordContext {
  employeeCode?: string | null;
  firstName?: string | null;
}

/** Human-readable list of everything wrong with a candidate password. */
export function passwordIssues(password: string, ctx: PasswordContext = {}): string[] {
  const issues: string[] = [];
  if (password.length < 10) issues.push("Use at least 10 characters.");
  if (!/[a-zA-Z]/.test(password)) issues.push("Include at least 1 letter.");
  if (!/\d/.test(password)) issues.push("Include at least 1 digit.");
  const lower = password.toLowerCase();
  const blocked: string[] = [...STATIC_BLOCKLIST];
  if (ctx.employeeCode) blocked.push(ctx.employeeCode.toLowerCase());
  if (ctx.firstName && ctx.firstName.length >= 3) blocked.push(ctx.firstName.toLowerCase());
  for (const word of blocked) {
    if (word && lower.includes(word)) {
      issues.push("Don't include your name, employee code or common words.");
      break;
    }
  }
  return issues;
}

/** zod schema for a single password field, bound to the signer's context. */
export function passwordSchema(ctx: PasswordContext = {}): z.ZodType<string> {
  return z.string().superRefine((value, refCtx) => {
    for (const issue of passwordIssues(value, ctx)) {
      refCtx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }
  });
}

/** password + confirm pair used by reset and first-run forms. */
export function passwordPairSchema(ctx: PasswordContext = {}) {
  return z
    .object({
      password: passwordSchema(ctx),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, {
      message: "Passwords don't match.",
      path: ["confirm"],
    });
}
