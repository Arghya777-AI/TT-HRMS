/**
 * document-access — the only way to open a stored document, and the reason a
 * View button can exist at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FUNCTION HAD TO BE WRITTEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing in the product could open a file. `src/features/profile/api/documents.api.ts`
 * said so in its own header — "NO READ-BACK … reads are short-lived signed URLs
 * minted by the `document-access` edge function, which … is not deployed here.
 * Offering a download button that 400s would be the dishonest option." That was
 * the right call at the time, but it left an employee able to upload their Aadhaar
 * and never see it again, and HR looking at a vault row with no way to look at the
 * thing the row describes. Both were reported.
 *
 * Storage grants no direct SELECT on the `documents` bucket (migration 039) to
 * anyone but admins, so the bytes genuinely are unreachable from the browser. This
 * function is the missing piece, not a convenience wrapper.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHORISATION IS RLS, NOT A CHECK WRITTEN HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The metadata row is read with `asCaller(auth.token)`, so
 * `documents__self__select` / `documents__manager__select` / `documents__admin_all`
 * decide the answer — the same policies that decide whether the row is visible on
 * screen. If the caller cannot see the row, this returns 404 and never touches
 * storage.
 *
 * That is deliberate and it is the whole security argument: there is no second
 * copy of "who may read a document" in TypeScript to drift out of step with the
 * database. A REVERSED check here — reading with the service key and then
 * comparing employee ids by hand — is exactly how a document leaks, because the
 * hand-written comparison always forgets a case (a manager's manager, a
 * confidential row, a soft-deleted employee) that the policies already handle.
 *
 * `storage_path` is taken FROM THE ROW the caller is allowed to see, never from
 * the request. A caller cannot name a path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LOG IS WRITTEN BEFORE THE URL EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * `document_access_log` is inserted first, and a failure to log FAILS THE REQUEST.
 * A signed URL is a bearer token for a file: once minted it can be shared, and it
 * works whether or not we wrote anything down. So the only honest order is to
 * record the intent to mint, then mint. Logging afterwards would mean a URL could
 * exist with no record of who asked for it, which is the one thing an access log
 * is for.
 *
 * Two rows are written for a download, not one: `signed_url_minted` records that a
 * capability was created, and `view`/`download` records what it was created for.
 * They answer different questions in an audit — "what was handed out" and "what
 * did they intend to do with it".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES
 * ─────────────────────────────────────────────────────────────────────────────
 *   · An infected file. `virus_scan_status = 'infected'` is never served, to
 *     anybody, including an admin. There is no override, because the only use for
 *     one is to open a file we know is malicious.
 *   · A row with no bytes behind it (`storage_path` null), which is what a
 *     metadata-only or e-sign-pending row looks like. Said plainly rather than
 *     handing over a URL that 404s.
 * An UNSCANNED file ('pending') IS served: most of this deployment's documents are
 * pending because no scanner runs yet, and refusing them would make the feature
 * useless. The response says `virus_scan_status` so the UI can warn, which is the
 * same honesty the upload screen already practises.
 */

import { assertOriginAllowed, corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { badGateway, conflict, methodNotAllowed, notFound, ok, toProblem } from "../_shared/errors.ts";
import { common, parseBody, z } from "../_shared/validate.ts";
import { createLogger } from "../_shared/log.ts";
import { nowMs, toIso } from "../_shared/datetime.ts";
import {
  asCaller,
  clientIpFrom,
  firstRow,
  type RequestContext,
  requestIdFrom,
  serviceClient,
  sql as sqlHandle,
  userAgentFrom,
  withContext,
} from "../_shared/db.ts";
import { verifyUser } from "../_shared/auth.ts";
import { enforce, limitKey, RATE_LIMITS } from "../_shared/ratelimit.ts";

const FN_NAME = "document-access";
const ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * Two minutes. Long enough for a browser to follow the link and for a PDF viewer
 * to fetch it, short enough that a URL pasted into a chat is dead before anyone
 * reads it. The client re-asks rather than caching the URL.
 */
const SIGNED_URL_TTL_SECONDS = 120;

const AccessBody = z.object({
  document_id: common.uuid,
  /**
   * What the caller means to do. Only the LOG distinguishes them; both mint the
   * same URL, with `download` additionally asking storage for a
   * Content-Disposition so the file saves under its real name instead of a
   * storage key.
   */
  access_kind: z.enum(["view", "download"]).default("view"),
}).strict();

interface DocRow {
  id: string;
  storage_bucket: string | null;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  status: string;
  virus_scan_status: string;
  title: string | null;
  employee_id: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req, ALLOWED_METHODS);
  if (preflight !== null) return preflight;
  const cors = corsHeaders(req);

  if (req.method !== "POST") return methodNotAllowed(ALLOWED_METHODS).toResponse(cors);

  const requestId = requestIdFrom(req);
  const log = createLogger({ fn: FN_NAME, requestId });
  const instance = new URL(req.url).pathname;
  const started = nowMs();
  let status = 500;

  try {
    assertOriginAllowed(req);
    const auth = await verifyUser(req);
    const { data: body } = await parseBody(req, AccessBody, { instance, requestId });

    // `reveal` (20/min): opening a document is exactly the audited, deliberate act
    // that bucket exists for — not a bulk export, not a routine mutation.
    await enforce(RATE_LIMITS.reveal, limitKey("document-access", auth.userId));

    // ── Authorisation: the caller's own token, so RLS answers ─────────────────
    const caller = asCaller(auth.token);
    const { data, error } = await caller
      .from("documents")
      .select(
        "id, storage_bucket, storage_path, file_name, mime_type, status, virus_scan_status, title, employee_id",
      )
      .eq("id", body.document_id)
      .is("deleted_at", null)
      .limit(1);

    if (error !== null) {
      // An RLS refusal arrives as an empty set, not an error. An actual error is
      // ours, so it must not be reported as "not found".
      throw error;
    }
    const doc = firstRow((data ?? []) as DocRow[]);
    // 404 rather than 403: the caller must not learn that a document they cannot
    // see exists — the same rule the conversation lookup follows.
    if (doc === null) {
      status = 404;
      return notFound("That document is not available.", "DOCUMENT_NOT_FOUND")
        .toResponse(cors);
    }

    if (doc.virus_scan_status === "infected") {
      status = 409;
      return conflict(
        "This file was flagged by the virus scanner and cannot be opened.",
        "DOCUMENT_INFECTED",
      ).toResponse(cors);
    }
    if (doc.storage_path === null || doc.storage_bucket === null) {
      status = 409;
      return conflict(
        "There is no file stored against this record yet.",
        "DOCUMENT_NO_FILE",
      ).toResponse(cors);
    }

    // ── The log, BEFORE the URL exists ────────────────────────────────────────
    const expiresAt = toIso(new Date(nowMs() + SIGNED_URL_TTL_SECONDS * 1000));
    const ctx: RequestContext = {
      actorId: auth.userId,
      source: "edge_function",
      sourceRoute: FN_NAME,
      requestId,
      ip: clientIpFrom(req),
      ua: userAgentFrom(req),
      // ≥10 characters: document_access_log is reason-required.
      reason: `document opened via document-access as ${body.access_kind}`,
    };
    await withContext(ctx, async (tx) => {
      await tx`
        INSERT INTO public.document_access_log
          (document_id, accessed_by, access_kind, purpose, ip, user_agent,
           signed_url_expires_at, request_id)
        SELECT ${doc.id}::uuid,
               ${auth.userId}::uuid,
               k.kind,
               ${`opened from the app as ${body.access_kind}`}::text,
               ${clientIpFrom(req)}::inet,
               ${userAgentFrom(req)}::text,
               ${expiresAt}::timestamptz,
               ${requestId}::uuid
          FROM (VALUES ('signed_url_minted'), (${body.access_kind})) AS k(kind)
      `;
    });

    // ── Mint ─────────────────────────────────────────────────────────────────
    const signed = await serviceClient().storage
      .from(doc.storage_bucket)
      .createSignedUrl(
        doc.storage_path,
        SIGNED_URL_TTL_SECONDS,
        body.access_kind === "download"
          ? { download: doc.file_name ?? doc.title ?? "document" }
          : undefined,
      );

    if (signed.error !== null || signed.data === null) {
      // The log already records that a URL was asked for and this one never
      // existed, which is the correct trail.
      log.warn("signed url mint failed", { err: signed.error, documentId: doc.id });

      /*
        "Object not found" is NOT our fault and must not be a 500. It means the
        metadata row points at a path with no bytes behind it — which is the state
        of every seeded demo document in this deployment: the row was inserted, the
        file never uploaded. A 500 tells the reader "something broke, try again",
        and they retry forever. The truth is that there is nothing to open, which is
        a sentence the screen can show once and act on.
      */
      const missing = /not found|does not exist/i.test(signed.error?.message ?? "");
      status = missing ? 409 : 502;
      if (missing) {
        return conflict(
          "The record exists but its file is not in storage, so there is nothing to open.",
          "DOCUMENT_FILE_MISSING",
        ).toResponse(cors);
      }
      return badGateway(
        "Storage did not return a link for this file. Try again shortly.",
        "DOCUMENT_URL_UNAVAILABLE",
      ).toResponse(cors);
    }

    status = 200;
    return ok({
      document_id: doc.id,
      url: signed.data.signedUrl,
      expires_in_seconds: SIGNED_URL_TTL_SECONDS,
      expires_at: expiresAt,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      title: doc.title,
      // Surfaced so the screen can say "not yet scanned" instead of implying a
      // clean bill of health this deployment cannot give.
      virus_scan_status: doc.virus_scan_status,
      access_kind: body.access_kind,
      // `ok()` already returns a Response — unlike the problem helpers, it is not
      // chained with .toResponse(), so the CORS headers go in the init.
    }, { headers: cors, requestId });
  } catch (err) {
    const problem = toProblem(err, requestId);
    status = problem.status;
    if (problem.status >= 500) log.error("unhandled failure", { err });
    return problem.toResponse(cors);
  } finally {
    log.info("request complete", { status, durationMs: nowMs() - started });
  }
});
