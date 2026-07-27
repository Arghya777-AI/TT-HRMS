/**
 * policies.api.ts — the E-13 reads and the one write (an acknowledgement).
 *
 * There is NO `policies` table in the deployed schema. A policy is a
 * `documents` row whose `document_types.category = 'policy'` (seeded codes
 * `POLICY` and `SOP`, both `requires_acknowledgement = true`), and the
 * per-employee assignment is a `document_acknowledgements` row. Everything E-13
 * needs therefore comes from migration 025:
 *
 *   spec-employee §5 E-13 field   →   deployed column
 *   ---------------------------------------------------------------
 *   `policies.body_html`          →   (absent — the text is a FILE in a private
 *                                     bucket; see the reader page)
 *   `policies.version`            →   `documents.current_version`
 *   `policies.effective_from`     →   `documents.issue_date`
 *   `ack_scroll_gate_percent`     →   90, hard-coded in the DB trigger
 *                                     `document_acknowledgements_ack_guard`
 *   dwell gate                    →   `ceil(coalesce(page_count,1) * 8)` seconds,
 *                                     same trigger
 *   `policy_acknowledgements`     →   `document_acknowledgements`
 *
 * The gate numbers below are read off that trigger, not off the spec, because the
 * trigger is what will refuse the write. The client disables the checkbox early;
 * the database is the enforcer.
 */
import { z } from "zod";
import {
  QueryError,
  dbUuid,
  eq,
  inList,
  selectMany,
  selectOne,
} from "@/shared/api/query";
import { supabase } from "@/lib/supabase";
import { nowInstantIso } from "@/lib/datetime";
import {
  DOCUMENTS_TABLE,
  DOCUMENT_ACKS_TABLE,
  DOCUMENT_ACK_COLUMNS,
  DOCUMENT_TYPES_TABLE,
  documentAckSchema,
  documentSchema,
  type DocumentAck,
  type DocumentRow,
} from "@/features/docs/api/docs.api";

/** Seeded policy-bearing document types (migration 045). */
export const POLICY_TYPE_CODES = ["POLICY", "SOP"] as const;

/** The scroll gate in `document_acknowledgements_ack_guard`. */
export const ACK_SCROLL_GATE_PCT = 90;
/** Seconds-per-page in the same trigger. */
export const ACK_SECONDS_PER_PAGE = 8;

/**
 * The dwell gate the DATABASE will apply to this document:
 * `ceil(coalesce(page_count, 1) * 8)` seconds. Mirrored so the checkbox can be
 * disabled before the write is attempted — the trigger remains the authority.
 */
export function ackDwellSeconds(pageCount: number | null): number {
  return Math.ceil((pageCount ?? 1) * ACK_SECONDS_PER_PAGE);
}

export const policyTypeSchema = z.object({
  id: dbUuid,
  code: z.string(),
  name: z.string(),
  acknowledgement_deadline_days: z.number().int().nullable(),
});

export type PolicyType = z.infer<typeof policyTypeSchema>;

/** The policy document types, which are also the category rail (E-13). */
export async function fetchPolicyTypes(signal?: AbortSignal): Promise<PolicyType[]> {
  return selectMany(DOCUMENT_TYPES_TABLE, policyTypeSchema, {
    columns: "id, code, name, acknowledgement_deadline_days",
    filters: [inList("code", POLICY_TYPE_CODES)],
    order: [{ column: "sort_order", ascending: true }],
    limit: 20,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// The list
// -----------------------------------------------------------------------------

export interface PolicyListRow {
  readonly documentId: string;
  readonly title: string | null;
  readonly categoryName: string | null;
  readonly version: number | null;
  readonly effectiveFrom: string | null;
  readonly pageCount: number | null;
  readonly dueOn: string | null;
  readonly ack: DocumentAck | null;
  /** The document row exists but RLS withheld it — title unknown, not invented. */
  readonly documentReadable: boolean;
}

export interface PolicyList {
  readonly rows: PolicyListRow[];
  /**
   * Assignments whose `documents` row the caller may not read. A company-wide
   * policy (`subject_kind='policy'`, `employee_id IS NULL`) is withheld by
   * `documents__self__select`, so the assignment is visible while the title is
   * not. Counted and stated rather than hidden.
   */
  readonly unreadableCount: number;
}

/**
 * Every policy the caller can see, merged from the two things that exist:
 *  - policy-category `documents` rows on their own record, and
 *  - their `document_acknowledgements` assignments.
 *
 * Merged on `document_id`, so a policy that is both published to the record and
 * assigned for acknowledgement appears once.
 */
export async function fetchPolicyList(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PolicyList> {
  const types = await fetchPolicyTypes(signal);
  const typeIds = types.map((type) => type.id);

  const [docs, acks] = await Promise.all([
    typeIds.length === 0
      ? Promise.resolve<DocumentRow[]>([])
      : selectMany(DOCUMENTS_TABLE, documentSchema, {
          columns:
            "id, document_type_id, employee_id, title, file_name, mime_type, file_size_bytes, " +
            "page_count, current_version, status, issue_date, expiry_date, uploaded_by, " +
            "uploaded_at, reviewed_at, review_comment, is_system_generated, " +
            "requires_acknowledgement, acknowledgement_due_on, " +
            "document_types(code, name, category, requires_expiry)",
          filters: [eq("employee_id", employeeId), inList("document_type_id", typeIds)],
          order: [{ column: "issue_date", ascending: false, nullsFirst: false }],
          limit: 200,
          ...(signal ? { signal } : {}),
        }),
    selectMany(DOCUMENT_ACKS_TABLE, documentAckSchema, {
      columns: DOCUMENT_ACK_COLUMNS,
      filters: [eq("employee_id", employeeId)],
      order: [{ column: "assigned_at", ascending: false }],
      limit: 200,
      ...(signal ? { signal } : {}),
    }),
  ]);

  const byDocument = new Map<string, PolicyListRow>();

  for (const doc of docs) {
    byDocument.set(doc.id, {
      documentId: doc.id,
      title: doc.title,
      categoryName: doc.document_types?.name ?? null,
      version: doc.current_version,
      effectiveFrom: doc.issue_date,
      pageCount: doc.page_count,
      dueOn: doc.acknowledgement_due_on,
      ack: null,
      documentReadable: true,
    });
  }

  let unreadableCount = 0;
  for (const ack of acks) {
    const embedded = ack.documents;
    const existing = byDocument.get(ack.document_id);
    if (existing) {
      byDocument.set(ack.document_id, {
        ...existing,
        ack,
        dueOn: ack.due_on ?? existing.dueOn,
      });
      continue;
    }
    if (embedded === null) unreadableCount += 1;
    byDocument.set(ack.document_id, {
      documentId: ack.document_id,
      title: embedded?.title ?? null,
      categoryName: embedded?.document_types?.name ?? null,
      version: embedded?.current_version ?? null,
      effectiveFrom: embedded?.issue_date ?? null,
      pageCount: embedded?.page_count ?? null,
      dueOn: ack.due_on,
      ack,
      documentReadable: embedded !== null,
    });
  }

  const rows = [...byDocument.values()].sort((a, b) => {
    const aAcked = a.ack?.acknowledged_at !== null && a.ack !== null;
    const bAcked = b.ack?.acknowledged_at !== null && b.ack !== null;
    if (aAcked !== bAcked) return aAcked ? 1 : -1;
    if (a.dueOn !== b.dueOn) {
      if (a.dueOn === null) return 1;
      if (b.dueOn === null) return -1;
      return a.dueOn < b.dueOn ? -1 : 1;
    }
    return (a.title ?? "").localeCompare(b.title ?? "");
  });

  return { rows, unreadableCount };
}

// -----------------------------------------------------------------------------
// One policy
// -----------------------------------------------------------------------------

export interface PolicyDetail {
  readonly document: DocumentRow | null;
  readonly ack: DocumentAck | null;
}

/**
 * One policy and the caller's own assignment row.
 *
 * Both halves are independently nullable and both nulls are meaningful:
 *  - `document === null` → published company-wide, so RLS withholds the row;
 *  - `ack === null`      → readable, but not assigned to this employee, so there
 *                          is nothing to acknowledge.
 */
export async function fetchPolicyDetail(
  documentId: string,
  employeeId: string,
  signal?: AbortSignal,
): Promise<PolicyDetail> {
  const [document, ack] = await Promise.all([
    selectOne(
      DOCUMENTS_TABLE,
      documentSchema,
      [eq("id", documentId)],
      {
        columns:
          "id, document_type_id, employee_id, title, file_name, mime_type, file_size_bytes, " +
          "page_count, current_version, status, issue_date, expiry_date, uploaded_by, " +
          "uploaded_at, reviewed_at, review_comment, is_system_generated, " +
          "requires_acknowledgement, acknowledgement_due_on, " +
          "document_types(code, name, category, requires_expiry)",
        ...(signal ? { signal } : {}),
      },
    ),
    selectOne(
      DOCUMENT_ACKS_TABLE,
      documentAckSchema,
      [eq("document_id", documentId), eq("employee_id", employeeId)],
      { columns: DOCUMENT_ACK_COLUMNS, ...(signal ? { signal } : {}) },
    ),
  ]);
  return { document, ack };
}

// -----------------------------------------------------------------------------
// The acknowledgement write
// -----------------------------------------------------------------------------

export interface AcknowledgePolicyInput {
  /** `document_acknowledgements.id` — the assignment being signed off. */
  readonly ackId: string;
  /** Highest scroll depth reached, 0–100, as the reader measured it. */
  readonly scrollPct: number;
  /** Seconds the reader was actually on the page. */
  readSeconds: number;
  /** The EXACT sentence shown next to the checkbox. Stored verbatim. */
  readonly text: string;
}

/**
 * Record the acknowledgement.
 *
 * Two server-side facts shape this call:
 *  1. `document_acknowledgements_ack_guard` re-checks the scroll and dwell gates,
 *     so a spoofed client cannot record uninformed consent — it raises
 *     `check_violation`.
 *  2. Migration 025 grants UPDATE but defines only a SELECT policy for self, so
 *     the UPDATE can legitimately match ZERO rows. PostgREST reports that as
 *     success with an empty body, which would leave the employee believing they
 *     had acknowledged a policy they had not. `.select()` + an emptiness check
 *     turns that silence into an honest `no_permission`.
 */
export async function acknowledgePolicy(input: AcknowledgePolicyInput): Promise<void> {
  const scrollPct = Math.min(100, Math.max(0, Math.round(input.scrollPct)));
  const { data, error } = await supabase
    .from(DOCUMENT_ACKS_TABLE)
    .update({
      status: "acknowledged",
      acknowledged_at: nowInstantIso(),
      acknowledgement_text: input.text,
      scroll_completion_pct: scrollPct,
      total_read_seconds: Math.max(0, Math.floor(input.readSeconds)),
    })
    .eq("id", input.ackId)
    .select("id");

  if (error) {
    throw new QueryError(
      DOCUMENT_ACKS_TABLE,
      error.code === "42501"
        ? "no_permission"
        : error.code === "23514"
          ? "conflict"
          : "unknown",
      error.message,
      { code: error.code ?? null, details: error.details ?? null, hint: error.hint ?? null, cause: error },
    );
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new QueryError(
      DOCUMENT_ACKS_TABLE,
      "no_permission",
      "The acknowledgement was not recorded: no row was updated. Self-acknowledgement needs an UPDATE policy on document_acknowledgements (migration 025 defines SELECT only).",
    );
  }
}
