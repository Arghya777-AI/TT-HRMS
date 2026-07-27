/**
 * useDocumentsAdmin.ts — the data layer behind the eight `/admin/documents/**`
 * screens.
 *
 * Four rules this file exists to keep:
 *
 *  1. THE TOTAL AND THE ROWS SHARE A PREDICATE. Every register here has a
 *     `use…Count` beside its `use…` list, and both are handed the SAME filter
 *     object; `documents.api.ts` builds both requests from one filter builder.
 *     Counting loaded rows would make a header total depend on how far the admin
 *     has scrolled (DR-29).
 *  2. COUNTS ARE KEPT AS SEPARATE QUERIES. A failed count degrades to "—" on the
 *     header while the grid still renders — the PARTIAL state, not a dead screen.
 *  3. KEYSET PAGING WHERE THE TABLE GROWS UNDER US. `documents` and
 *     `document_access_log` are written while they are read, so both paginate on
 *     a cursor. `v_document_compliance` has no unique column and therefore
 *     cannot be keyset-paged at all: it is read with a cap, and the screen prints
 *     the cap next to the server count.
 *  4. QUERY KEYS COME FROM `qk` ONLY. There is no `qk.admin.documents*` factory,
 *     so these keys are built from `qk.admin.list({ area: "documents", … })` and
 *     `qk.admin.documentCompliance(…)`, which already exists. One
 *     `invalidateQueries({ queryKey: qk.admin.lists() })` after a write refreshes
 *     every register in this domain at once.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery, type Cursor, type Page } from "@/shared/api/query";
import {
  useAuditedMutation,
  type AuditedMutationResult,
} from "@/shared/hooks/useAuditedMutation";
import { fetchActorNames, type ActorProfile } from "../api/audit-registers.api";
import {
  REASON_DOC_TYPE_MASTER,
  archiveDocumentType,
  countAccessLog,
  countAcknowledgements,
  countCompliance,
  countContractTemplates,
  countDocumentTypes,
  countDocuments,
  countEsignRequests,
  fetchAccessLog,
  fetchAcknowledgements,
  fetchCompliance,
  fetchContractTemplates,
  fetchDocumentList,
  fetchDocumentTitles,
  fetchDocumentTypeOptions,
  fetchDocumentTypes,
  fetchDocuments,
  fetchEsignRequests,
  fetchEsignSigners,
  fetchPolicyAckStatus,
  generateDocument,
  insertDocumentType,
  updateDocumentType,
  type AccessLogFilters,
  type AccessLogRow,
  type AckFilters,
  type AdminAck,
  type AdminDocument,
  type ComplianceFilters,
  type ComplianceRow,
  type ContractTemplate,
  type DocumentFilters,
  type DocumentType,
  type DocumentTypeFilters,
  type DocumentTypeOption,
  type EsignFilters,
  type EsignRequest,
  type EsignSigner,
  type GenerateInput,
  type GenerateResult,
  type PolicyAckStatus,
  type TemplateFilters,
} from "../api/documents.api";

export const REPOSITORY_PAGE_SIZE = 50;
export const ACCESS_LOG_PAGE_SIZE = 50;
/** The compliance register's read cap. Printed on screen beside the count. */
export const COMPLIANCE_ROW_CAP = 500;
export const ACK_ROW_CAP = 400;
export const ESIGN_ROW_CAP = 200;
export const QUEUE_ROW_CAP = 200;

/**
 * All keys for this domain sit under `["admin","list",{area:"documents",…}]`, so
 * one `qk.admin.lists()` invalidation covers the whole console section.
 */
function docsKey(part: string, filters: Record<string, unknown> = {}): readonly unknown[] {
  return qk.admin.list({ area: "documents", part, ...filters });
}

/** Query keys must be plain comparable data; readonly arrays are flattened. */
function typeFilterKey(f: DocumentTypeFilters): Record<string, unknown> {
  return {
    categories: [...(f.categories ?? [])].sort(),
    includeInactive: f.includeInactive === true,
    archived: f.archived === true,
    nameLike: f.nameLike ?? "",
    requiresExpiryOnly: f.requiresExpiryOnly === true,
    requiresAckOnly: f.requiresAckOnly === true,
    requiresEsignOnly: f.requiresEsignOnly === true,
    onboardingOnly: f.onboardingOnly === true,
  };
}

function documentFilterKey(f: DocumentFilters, pageSize: number): Record<string, unknown> {
  return {
    typeIds: [...(f.typeIds ?? [])].sort(),
    statuses: [...(f.statuses ?? [])].sort(),
    employeeId: f.employeeId ?? "",
    subjectKind: f.subjectKind ?? "",
    titleLike: f.titleLike ?? "",
    virusScanStatuses: [...(f.virusScanStatuses ?? [])].sort(),
    confidentialOnly: f.confidentialOnly === true,
    requiresAckOnly: f.requiresAckOnly === true,
    systemGeneratedOnly: f.systemGeneratedOnly === true,
    hasExpiryOnly: f.hasExpiryOnly === true,
    expiringOnOrBefore: f.expiringOnOrBefore ?? "",
    expiringOnOrAfter: f.expiringOnOrAfter ?? "",
    archived: f.archived === true,
    pageSize,
  };
}

function complianceFilterKey(f: ComplianceFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    departmentIds: [...(f.departmentIds ?? [])].sort(),
    documentTypeIds: [...(f.documentTypeIds ?? [])].sort(),
    nameLike: f.nameLike ?? "",
    expiringOnOrBefore: f.expiringOnOrBefore ?? "",
  };
}

function ackFilterKey(f: AckFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    employeeId: f.employeeId ?? "",
    documentId: f.documentId ?? "",
    dueBefore: f.dueBefore ?? "",
    dueOnOrBefore: f.dueOnOrBefore ?? "",
    neverOpenedOnly: f.neverOpenedOnly === true,
  };
}

function templateFilterKey(f: TemplateFilters): Record<string, unknown> {
  return {
    kinds: [...(f.kinds ?? [])].sort(),
    publishedOnly: f.publishedOnly === true,
    includeInactive: f.includeInactive === true,
    nameLike: f.nameLike ?? "",
  };
}

function esignFilterKey(f: EsignFilters): Record<string, unknown> {
  return {
    statuses: [...(f.statuses ?? [])].sort(),
    employeeId: f.employeeId ?? "",
    titleLike: f.titleLike ?? "",
  };
}

function accessFilterKey(f: AccessLogFilters, pageSize: number): Record<string, unknown> {
  return {
    documentId: f.documentId ?? "",
    actorId: f.actorId ?? "",
    accessKinds: [...(f.accessKinds ?? [])].sort(),
    fromInstant: f.fromInstant ?? "",
    toInstantExclusive: f.toInstantExclusive ?? "",
    withPurposeOnly: f.withPurposeOnly === true,
    pageSize,
  };
}

// -----------------------------------------------------------------------------
// 1. document_types — /admin/documents/types
// -----------------------------------------------------------------------------

export function useDocumentTypes(
  filters: DocumentTypeFilters = {},
): UseQueryResult<DocumentType[], Error> {
  return useQuery({
    queryKey: docsKey("types", typeFilterKey(filters)),
    queryFn: ({ signal }) => fetchDocumentTypes(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useDocumentTypeCount(
  filters: DocumentTypeFilters = {},
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("types-count", typeFilterKey(filters)),
    queryFn: ({ signal }) => countDocumentTypes(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** The active types, for every picker on the other seven screens. */
export function useDocumentTypeOptions(): UseQueryResult<DocumentTypeOption[], Error> {
  return useQuery({
    queryKey: docsKey("type-options"),
    queryFn: ({ signal }) => fetchDocumentTypeOptions(signal),
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

export interface DocumentTypeSaveInput {
  /** NULL → create. */
  readonly id: string | null;
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Create or edit a document type. A routine field edit carries the default
 * sentence; the screen prompts for a typed one whenever a POLICY field changes
 * (retention, visibility, whether the type is required), because those rows
 * decide what the compliance register demands of every employee.
 */
export function useSaveDocumentType(
  opts: { readonly alwaysPrompt?: boolean } = {},
): AuditedMutationResult<DocumentType, DocumentTypeSaveInput> {
  return useAuditedMutation<DocumentType, DocumentTypeSaveInput>({
    mutationFn: (input, reason) =>
      input.id === null
        ? insertDocumentType(input.values, reason)
        : updateDocumentType(input.id, input.values, reason),
    invalidate: [qk.admin.lists(), qk.admin.auditAll()],
    ...(opts.alwaysPrompt === true ? {} : { defaultReason: REASON_DOC_TYPE_MASTER }),
  });
}

export interface DocumentTypeIdInput {
  readonly id: string;
}

/** Retire a type (soft delete, D-23). Always prompts; the floor is 15. */
export function useArchiveDocumentType(): AuditedMutationResult<void, DocumentTypeIdInput> {
  return useAuditedMutation<void, DocumentTypeIdInput>({
    mutationFn: (input, reason) => archiveDocumentType(input.id, reason),
    invalidate: [qk.admin.lists(), qk.admin.auditAll()],
    minReasonLength: 15,
  });
}

// -----------------------------------------------------------------------------
// 2. documents — /admin/documents/repository and the queues
// -----------------------------------------------------------------------------

export type DocumentsInfinite = UseInfiniteQueryResult<
  { pages: Page<AdminDocument>[]; pageParams: unknown[] },
  Error
>;

export function useDocumentsPage(
  filters: DocumentFilters,
  pageSize = REPOSITORY_PAGE_SIZE,
): DocumentsInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    queryKey: docsKey("repository", documentFilterKey(filters, pageSize)),
    queryFn: ({ pageParam, signal }) => fetchDocuments(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function flattenDocuments(
  data: { pages: Page<AdminDocument>[] } | undefined,
): readonly AdminDocument[] {
  if (data === undefined) return [];
  const out: AdminDocument[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

export function useDocumentCount(filters: DocumentFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("repository-count", documentFilterKey(filters, 0)),
    queryFn: ({ signal }) => countDocuments(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** A capped, unpaged slice — the review queue and the expiring-documents list. */
export function useDocumentList(
  filters: DocumentFilters,
  order: "uploaded" | "expiry" = "uploaded",
  limit = QUEUE_ROW_CAP,
): UseQueryResult<AdminDocument[], Error> {
  return useQuery({
    queryKey: docsKey("list", { ...documentFilterKey(filters, limit), order }),
    queryFn: ({ signal }) => fetchDocumentList(filters, limit, order, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 3. v_document_compliance — /admin/documents/expiry
// -----------------------------------------------------------------------------

export function useCompliance(
  filters: ComplianceFilters,
  limit = COMPLIANCE_ROW_CAP,
): UseQueryResult<ComplianceRow[], Error> {
  return useQuery({
    queryKey: qk.admin.documentCompliance({ ...complianceFilterKey(filters), limit }),
    queryFn: ({ signal }) => fetchCompliance(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

export function useComplianceCount(filters: ComplianceFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: qk.admin.documentCompliance({ ...complianceFilterKey(filters), count: true }),
    queryFn: ({ signal }) => countCompliance(filters, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. document_acknowledgements — /admin/documents/pending
// -----------------------------------------------------------------------------

export function useAcknowledgements(
  filters: AckFilters,
  limit = ACK_ROW_CAP,
): UseQueryResult<AdminAck[], Error> {
  return useQuery({
    queryKey: docsKey("acks", { ...ackFilterKey(filters), limit }),
    queryFn: ({ signal }) => fetchAcknowledgements(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

export function useAckCount(filters: AckFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("acks-count", ackFilterKey(filters)),
    queryFn: ({ signal }) => countAcknowledgements(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** Per-document acknowledgement roll-up. Every figure is the view's own. */
export function usePolicyAckStatus(): UseQueryResult<PolicyAckStatus[], Error> {
  return useQuery({
    queryKey: docsKey("policy-ack-status"),
    queryFn: ({ signal }) => fetchPolicyAckStatus(200, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 5. contract_templates — /admin/documents/templates and /generate
// -----------------------------------------------------------------------------

export function useContractTemplates(
  filters: TemplateFilters = {},
): UseQueryResult<ContractTemplate[], Error> {
  return useQuery({
    queryKey: docsKey("templates", templateFilterKey(filters)),
    queryFn: ({ signal }) => fetchContractTemplates(filters, signal),
    retry: shouldRetryQuery,
  });
}

export function useContractTemplateCount(
  filters: TemplateFilters = {},
): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("templates-count", templateFilterKey(filters)),
    queryFn: ({ signal }) => countContractTemplates(filters, signal),
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 6. e-sign — /admin/documents/esign
// -----------------------------------------------------------------------------

export function useEsignRequests(
  filters: EsignFilters,
  limit = ESIGN_ROW_CAP,
): UseQueryResult<EsignRequest[], Error> {
  return useQuery({
    queryKey: docsKey("esign", { ...esignFilterKey(filters), limit }),
    queryFn: ({ signal }) => fetchEsignRequests(filters, limit, signal),
    retry: shouldRetryQuery,
  });
}

export function useEsignCount(filters: EsignFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("esign-count", esignFilterKey(filters)),
    queryFn: ({ signal }) => countEsignRequests(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** The signer chains for the requests on screen, grouped by request id. */
export function useEsignSigners(
  requestIds: readonly string[],
): UseQueryResult<ReadonlyMap<string, EsignSigner[]>, Error> {
  const ids = [...requestIds].sort();
  return useQuery({
    queryKey: docsKey("esign-signers", { ids }),
    queryFn: async ({ signal }) => {
      const rows = await fetchEsignSigners(ids, signal);
      const map = new Map<string, EsignSigner[]>();
      for (const row of rows) {
        const list = map.get(row.esign_request_id);
        if (list === undefined) map.set(row.esign_request_id, [row]);
        else list.push(row);
      }
      return map as ReadonlyMap<string, EsignSigner[]>;
    },
    enabled: ids.length > 0,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 7. document_access_log — /admin/documents/access-log
// -----------------------------------------------------------------------------

export type AccessLogInfinite = UseInfiniteQueryResult<
  { pages: Page<AccessLogRow>[]; pageParams: unknown[] },
  Error
>;

export function useAccessLog(
  filters: AccessLogFilters,
  pageSize = ACCESS_LOG_PAGE_SIZE,
): AccessLogInfinite {
  return useInfiniteQuery({
    initialPageParam: null as Cursor | null,
    retry: shouldRetryQuery,
    queryKey: docsKey("access-log", accessFilterKey(filters, pageSize)),
    queryFn: ({ pageParam, signal }) => fetchAccessLog(filters, pageSize, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function flattenAccessLog(
  data: { pages: Page<AccessLogRow>[] } | undefined,
): readonly AccessLogRow[] {
  if (data === undefined) return [];
  const out: AccessLogRow[] = [];
  for (const page of data.pages) out.push(...page.rows);
  return out;
}

export function useAccessLogCount(filters: AccessLogFilters): UseQueryResult<number, Error> {
  return useQuery({
    queryKey: docsKey("access-log-count", accessFilterKey(filters, 0)),
    queryFn: ({ signal }) => countAccessLog(filters, signal),
    retry: shouldRetryQuery,
  });
}

/** profile id → name, for the actor column. Reuses the audit register's read. */
export function useAccessActorNames(
  ids: readonly string[],
): UseQueryResult<ReadonlyMap<string, ActorProfile>, Error> {
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: qk.admin.auditActorNames(sorted),
    queryFn: ({ signal }) => fetchActorNames(sorted, signal),
    enabled: sorted.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: shouldRetryQuery,
  });
}

/** document id → title, for the access log's document column. */
export function useDocumentTitles(
  ids: readonly string[],
): UseQueryResult<ReadonlyMap<string, string>, Error> {
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: docsKey("titles", { ids: sorted }),
    queryFn: ({ signal }) => fetchDocumentTitles(sorted, signal),
    enabled: sorted.length > 0,
    staleTime: 60 * 1000,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 8. document-generate — /admin/documents/generate
// -----------------------------------------------------------------------------

/**
 * The DRY RUN. Renders, measures and returns the resolved variables without
 * writing anything, so an admin sees the letter before it exists. No reason is
 * asked for because nothing is recorded — the commit below is the audited step.
 */
export function usePreviewDocument(): UseMutationResult<GenerateResult, Error, GenerateInput> {
  return useMutation<GenerateResult, Error, GenerateInput>({
    mutationFn: (input) => generateDocument({ ...input, dryRun: true }),
    retry: false,
  });
}

/**
 * The COMMIT. The typed sentence becomes the function's `purpose`, which is both
 * the audit reason it sets on the transaction (`document-generate` line 1509)
 * and — when a download link is minted — the mandatory `purpose` written to
 * `document_access_log` before the URL exists. One sentence, both records.
 *
 * `idempotencyKey` is supplied by the form and reused across retries; the form
 * mints a NEW one after a success so a deliberate second letter is not silently
 * answered with a replay of the first.
 */
export function useGenerateDocument(
  idempotencyKey: string,
): AuditedMutationResult<GenerateResult, GenerateInput> {
  return useAuditedMutation<GenerateResult, GenerateInput>({
    mutationFn: (input, reason) =>
      generateDocument({ ...input, dryRun: false, purpose: reason }, idempotencyKey),
    invalidate: [qk.admin.lists(), qk.admin.auditAll()],
    minReasonLength: 10,
  });
}
