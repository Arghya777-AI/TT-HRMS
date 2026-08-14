/**
 * §9 · /admin/documents/repository — Document Repository. Every document,
 * searchable, access-logged.
 *
 * Three things this screen is careful about:
 *
 *  1. THE TOTAL IS POSTGRES'S. The header count is a `HEAD … count=exact` over
 *     `documents` using the SAME filter array as the paged read (one builder in
 *     `documents.api.ts`). Counting the loaded rows would make the figure depend
 *     on how many "Load more" clicks the admin has made.
 *  2. THE CATEGORY FILTER IS HONEST ABOUT WHERE CATEGORY LIVES. `documents` has
 *     no category column — it is on `document_types`. Choosing a category
 *     narrows the TYPE picker and sends `document_type_id IN (…)`, so the count
 *     and the grid are the same predicate rather than one of them filtering an
 *     embedded resource the query layer cannot count.
 *  3. IT DOES NOT PRETEND TO OPEN FILES. `documents` states in its own COMMENT
 *     that a file is served only through a signed URL minted by the
 *     `document-access` edge function, which writes `document_access_log` FIRST.
 *     That function is not deployed, so there is no Open button anywhere on this
 *     screen — an unlogged read of a confidential document is worse than no read.
 *
 * @route /admin/documents/repository
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, Files } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/Field";
import { PersonCell } from "../components/PersonCell";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  REPOSITORY_PAGE_SIZE,
  flattenDocuments,
  useDocumentCount,
  useDocumentTypeOptions,
  useDocumentsPage,
} from "../hooks/useDocumentsAdmin";
import {
  documentCategoryValues,
  documentStatusValues,
  subjectKindValues,
  virusScanValues,
  type AdminDocument,
  type DocumentCategory,
  type DocumentFilters,
  type DocumentStatus,
  type SubjectKind,
  type VirusScanStatus,
} from "../api/documents.api";
import {
  CATEGORY_LABELS,
  DOCUMENT_STATUS_CHIP,
  VIRUS_CHIP,
  fmtFileSize,
  subjectKindLabel,
} from "../documents/labels";

export default function DocumentRepositoryPage() {
  const [params, setParams] = useSearchParams();

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<DocumentCategory | "">("");
  const [typeId, setTypeId] = useState("");
  const [subjectKind, setSubjectKind] = useState<SubjectKind | "">("");
  const [virus, setVirus] = useState<VirusScanStatus | "">("");
  const [expiringBefore, setExpiringBefore] = useState("");
  const [confidentialOnly, setConfidentialOnly] = useState(false);
  const [archived, setArchived] = useState(false);

  /*
    `?emp=<uuid>` SCOPES THE REPOSITORY TO ONE PERSON.

    `DocumentFilters.employeeId` has existed all along and this screen never read the URL,
    so a link "this employee's documents" would have landed on every document in the venue
    while implying one person's. That is why the employee record did not link here until
    now — a filter that is silently ignored is worse than no link.
  */
  const employeeId = params.get("emp") ?? "";
  const rawStatus = params.get("status");
  const status: DocumentStatus | "" = documentStatusValues.includes(
    (rawStatus ?? "") as DocumentStatus,
  )
    ? ((rawStatus ?? "") as DocumentStatus)
    : "";

  const types = useDocumentTypeOptions();
  const labels = useEmployeeLabels();

  /** The type ids a category choice stands for — one `in` predicate on the wire. */
  const categoryTypeIds = useMemo<readonly string[]>(() => {
    if (category === "") return [];
    return (types.data ?? []).filter((row) => row.category === category).map((row) => row.id);
  }, [category, types.data]);

  const filters = useMemo<DocumentFilters>(() => {
    const term = title.trim();
    const typeIds: readonly string[] =
      typeId !== "" ? [typeId] : category !== "" ? categoryTypeIds : [];
    return {
      ...(typeIds.length > 0 ? { typeIds } : {}),
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(subjectKind !== "" ? { subjectKind } : {}),
      ...(term !== "" ? { titleLike: term } : {}),
      ...(virus !== "" ? { virusScanStatuses: [virus] } : {}),
      ...(confidentialOnly ? { confidentialOnly: true } : {}),
      ...(expiringBefore !== "" ? { expiringOnOrBefore: expiringBefore } : {}),
      ...(archived ? { archived: true } : {}),
      ...(employeeId !== "" ? { employeeId } : {}),
    };
  }, [
    employeeId,
    typeId,
    category,
    categoryTypeIds,
    status,
    subjectKind,
    title,
    virus,
    confidentialOnly,
    expiringBefore,
    archived,
  ]);

  const page = useDocumentsPage(filters);
  const total = useDocumentCount(filters);
  const rows = flattenDocuments(page.data);

  /**
   * A category with no active types would send NO type filter and quietly widen
   * the register. Say so instead.
   */
  const categoryHasNoTypes =
    category !== "" && typeId === "" && types.isSuccess && categoryTypeIds.length === 0;

  const hasAnyFilter =
    title.trim() !== "" ||
    category !== "" ||
    typeId !== "" ||
    status !== "" ||
    subjectKind !== "" ||
    virus !== "" ||
    expiringBefore !== "" ||
    confidentialOnly ||
    archived;

  const clearAll = () => {
    setTitle("");
    setCategory("");
    setTypeId("");
    setSubjectKind("");
    setVirus("");
    setExpiringBefore("");
    setConfidentialOnly(false);
    setArchived(false);
    setParams(new URLSearchParams(), { replace: true });
  };

  const setStatus = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === "") p.delete("status");
    else p.set("status", next);
    setParams(p, { replace: true });
  };

  const personOf = (row: AdminDocument) =>
    row.employee_id === null ? null : (labels.data?.get(row.employee_id) ?? null);

  const columns: DataGridColumn<AdminDocument>[] = [
    {
      key: "title",
      header: t("admin.docs.repo.col.document"),
      width: "18rem",
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.title}</span>
          <span className="text-xs text-muted-foreground">
            {dash(row.document_types?.name ?? null)}
            {row.is_confidential ? ` · ${t("admin.docs.repo.confidential")}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "employee_id",
      header: t("admin.docs.repo.col.subject"),
      width: "14rem",
      render: (row) => {
        if (row.employee_id === null) {
          return (
            <span className="text-sm text-muted-foreground">
              {subjectKindLabel(row.subject_kind)}
            </span>
          );
        }
        const who = personOf(row);
        return <PersonCell name={who?.name ?? null} code={who?.code ?? null} secondary={who?.department ?? null} />;
      },
    },
    {
      key: "category",
      header: t("admin.docs.repo.col.category"),
      hideBelow: "lg",
      render: (row) =>
        row.document_types === null ? dash(null) : CATEGORY_LABELS[row.document_types.category],
    },
    {
      key: "status",
      header: t("admin.docs.repo.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={DOCUMENT_STATUS_CHIP} />,
    },
    {
      key: "issue_date",
      header: t("admin.docs.repo.col.issued"),
      width: "9rem",
      align: "right",
      sortable: true,
      hideBelow: "md",
      render: (row) => <span className="num">{fmtCivilDate(row.issue_date)}</span>,
    },
    {
      key: "expiry_date",
      header: t("admin.docs.repo.col.validTo"),
      width: "9rem",
      align: "right",
      sortable: true,
      render: (row) => (
        <span className="num">
          {row.expiry_date === null ? t("admin.docs.noExpiry") : fmtCivilDate(row.expiry_date)}
        </span>
      ),
    },
    {
      key: "current_version",
      header: t("admin.docs.repo.col.version"),
      width: "6rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.current_version)}</span>,
    },
    {
      key: "file_size_bytes",
      header: t("admin.docs.repo.col.size"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{fmtFileSize(row.file_size_bytes)}</span>,
    },
    {
      key: "virus_scan_status",
      header: t("admin.docs.repo.col.scan"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => <StatusChip status={row.virus_scan_status} map={VIRUS_CHIP} />,
    },
    {
      key: "uploaded_at",
      header: t("admin.docs.repo.col.filed"),
      width: "12rem",
      align: "right",
      sortable: true,
      hideBelow: "md",
      render: (row) => (
        <span className="flex flex-col items-end leading-tight">
          <span className="num">{fmtDateTime(row.uploaded_at)}</span>
          <span className="text-xs text-muted-foreground">
            {row.is_system_generated
              ? t("admin.docs.repo.bySystem")
              : t("admin.docs.repo.byPerson")}
          </span>
        </span>
      ),
    },
    {
      /*
        OPEN THE FILE. The vault listed nine facts about a document and offered no
        way to look at it — HR could see that an Aadhaar existed, its size and its
        scan state, but not the thing itself. Storage grants no browser-side read on
        this bucket, so the link has to be minted by `document-access`, which did not
        exist until now. Every open is logged before the URL exists.
      */
      key: "open",
      header: "",
      align: "right",
      width: "9rem",
      render: (row) => (
        <DocumentOpenButtons documentId={row.id} title={row.title} variant="icon" />
      ),
    },
  ];

  const subtitle = total.isSuccess
    ? archived
      ? t("admin.docs.repo.subtitle.archived", { n: formatNumber(total.data) })
      : t("admin.docs.repo.subtitle.count", { n: formatNumber(total.data) })
    : t("admin.docs.repo.subtitle.plain");

  return (
    <div className="container py-6">
      <PageHeader icon={Files} title={t("admin.docs.repo.title")} subtitle={subtitle} />

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.docs.repo.filter.title")}
          value={title}
          onChange={setTitle}
          placeholder={t("admin.docs.repo.filter.titlePlaceholder")}
          hint={t("admin.docs.repo.filter.titleHint")}
        />
        <SelectField
          label={t("admin.docs.repo.filter.category")}
          value={category}
          placeholder={t("admin.docs.repo.filter.anyCategory")}
          options={documentCategoryValues.map((value) => ({
            value,
            label: CATEGORY_LABELS[value],
          }))}
          onChange={(v) => {
            setCategory(v as DocumentCategory | "");
            setTypeId("");
          }}
          hint={t("admin.docs.repo.filter.categoryHint")}
        />
        <SelectField
          label={t("admin.docs.repo.filter.type")}
          value={typeId}
          placeholder={t("admin.docs.repo.filter.anyType")}
          options={(types.data ?? [])
            .filter((row) => category === "" || row.category === category)
            .map((row) => ({ value: row.id, label: row.name }))}
          onChange={setTypeId}
        />
        <SelectField
          label={t("admin.docs.repo.filter.status")}
          value={status}
          placeholder={t("admin.docs.repo.filter.anyStatus")}
          options={documentStatusValues.map((value) => ({
            value,
            label: DOCUMENT_STATUS_CHIP[value].label,
          }))}
          onChange={setStatus}
        />
        <SelectField
          label={t("admin.docs.repo.filter.subject")}
          value={subjectKind}
          placeholder={t("admin.docs.repo.filter.anySubject")}
          options={subjectKindValues.map((value) => ({
            value,
            label: subjectKindLabel(value),
          }))}
          onChange={(v) => setSubjectKind(v as SubjectKind | "")}
        />
        <SelectField
          label={t("admin.docs.repo.filter.scan")}
          value={virus}
          placeholder={t("admin.docs.repo.filter.anyScan")}
          options={virusScanValues.map((value) => ({ value, label: VIRUS_CHIP[value].label }))}
          onChange={(v) => setVirus(v as VirusScanStatus | "")}
        />
        <TextField
          label={t("admin.docs.repo.filter.expiring")}
          value={expiringBefore}
          onChange={setExpiringBefore}
          type="date"
          hint={t("admin.docs.repo.filter.expiringHint")}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="button"
            variant={confidentialOnly ? "default" : "outline"}
            onClick={() => setConfidentialOnly((v) => !v)}
            aria-pressed={confidentialOnly}
          >
            {t("admin.docs.repo.filter.confidential")}
          </Button>
          <Button
            type="button"
            variant={archived ? "default" : "outline"}
            onClick={() => setArchived((v) => !v)}
            aria-pressed={archived}
          >
            {t("admin.docs.repo.filter.archived")}
          </Button>
          {hasAnyFilter ? (
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.docs.repo.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      {archived ? (
        <div className="mt-3">
          <Notice tone="info">{t("admin.docs.repo.archivedNotice")}</Notice>
        </div>
      ) : null}

      {categoryHasNoTypes ? (
        <div className="mt-3">
          <Notice tone="warning">
            {t("admin.docs.repo.categoryEmpty", { category: CATEGORY_LABELS[category] })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={page.isPending}
          error={page.error}
          onRetry={() => void page.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? labels.error ?? types.error}
          partialLabel={t("admin.docs.repo.partial")}
          empty={
            <EmptyState
              icon={FileText}
              title={
                hasAnyFilter
                  ? t("admin.docs.repo.empty.filtered.title")
                  : t("admin.docs.repo.empty.title")
              }
              hint={
                hasAnyFilter
                  ? t("admin.docs.repo.empty.filtered.hint")
                  : t("admin.docs.repo.empty.hint")
              }
              {...(hasAnyFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.docs.repo.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={REPOSITORY_PAGE_SIZE}
          />

          {page.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void page.fetchNextPage()}
                disabled={page.isFetchingNextPage}
              >
                {page.isFetchingNextPage
                  ? t("admin.docs.repo.loadingMore")
                  : t("admin.docs.repo.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        <Notice tone="note">{t("admin.docs.repo.noOpen")}</Notice>
        <Notice tone="info">{t("admin.docs.repo.footnote")}</Notice>
      </div>
    </div>
  );
}
