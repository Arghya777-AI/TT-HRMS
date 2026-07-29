/**
 * photo.api.ts — the signed-in person's own profile photograph, as something an
 * `<img>` can point at.
 *
 * WHY IT NEEDS AN API AT ALL. The photo is a private object in a private bucket, so
 * there is no stable URL to store on the employee row and render. It has to be a
 * short-lived signed URL, minted per session by `document-access` — which is also what
 * keeps "whose photo may I see" answered by RLS rather than by a path somebody guessed.
 *
 * WHY IT IS SCOPED TO THE CALLER'S OWN FACE. Every avatar render costs a mint and a
 * `document_access_log` row. One person's own avatar, cached for eight minutes against a
 * ten-minute link, is a handful of rows an hour. Doing the same for every face in a
 * fifteen-row roster would put thousands of "saw a colleague's photo" rows into the same
 * table that has to answer "who opened whose Aadhaar" — and that is how an access log
 * becomes unreadable. Lists keep their initials.
 *
 * WHY IT LOOKS FOR A DOCUMENT AND NOT `employees.photo_path`. Both that column and the
 * `employee-photos` bucket exist and are EMPTY: nothing has ever written them. What
 * actually exists after somebody uploads their picture is a `documents` row of type
 * PHOTO, because that is the upload path the product has. Reading the thing that is
 * really there beats reading the column that was planned.
 */
import { z } from "zod";
import { dbUuid, eq, isNull, selectMany } from "@/shared/api/query";
import { requestDocumentAccess } from "@/features/docs/api/documentAccess.api";

/** `document_types.code` for a photograph. */
export const PHOTO_TYPE_CODE = "PHOTO";

const photoDocSchema = z.object({
  id: dbUuid,
  uploaded_at: z.string(),
  document_types: z.object({ code: z.string() }).nullable(),
});

/**
 * The most recent photograph filed against this employee, or `null`.
 *
 * Rejected photos are excluded, approved and pending are not: a photograph needs no
 * approval (migration 086) so it arrives `approved`, but a row uploaded before that
 * change may still be sitting in `pending_review` and it is still their face.
 */
export async function findMyPhotoDocumentId(
  employeeId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const rows = await selectMany(
    "documents",
    photoDocSchema,
    {
      columns: "id, uploaded_at, document_types!inner(code)",
      filters: [
        eq("employee_id", employeeId),
        isNull("deleted_at"),
        eq("document_types.code", PHOTO_TYPE_CODE),
      ],
      order: [{ column: "uploaded_at", ascending: false }],
      limit: 1,
      ...(signal ? { signal } : {}),
    },
  );
  return rows[0]?.id ?? null;
}

export interface PhotoUrl {
  readonly url: string;
  /** Seconds the link is good for, so the caller can cache under it. */
  readonly expiresInSeconds: number;
}

/**
 * A URL for the caller's own photo, or `null` when they have not uploaded one.
 *
 * Returns `null` rather than throwing on a refusal. A missing or unopenable photograph
 * must degrade to initials — an avatar is decoration, and no part of this screen should
 * fail because a face could not be fetched.
 */
export async function fetchMyPhotoUrl(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PhotoUrl | null> {
  const documentId = await findMyPhotoDocumentId(employeeId, signal);
  if (documentId === null) return null;
  try {
    const access = await requestDocumentAccess(documentId, "view");
    return { url: access.url, expiresInSeconds: access.expires_in_seconds };
  } catch {
    // DOCUMENT_FILE_MISSING is the common one — a row whose bytes were never stored.
    return null;
  }
}
