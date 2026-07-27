/**
 * hooks.ts — TanStack Query hooks for the Audit & Compliance console.
 *
 * Keys come from `qk.admin.*` only (frontend-contract §5). Every list here is
 * KEYSET-paginated through `useInfiniteQuery`, because `audit_log`,
 * `data_access_log`, `export_log` and `sessions_audit` are append-only tables
 * that are being written WHILE an auditor scrolls them: OFFSET paging over a
 * growing log repeats and skips rows, which on an evidence surface is not a
 * cosmetic bug. `paginate()` in the query layer already enforces the cursor
 * predicate; these hooks just carry the cursor.
 *
 * `retry: shouldRetryQuery` everywhere: a `no_permission` on `/admin/audit` is
 * the honest answer for an admin looking at a super-admin-only register, and
 * hammering RLS three more times does not change it.
 */
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import {
  fetchAuditEvent,
  fetchAuditEventGroup,
  fetchAuditTimeline,
  fetchDataAccessRegister,
  fetchEntityHistory,
  type AuditFilters,
  type AuditRow,
  type DataAccessFilters,
  type DataAccessRow,
} from "../api/audit.api";
import {
  fetchActorNames,
  fetchActorOptions,
  fetchActorProfile,
  fetchAuditSeals,
  fetchExportRegister,
  fetchIntegrityHealth,
  fetchOpenIntegrityFindings,
  fetchSessionAudit,
  type ActorProfile,
  type AuditSealRow,
  type ExportLogFilters,
  type ExportLogRow,
  type IntegrityHealthRow,
  type SessionAuditFilters,
  type SessionAuditRow,
} from "../api/audit-registers.api";

export const AUDIT_PAGE_SIZE = 50;

/** What every infinite list on this console exposes to its page. */
export type AuditInfinite<T> = UseInfiniteQueryResult<
  { pages: Page<T>[]; pageParams: unknown[] },
  Error
>;

/** Flatten the loaded pages into the exact series the grid renders. */
export function flattenPages<T>(
  data: { pages: Page<T>[] } | undefined,
): readonly T[] {
  if (data === undefined) return [];
  const out: T[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

/**
 * `getNextPageParam` is NOT in here on purpose: it is generic in the row type, so
 * each hook declares its own one-liner and TanStack infers `TPageParam` from the
 * concrete `Page<T>`. Spreading a generic function loses that inference.
 */
const INFINITE_BASE = {
  initialPageParam: null as Cursor | null,
  retry: shouldRetryQuery,
} as const;

// -----------------------------------------------------------------------------
// 1. Timeline (/admin/audit) and the actor trail (/admin/audit/user/:userId)
// -----------------------------------------------------------------------------

export function useAuditTimeline(
  filters: AuditFilters,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<AuditRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.auditTrail({ ...filters, pageSize }),
    queryFn: ({ pageParam, signal }) =>
      fetchAuditTimeline(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * Everything one actor did. Same table, same cursor, different key prefix so an
 * actor trail and the global timeline never share a cache entry (they carry
 * different filters and would otherwise collide on `auditTrail`).
 */
export function useActorTrail(
  actorId: string,
  filters: AuditFilters,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<AuditRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.auditUser(actorId, { ...filters, pageSize }),
    queryFn: ({ pageParam, signal }) =>
      fetchAuditTimeline({ ...filters, actorIds: [actorId] }, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    enabled: actorId !== "",
  });
}

// -----------------------------------------------------------------------------
// 2. One event (/admin/audit/diff/:eventId)
// -----------------------------------------------------------------------------

/**
 * `null` here means "no visible row": either the event id is wrong or RLS
 * withheld it. The page renders those as two different states rather than one
 * misleading "not found" (query.ts's `selectOne` contract).
 */
export function useAuditEvent(eventId: string): UseQueryResult<AuditRow | null, Error> {
  return useQuery({
    queryKey: qk.admin.auditEvent(eventId),
    queryFn: ({ signal }) => fetchAuditEvent(eventId, signal),
    enabled: eventId !== "",
    retry: shouldRetryQuery,
  });
}

/**
 * The sibling field-changes written by the same statement. `request_id` is what
 * the write layer stamps from `x-request-id`, so this is the whole edit — the
 * `event_group_id` §13.1 specifies is not a deployed column.
 */
export function useAuditEventGroup(
  requestId: string | null,
): UseQueryResult<AuditRow[], Error> {
  return useQuery({
    queryKey: qk.admin.auditEventGroup(requestId ?? ""),
    queryFn: ({ signal }) => fetchAuditEventGroup(requestId ?? "", signal),
    enabled: requestId !== null && requestId !== "",
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. Entity history (/admin/audit/entity/:type/:id)
// -----------------------------------------------------------------------------

export function useEntityHistory(
  entityTable: string,
  entityId: string,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<AuditRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.auditEntity(entityTable, entityId),
    queryFn: ({ pageParam, signal }) =>
      fetchEntityHistory(entityTable, entityId, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
    enabled: entityTable !== "" && entityId !== "",
  });
}

// -----------------------------------------------------------------------------
// 4. Sessions (/admin/audit/sessions)
// -----------------------------------------------------------------------------

export function useSessionAudit(
  filters: SessionAuditFilters,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<SessionAuditRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.auditSessions({ ...filters, pageSize }),
    queryFn: ({ pageParam, signal }) => fetchSessionAudit(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

// -----------------------------------------------------------------------------
// 5. Data access (/admin/audit/data-access)
// -----------------------------------------------------------------------------

export function useDataAccessRegister(
  filters: DataAccessFilters,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<DataAccessRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.dataAccess({ ...filters, pageSize }),
    queryFn: ({ pageParam, signal }) =>
      fetchDataAccessRegister(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

// -----------------------------------------------------------------------------
// 6. Exports (/admin/audit/exports)
// -----------------------------------------------------------------------------

export function useExportRegister(
  filters: ExportLogFilters,
  pageSize = AUDIT_PAGE_SIZE,
): AuditInfinite<ExportLogRow> {
  return useInfiniteQuery({
    ...INFINITE_BASE,
    queryKey: qk.admin.auditExports({ ...filters, pageSize }),
    queryFn: ({ pageParam, signal }) => fetchExportRegister(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

// -----------------------------------------------------------------------------
// 7. Integrity (/admin/audit/integrity)
// -----------------------------------------------------------------------------

export function useAuditSeals(from: string, to: string): UseQueryResult<AuditSealRow[], Error> {
  return useQuery({
    queryKey: qk.admin.auditSeals(from, to),
    queryFn: ({ signal }) => fetchAuditSeals(from, to, 400, signal),
    retry: shouldRetryQuery,
  });
}

export function useIntegrityHealth(): UseQueryResult<IntegrityHealthRow[], Error> {
  return useQuery({
    queryKey: qk.admin.auditIntegrityHealth(),
    queryFn: ({ signal }) => fetchIntegrityHealth(30, signal),
    retry: shouldRetryQuery,
  });
}

export function useOpenIntegrityFindings(): UseQueryResult<IntegrityHealthRow[], Error> {
  return useQuery({
    queryKey: [...qk.admin.auditIntegrityHealth(), "open"],
    queryFn: ({ signal }) => fetchOpenIntegrityFindings(20, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 8. Actor identity — resolving uuids to names
// -----------------------------------------------------------------------------

/**
 * Resolve the actor ids present in the CURRENTLY LOADED rows. Deliberately not a
 * join in the view: `audit_log` carries a denormalised `actor_email` for exactly
 * this reason, and a per-page name lookup keeps the timeline query narrow while
 * still putting a human name on screen.
 *
 * A failure here is PARTIAL, never fatal — the grid falls back to the email the
 * row already carries. That is why the pages pass this as `partialError`.
 */
export function useActorNames(
  ids: readonly string[],
): UseQueryResult<ReadonlyMap<string, ActorProfile>, Error> {
  return useQuery({
    queryKey: qk.admin.auditActorNames(ids),
    queryFn: ({ signal }) => fetchActorNames(ids, signal),
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** The actor filter's picker list. */
export function useActorOptions(): UseQueryResult<ActorProfile[], Error> {
  return useQuery({
    queryKey: qk.admin.auditActorNames(["__all__"]),
    queryFn: ({ signal }) => fetchActorOptions(200, signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export function useActorProfile(actorId: string): UseQueryResult<ActorProfile | null, Error> {
  return useQuery({
    queryKey: qk.admin.auditActorNames([actorId]),
    queryFn: ({ signal }) => fetchActorProfile(actorId, signal),
    enabled: actorId !== "",
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}
