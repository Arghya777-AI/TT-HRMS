/**
 * §9 · /admin/documents/access-log — Document Access Log. Who opened which
 * document, and when.
 *
 * `public.document_access_log` is deployed, append-only (UPDATE and DELETE are
 * refused by `audit.refuse_mutation`) and readable by an admin, so this register
 * is real rows over a real table with real filters.
 *
 * THE HONEST GAP, and it is the important thing on this screen: the table's own
 * COMMENT names its only writer — "the document-access edge function, which is
 * the only writer" — and there is NO `supabase/functions/document-access/` in
 * this repo. So today the log fills from exactly one place: `document-generate`
 * writes a `signed_url_minted` row (with the mandatory `purpose`) before it mints
 * a download link. Views, downloads and prints of existing documents are
 * therefore NOT being recorded yet, and this screen says that out loud rather
 * than letting an empty register read as "nobody has opened anything".
 *
 * Nothing here is derived: `bytes_served`, `purpose`, `access_kind` and the
 * actor are columns. Actor names come from `profiles` (the same read the audit
 * registers use) and document titles from `documents` — both joins, not
 * computations.
 *
 * @route /admin/documents/access-log
 */
import { useMemo, useState } from "react";
import { Eye, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { dash, formatNumber } from "@/lib/format";
import { addIstDays, fmtDateTime, istRangeInstantBounds, nowIstDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/Field";
import {
  ACCESS_LOG_PAGE_SIZE,
  flattenAccessLog,
  useAccessActorNames,
  useAccessLog,
  useAccessLogCount,
  useDocumentTitles,
} from "../hooks/useDocumentsAdmin";
import {
  accessKindValues,
  type AccessKind,
  type AccessLogFilters,
  type AccessLogRow,
} from "../api/documents.api";
import { ACCESS_KIND_LABELS, fmtFileSize } from "../documents/labels";

export default function DocumentAccessLogPage() {
  const today = nowIstDate();

  const [from, setFrom] = useState(() => addIstDays(today, -30));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<AccessKind | "">("");
  const [withPurposeOnly, setWithPurposeOnly] = useState(false);

  const filters = useMemo<AccessLogFilters>(() => {
    const bounds =
      from !== "" && to !== "" && from <= to ? istRangeInstantBounds(from, to) : null;
    return {
      ...(kind !== "" ? { accessKinds: [kind] } : {}),
      ...(withPurposeOnly ? { withPurposeOnly: true } : {}),
      ...(bounds !== null
        ? { fromInstant: bounds.fromInstant, toInstantExclusive: bounds.toInstantExclusive }
        : {}),
    };
  }, [from, to, kind, withPurposeOnly]);

  const rangeInvalid = from !== "" && to !== "" && from > to;

  const page = useAccessLog(filters);
  const total = useAccessLogCount(filters);
  const rows = flattenAccessLog(page.data);

  const actorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) ids.add(row.accessed_by);
    return [...ids];
  }, [rows]);
  const documentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) ids.add(row.document_id);
    return [...ids];
  }, [rows]);

  const actors = useAccessActorNames(actorIds);
  const titles = useDocumentTitles(documentIds);

  const columns: DataGridColumn<AccessLogRow>[] = [
    {
      key: "recorded_at",
      header: t("admin.docs.log.col.when"),
      width: "13rem",
      sortable: true,
      render: (row) => <span className="num">{fmtDateTime(row.recorded_at)}</span>,
    },
    {
      key: "accessed_by",
      header: t("admin.docs.log.col.who"),
      width: "15rem",
      render: (row) => {
        const actor = actors.data?.get(row.accessed_by) ?? null;
        return (
          <span className="flex flex-col leading-tight">
            <span className="font-medium normal-case">
              {actor === null ? t("admin.docs.log.unknownActor") : actor.full_name}
            </span>
            <span className="text-xs text-muted-foreground">
              {dash(row.accessed_by_role)}
              {row.on_behalf_of !== null ? ` · ${t("admin.docs.log.onBehalf")}` : ""}
            </span>
          </span>
        );
      },
    },
    {
      key: "document_id",
      header: t("admin.docs.log.col.document"),
      width: "18rem",
      render: (row) => {
        const title = titles.data?.get(row.document_id) ?? null;
        return title === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.docs.log.titleUnknown")}</span>
        ) : (
          <span>{title}</span>
        );
      },
    },
    {
      key: "access_kind",
      header: t("admin.docs.log.col.what"),
      width: "11rem",
      render: (row) => ACCESS_KIND_LABELS[row.access_kind],
    },
    {
      key: "purpose",
      header: t("admin.docs.log.col.why"),
      hideBelow: "md",
      render: (row) =>
        row.purpose === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.docs.log.noPurpose")}</span>
        ) : (
          <span className="text-sm">{row.purpose}</span>
        ),
    },
    {
      key: "bytes_served",
      header: t("admin.docs.log.col.bytes"),
      width: "9rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => <span className="num">{fmtFileSize(row.bytes_served)}</span>,
    },
    {
      key: "signed_url_expires_at",
      header: t("admin.docs.log.col.linkExpiry"),
      width: "13rem",
      align: "right",
      hideBelow: "lg",
      render: (row) => (
        <span className="num">
          {row.signed_url_expires_at === null
            ? dash(null)
            : fmtDateTime(row.signed_url_expires_at)}
        </span>
      ),
    },
    {
      key: "ip",
      header: t("admin.docs.log.col.from"),
      hideBelow: "lg",
      render: (row) => <span className="num text-xs">{dash(row.ip)}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.docs.log.title")}
        subtitle={
          total.isSuccess
            ? t("admin.docs.log.subtitle", { n: formatNumber(total.data) })
            : t("admin.docs.log.subtitlePlain")
        }
      />

      <div className="mt-4">
        <Notice tone="note">{t("admin.docs.log.writerMissing")}</Notice>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.docs.log.filter.from")}
          value={from}
          onChange={setFrom}
          type="date"
          {...(rangeInvalid ? { error: t("admin.docs.log.filter.rangeError") } : {})}
        />
        <TextField
          label={t("admin.docs.log.filter.to")}
          value={to}
          onChange={setTo}
          type="date"
          hint={t("admin.docs.log.filter.toHint")}
        />
        <SelectField
          label={t("admin.docs.log.filter.kind")}
          value={kind}
          placeholder={t("admin.docs.log.filter.anyKind")}
          options={accessKindValues.map((value) => ({
            value,
            label: ACCESS_KIND_LABELS[value],
          }))}
          onChange={(v) => setKind(v as AccessKind | "")}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="button"
            variant={withPurposeOnly ? "default" : "outline"}
            onClick={() => setWithPurposeOnly((v) => !v)}
            aria-pressed={withPurposeOnly}
          >
            {t("admin.docs.log.filter.withPurpose")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFrom(addIstDays(today, -30));
              setTo(today);
              setKind("");
              setWithPurposeOnly(false);
            }}
          >
            {t("admin.docs.exp.filter.clear")}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={page.isPending}
          error={page.error}
          onRetry={() => void page.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? actors.error ?? titles.error}
          partialLabel={t("admin.docs.log.partial")}
          empty={
            <EmptyState
              icon={Eye}
              title={t("admin.docs.log.empty.title")}
              hint={t("admin.docs.log.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={ACCESS_LOG_PAGE_SIZE}
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

      <div className="mt-4">
        <Notice tone="info">{t("admin.docs.log.footnote")}</Notice>
      </div>
    </div>
  );
}
