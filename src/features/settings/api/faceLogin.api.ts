/**
 * faceLogin.api.ts — read and set the per-person face SIGN-IN switch.
 *
 * SIGN-IN, NOT PUNCHING. Two different things share a camera and must not share a
 * switch: this controls whether a face can open a SESSION (`face-login`), while
 * punching at the gate is `kiosk-punch` and is governed by the kiosk device and the
 * attendance policy. Turning this off does not stop somebody clocking in.
 *
 * NOR IS IT CONSENT. Permission to HOLD a face template lives in
 * `secure.biometric_consents` and withdrawing it retires the template itself. This is
 * the narrower question of whether an existing template may be used to log in — a
 * preference, reversible, and not a DPDP event.
 *
 * THE AUTHORITY LIVES IN POSTGRES, NOT HERE. `v_face_login_access` returns only rows
 * the caller may manage (self / their reportees / their admin scope) and hands back
 * `can_manage` per row; `set_face_login_enabled` re-checks the same three-way test and
 * raises 42501 otherwise. This module never decides who may do what — if it tried, the
 * rule would exist in two places and one of them would drift.
 */
import { z } from "zod";
import { dbUuid, inList, rpcOne, selectMany } from "@/shared/api/query";

export const FACE_LOGIN_VIEW = "v_face_login_access";
export const SET_FACE_LOGIN_FN = "set_face_login_enabled";

export const faceLoginAccessSchema = z.object({
  employee_id: dbUuid,
  employee_code: z.string().nullable(),
  display_name: z.string().nullable(),
  /** The switch itself. */
  allow_face_login: z.boolean(),
  /** `employees.face_enrolled_at IS NOT NULL` — they have been through enrolment. */
  has_enrolled: z.boolean(),
  /** An active, consented, un-purged template exists RIGHT NOW. */
  has_live_template: z.boolean(),
  /**
   * Manager / admin / super_admin. `face-login` refuses these accounts outright, so
   * the switch being on is not enough for them — the screen has to say why.
   */
  is_privileged: z.boolean(),
  /** Whether the CALLER may flip this row. Decided by the database. */
  can_manage: z.boolean(),
});

export type FaceLoginAccess = z.infer<typeof faceLoginAccessSchema>;

/**
 * Every person whose switch the caller may see — which, by the view's own predicate,
 * is exactly the set they may also change.
 *
 * An employee gets one row (their own). A manager gets themselves and their
 * reportees. An admin gets everyone in scope.
 */
export async function fetchFaceLoginAccess(
  employeeIds?: readonly string[],
  signal?: AbortSignal,
): Promise<FaceLoginAccess[]> {
  return selectMany(FACE_LOGIN_VIEW, faceLoginAccessSchema, {
    ...(employeeIds !== undefined && employeeIds.length > 0
      ? { filters: [inList("employee_id", [...employeeIds])] }
      : {}),
    order: [{ column: "display_name", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Flip one switch. Returns the value the DATABASE settled on, not the one we asked
 * for — so a UI that reads the result cannot drift from the stored truth.
 *
 * No `reason` argument: `set_face_login_enabled` writes its own audit sentence
 * ("face sign-in disabled by reporting manager"), because it is the only party that
 * knows which of the three authority branches applied. Asking the caller to supply a
 * reason would let the record say "self" for a change an admin made.
 */
export async function setFaceLoginEnabled(
  employeeId: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const value = await rpcOne(
    SET_FACE_LOGIN_FN,
    { p_employee_id: employeeId, p_enabled: enabled },
    z.boolean(),
    { ...(signal ? { signal } : {}) },
  );
  // A definer function that returned nothing means the row vanished between the read
  // and the write. Reporting the requested value would be a lie about stored state.
  if (value === null) {
    throw new Error("Face sign-in could not be changed: that employee no longer exists.");
  }
  return value;
}
