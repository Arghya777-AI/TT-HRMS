/**
 * documentAccess.api.ts — open a stored document.
 *
 * WHY THERE WAS NO VIEW BUTTON UNTIL NOW, and it was not an oversight: storage
 * grants no direct SELECT on the `documents` bucket to anyone but an admin
 * (migration 039), so the browser genuinely cannot reach the bytes. The only way in
 * is a short-lived signed URL minted server-side, and the function that mints them
 * — `document-access` — did not exist. `profile/api/documents.api.ts` said as much
 * in its header and deliberately shipped no button rather than one that 400s.
 *
 * The function exists now. It authorises by reading the metadata row under the
 * CALLER's own token, so the same RLS policies that decide whether a row is visible
 * on screen decide whether its file can be opened — an employee gets their own, a
 * manager gets their team's manager-visible types, an admin gets their scope. There
 * is no permission logic in this module, and there must never be: a second copy in
 * TypeScript is how the two drift apart.
 *
 * EVERY CALL IS LOGGED BEFORE THE URL EXISTS. `document_access_log` gets a
 * `signed_url_minted` row and a `view`/`download` row, with the caller, the IP and
 * the expiry, written before the link is created — so a URL can never exist without
 * a record of who asked for it. That is the audit trail for document reads.
 *
 * THE URL IS NOT CACHED. It lives ~2 minutes and it is a bearer token for the file:
 * anyone holding it can read the document. So it is used immediately and thrown
 * away, never put in a query cache or in component state that outlives the click.
 */
import { z } from "zod";
import { invokeEdgeFn, TTApiError } from "@/shared/api/invoke";
import { t } from "@/shared/i18n/en";

/** Catalogue name of the function this module calls. */
export const DOCUMENT_ACCESS_FN = "document-access";

/** `view` opens in a tab; `download` asks storage for the real filename. */
export type DocumentAccessKind = "view" | "download";

const accessSchema = z.object({
  document_id: z.string(),
  url: z.string(),
  expires_in_seconds: z.number(),
  expires_at: z.string(),
  file_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  title: z.string().nullable(),
  /**
   * REQUIRED, not optional. A file this deployment has not scanned is served —
   * refusing every unscanned document would make the feature useless while no
   * scanner runs — so the screen has to be able to say so. Optional here would let
   * a caller silently skip the warning.
   */
  virus_scan_status: z.string(),
  access_kind: z.enum(["view", "download"]),
});

export type DocumentAccess = z.infer<typeof accessSchema>;

/**
 * The refusals this function makes, as sentences rather than codes.
 *
 * `DOCUMENT_FILE_MISSING` is the common one in this deployment and it is NOT an
 * error on the reader's part: seeded records have metadata and no bytes. Telling
 * somebody "something went wrong" makes them retry forever; telling them the file
 * was never stored is actionable — they re-upload it.
 */
function explain(error: TTApiError): string {
  // The code and the sentence live on `error.problem` (RFC 9457), not on the error.
  switch (error.problem.code) {
    case "DOCUMENT_FILE_MISSING":
      return t("docs.open.error.fileMissing");
    case "DOCUMENT_NO_FILE":
      return t("docs.open.error.noFile");
    case "DOCUMENT_INFECTED":
      return t("docs.open.error.infected");
    case "DOCUMENT_NOT_FOUND":
      return t("docs.open.error.notFound");
    default:
      // The server's own sentence when it wrote one: it is more specific than ours.
      return typeof error.problem.detail === "string" && error.problem.detail !== ""
        ? error.problem.detail
        : t("docs.open.error.generic");
  }
}

/** Thrown with copy the screen can show as-is. */
export class DocumentOpenError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "DocumentOpenError";
    this.code = code;
  }
}

/** Mint a link for one document. Resolves with the URL; throws copy on refusal. */
export async function requestDocumentAccess(
  documentId: string,
  kind: DocumentAccessKind = "view",
): Promise<DocumentAccess> {
  try {
    return await invokeEdgeFn(
      DOCUMENT_ACCESS_FN,
      { document_id: documentId, access_kind: kind },
      accessSchema,
    );
  } catch (error) {
    if (error instanceof TTApiError) {
      throw new DocumentOpenError(explain(error), error.problem.code ?? null);
    }
    throw error;
  }
}

/**
 * Mint and act on the link in one step.
 *
 * A NEW TAB, not a navigation: the reader keeps the list they were working
 * through. `noopener` is set because the signed URL is on a different origin and
 * the opened page must not get a handle on this window.
 *
 * The download path uses an anchor click rather than `window.open`, because
 * storage returns the file with a Content-Disposition and a popup would flash an
 * empty tab before the save dialog.
 */
export async function openDocument(
  documentId: string,
  kind: DocumentAccessKind = "view",
): Promise<DocumentAccess> {
  const access = await requestDocumentAccess(documentId, kind);
  if (kind === "download") {
    const a = document.createElement("a");
    a.href = access.url;
    a.rel = "noopener";
    a.download = access.file_name ?? access.title ?? "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(access.url, "_blank", "noopener,noreferrer");
  }
  return access;
}
