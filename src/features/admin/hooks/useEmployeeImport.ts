/**
 * useEmployeeImport.ts — TanStack hooks for `/admin/people/import` (§3.4).
 *
 * Two mutations, deliberately separate, because the two acts are separate:
 * `useImportStage` writes only `import_batches` + `import_rows`, and
 * `useImportCommit` is the one that creates people. Neither carries a
 * `defaultReason`: the batch register keeps the sentence beside the file hash
 * forever, and a reason nobody typed is worthless evidence. Staging asks for the
 * database's own floor (10 characters); committing asks for the D-21 floor (15),
 * since it is the act that cannot be undone — no rollback endpoint exists.
 *
 * IDEMPOTENCY IS PER ACT, NOT PER CLICK. `keyFor(signature)` mints one key for a
 * given file+reason (stage) or batch+resume point (commit) and reuses it, so the
 * retry after an MFA step-up refusal REPLAYS the first answer instead of staging
 * a second batch or inserting a second set of employees.
 */
import { useCallback, useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import {
  MIN_REASON_LENGTH,
  SENSITIVE_REASON_LENGTH,
  shouldRetryQuery,
} from "@/shared/api/query";
import { newIdempotencyKey } from "@/shared/api/invoke";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import {
  commitEmployeeImport,
  countImportRows,
  fetchImportBatches,
  fetchImportRows,
  stageEmployeeImport,
  type CommitInput,
  type CommitReport,
  type ImportBatch,
  type ImportRow,
  type ImportRowStatus,
  type StageInput,
  type StageReport,
} from "../api/imports.api";

/** All import keys hang off one area prefix, so a commit refreshes the lot. */
function importKey(part: string, filters: Record<string, unknown> = {}) {
  return qk.admin.list({ area: "employee-import", part, ...filters });
}

const IMPORT_AREA_KEY = qk.admin.lists();

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** The batch register — every staged and committed file, newest first. */
export function useImportBatches(limit = 25): UseQueryResult<ImportBatch[], Error> {
  return useQuery({
    queryKey: importKey("batches", { limit }),
    queryFn: ({ signal }) => fetchImportBatches(limit, signal),
    retry: shouldRetryQuery,
  });
}

/**
 * Staged rows of one batch. `statuses` narrows to the rejected rows (the cleanup
 * list) or the imported ones (the per-row result file the spec asks for).
 */
export function useImportRows(
  batchId: string | null,
  statuses?: readonly ImportRowStatus[],
  limit = 200,
): UseQueryResult<ImportRow[], Error> {
  const statusKey = statuses === undefined ? null : [...statuses].sort().join(",");
  return useQuery({
    queryKey: importKey("rows", { batchId: batchId ?? "none", statuses: statusKey, limit }),
    queryFn: ({ signal }) =>
      fetchImportRows(
        { batchId: batchId as string, ...(statuses ? { statuses } : {}) },
        limit,
        signal,
      ),
    enabled: batchId !== null,
    retry: shouldRetryQuery,
  });
}

/** Server-side COUNT of the batch's rows in a state — never `rows.length`. */
export function useImportRowCount(
  batchId: string | null,
  statuses?: readonly ImportRowStatus[],
): UseQueryResult<number, Error> {
  const statusKey = statuses === undefined ? null : [...statuses].sort().join(",");
  return useQuery({
    queryKey: importKey("row-count", { batchId: batchId ?? "none", statuses: statusKey }),
    queryFn: ({ signal }) =>
      countImportRows({ batchId: batchId as string, ...(statuses ? { statuses } : {}) }, signal),
    enabled: batchId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/** One idempotency key per logical act, held for the life of the screen. */
function useIdempotencyKeys(): (signature: string) => string {
  const keys = useRef<Map<string, string>>(new Map());
  return useCallback((signature: string) => {
    const existing = keys.current.get(signature);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    keys.current.set(signature, fresh);
    return fresh;
  }, []);
}

/** Identifies the upload: same file, same options → same idempotency key. */
function stageSignature(input: StageInput, reason: string): string {
  return [
    input.file.name,
    String(input.file.size),
    String(input.file.lastModified),
    input.delimiter,
    input.companyCode ?? "",
    reason.trim(),
  ].join("|");
}

/**
 * STEP 1. Validates and stages. Invalidates the batch register so the new batch
 * appears in it immediately — the register is the evidence that a dry run
 * happened, and it must never lag the report on screen.
 */
export function useImportStage(): AuditedMutationResult<StageReport, StageInput> {
  const keyFor = useIdempotencyKeys();
  return useAuditedMutation<StageReport, StageInput>({
    minReasonLength: MIN_REASON_LENGTH,
    invalidate: [IMPORT_AREA_KEY],
    mutationFn: (input, reason) =>
      stageEmployeeImport(input, reason, keyFor(`stage|${stageSignature(input, reason)}`)),
  });
}

/**
 * STEP 2. Creates the employees. Invalidates the directory as well as the batch
 * register: the people on `/admin/people` are exactly the rows this call made.
 */
export function useImportCommit(
  onDone?: (report: CommitReport) => void,
): AuditedMutationResult<CommitReport, CommitInput> {
  const keyFor = useIdempotencyKeys();
  return useAuditedMutation<CommitReport, CommitInput>({
    minReasonLength: SENSITIVE_REASON_LENGTH,
    invalidate: [IMPORT_AREA_KEY, qk.admin.employeesAll()],
    mutationFn: (input, reason) =>
      commitEmployeeImport(
        input,
        reason,
        // The resume point is part of the act: chunk two is not a retry of
        // chunk one, so it must not replay chunk one's answer.
        keyFor(`commit|${input.batchId}|${input.afterRowNumber ?? 0}`),
      ),
    ...(onDone ? { onSuccess: (report: CommitReport) => onDone(report) } : {}),
  });
}
