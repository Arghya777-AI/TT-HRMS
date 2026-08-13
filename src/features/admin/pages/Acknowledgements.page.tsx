/**
 * §14 · /admin/comms/acknowledgements — Acknowledgement Compliance. Who has read
 * and signed what.
 *
 * The register lives in TWO relations and this screen shows both, because either
 * one alone lies:
 *
 *   `v_policy_acknowledgement_status` (migration 037 §6) — one row per document
 *      that carries `requires_acknowledgement`, with assigned / opened /
 *      acknowledged / waived / overdue as COUNTs and `acknowledged_pct` already
 *      rounded inside the view. Nothing on this screen recomputes a percentage.
 *   `document_acknowledgements` (migration 025 §5) — one row per (document,
 *      employee), carrying the EVIDENCE: `scroll_completion_pct`,
 *      `total_read_seconds`, `open_count`, and the exact sentence agreed to.
 *
 * Why the evidence columns matter enough to be on screen: the ack guard trigger
 * refuses to record an acknowledgement below 90% scroll or under
 * `ceil(page_count × 8)` seconds of dwell — "I read the 40-page handbook in four
 * seconds" cannot be stored as informed consent. An auditor asking "how do you
 * know they read it" is answered by these two numbers.
 *
 * LIVE STATE, probed before this screen was written: both relations return 200
 * with ZERO rows, because `documents` is empty on this project — no policy PDF
 * has been uploaded, so nothing has been assigned. The document TYPES that
 * demand an acknowledgement DO exist (POLICY and SOP, 7-day deadline), so the
 * empty state names the missing piece instead of implying full compliance.
 *
 * Waiving an acknowledgement is NOT wired here. `document_acknowledgements` is
 * `FOR ALL` to a scoped admin and `ck_da__waive_reason` demands a reason, so the
 * write is possible — but with no assigned rows there is nothing to waive and a
 * button that cannot be exercised is not a feature.
 *
 * @route /admin/comms/acknowledgements
 */
import { useMemo, useState } from "react";
import { ClipboardCheck, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, fmtMmSs, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import {
  useAcknowledgementCount,
  useAcknowledgements,
  usePolicyAckStatus,
} from "../hooks/useCommsAdmin";
import {
  ackStatusSchema,
  type Acknowledgement,
  type AckFilters,
  type AckStatus,
  type PolicyAckStatus,
} from "../api/comms.api";

const ACK_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  assigned: { label: t("admin.comms.ack.status.assigned"), tone: "neutral" },
  opened: { label: t("admin.comms.ack.status.opened"), tone: "info" },
  acknowledged: { label: t("admin.comms.ack.status.acknowledged"), tone: "success" },
  overdue: { label: t("admin.comms.ack.status.overdue"), tone: "danger" },
  waived: { label: t("admin.comms.ack.status.waived"), tone: "warn" },
};

const ACK_STATUS_LABEL: Readonly<Record<AckStatus, string>> = {
  assigned: t("admin.comms.ack.status.assigned"),
  opened: t("admin.comms.ack.status.opened"),
  acknowledged: t("admin.comms.ack.status.acknowledged"),
  overdue: t("admin.comms.ack.status.overdue"),
  waived: t("admin.comms.ack.status.waived"),
};

export default function AcknowledgementsPage() {
  const today = nowIstDate();
  const [status, setStatus] = useState<AckStatus | "">("");
  const [documentId, setDocumentId] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const rollup = usePolicyAckStatus();
  const documents = useMemo(() => rollup.data ?? [], [rollup.data]);
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of documents) map.set(row.document_id, row.document_title);
    return map;
  }, [documents]);

  const filters = useMemo<AckFilters>(
    () => ({
      ...(status !== "" ? { statuses: [status] } : {}),
      ...(documentId !== "" ? { documentId } : {}),
      ...(overdueOnly ? { overdueOnly: true, today } : {}),
    }),
    [status, documentId, overdueOnly, today],
  );

  const list = useAcknowledgements(filters);
  const total = useAcknowledgementCount(filters);
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Four independent server counts — never derived from the rows on screen.
  const assignedCount = useAcknowledgementCount({ statuses: ["assigned", "opened"] });
  const acknowledgedCount = useAcknowledgementCount({ statuses: ["acknowledged"] });
  const waivedCount = useAcknowledgementCount({ statuses: ["waived"] });
  const overdueCount = useAcknowledgementCount({ overdueOnly: true, today });

  const labels = useEmployeeLabels();

  const anyFilter = status !== "" || documentId !== "" || overdueOnly;
  const clearAll = () => {
    setStatus("");
    setDocumentId("");
    setOverdueOnly(false);
  };

  const rollupColumns: DataGridColumn<PolicyAckStatus>[] = [
    {
      key: "document_title",
      header: t("admin.comms.ack.col.document"),
      sortable: true,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.document_title}</span>
          <span className="text-xs text-muted-foreground">{row.document_type_name}</span>
        </span>
      ),
    },
    {
      key: "assigned",
      header: t("admin.comms.ack.col.assigned"),
      align: "right",
      width: "7rem",
      render: (row) => <span className="num">{formatNumber(row.assigned)}</span>,
    },
    {
      key: "opened",
      header: t("admin.comms.ack.col.opened"),
      align: "right",
      width: "7rem",
      hideBelow: "sm",
      render: (row) => <span className="num">{formatNumber(row.opened)}</span>,
    },
    {
      key: "acknowledged",
      header: t("admin.comms.ack.col.acknowledged"),
      align: "right",
      width: "8rem",
      render: (row) => <span className="num">{formatNumber(row.acknowledged)}</span>,
    },
    {
      key: "acknowledged_pct",
      header: t("admin.comms.ack.col.pct"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <span className="num">{formatPercent(row.acknowledged_pct, { digits: 1 })}</span>
      ),
    },
    {
      key: "overdue",
      header: t("admin.comms.ack.col.overdue"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <span className={row.overdue > 0 ? "num text-destructive" : "num"}>
          {formatNumber(row.overdue)}
        </span>
      ),
    },
    {
      key: "earliest_open_due_on",
      header: t("admin.comms.ack.col.nextDue"),
      width: "10rem",
      hideBelow: "md",
      render: (row) => (
        <span className="text-xs">{fmtCivilDate(row.earliest_open_due_on)}</span>
      ),
    },
    {
      key: "actions",
      header: t("admin.comms.ack.col.actions"),
      align: "right",
      width: "8rem",
      render: (row) => (
        <Button variant="outline" size="sm" onClick={() => setDocumentId(row.document_id)}>
          {t("admin.comms.ack.action.drill")}
        </Button>
      ),
    },
  ];

  const columns: DataGridColumn<Acknowledgement>[] = [
    {
      key: "employee",
      header: t("admin.comms.ack.col.person"),
      render: (row) => {
        const who = labels.data?.get(row.employee_id) ?? null;
        return (
          <PersonCell
            name={who?.name ?? null}
            code={who?.code ?? null}
            secondary={who?.department ?? null}
          />
        );
      },
    },
    {
      key: "document_id",
      header: t("admin.comms.ack.col.document"),
      render: (row) => (
        <span className="text-sm">{dash(titleById.get(row.document_id) ?? null)}</span>
      ),
    },
    {
      key: "status",
      header: t("admin.comms.ack.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={ACK_STATUS_CHIP} />,
    },
    {
      key: "due_on",
      header: t("admin.comms.ack.col.due"),
      width: "9rem",
      render: (row) => <span className="text-xs">{fmtCivilDate(row.due_on)}</span>,
    },
    {
      key: "acknowledged_at",
      header: t("admin.comms.ack.col.signedAt"),
      width: "12rem",
      hideBelow: "md",
      render: (row) => (
        <span className="text-xs">
          {row.acknowledged_at !== null ? fmtDateTime(row.acknowledged_at) : dash(null)}
        </span>
      ),
    },
    {
      key: "evidence",
      header: t("admin.comms.ack.col.evidence"),
      width: "13rem",
      hideBelow: "lg",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num text-xs">
            {t("admin.comms.ack.scroll", {
              pct: formatPercent(row.scroll_completion_pct, { digits: 0 }),
            })}
          </span>
          <span className="num text-xs text-muted-foreground">
            {t("admin.comms.ack.dwell", { time: fmtMmSs(row.total_read_seconds) })} ·{" "}
            {t("admin.comms.ack.opens", { n: formatNumber(row.open_count) })}
          </span>
        </span>
      ),
    },
    {
      key: "reminder_count",
      header: t("admin.comms.ack.col.reminders"),
      align: "right",
      width: "7rem",
      hideBelow: "lg",
      render: (row) => <span className="num">{formatNumber(row.reminder_count)}</span>,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.comms.ack.title")}
        subtitle={
          total.isSuccess
            ? t("admin.comms.ack.subtitle", { n: formatNumber(total.data) })
            : t("admin.comms.ack.subtitlePlain")
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.comms.ack.kpi.open")}
          value={assignedCount.isSuccess ? formatNumber(assignedCount.data) : dash(null)}
          hint={t("admin.comms.ack.kpi.openHint")}
        />
        <KpiTile
          label={t("admin.comms.ack.kpi.acknowledged")}
          value={acknowledgedCount.isSuccess ? formatNumber(acknowledgedCount.data) : dash(null)}
          tone="success"
          hint={t("admin.comms.ack.kpi.acknowledgedHint")}
        />
        <KpiTile
          label={t("admin.comms.ack.kpi.overdue")}
          value={overdueCount.isSuccess ? formatNumber(overdueCount.data) : dash(null)}
          tone={overdueCount.data !== undefined && overdueCount.data > 0 ? "danger" : "neutral"}
          hint={t("admin.comms.ack.kpi.overdueHint")}
        />
        <KpiTile
          label={t("admin.comms.ack.kpi.waived")}
          value={waivedCount.isSuccess ? formatNumber(waivedCount.data) : dash(null)}
          tone={waivedCount.data !== undefined && waivedCount.data > 0 ? "warn" : "neutral"}
          hint={t("admin.comms.ack.kpi.waivedHint")}
        />
      </section>

      {/*
        HOW FAR THE CIRCULATION GOT. The three bands are disjoint status sets —
        a row is assigned/opened, acknowledged, or waived, never two of them.

        `overdue` is NOT a band, though it is a tile above: an overdue row is
        still an ASSIGNED one, so adding it would count those rows twice and
        shrink the acknowledged share, which is the number this screen exists to
        report. Overdue is a property of the open slice, not a fourth state.
      */}
      <div className="mb-6">
        <StatusMixCard
          title={t("admin.comms.ack.mix.title")}
          hint={t("admin.comms.ack.mix.hint")}
          format={(v) => formatNumber(v)}
          totalCaption={(n) => t("admin.comms.ack.mix.total", { n: formatNumber(n) })}
          segments={[
            {
              key: "acknowledged",
              label: t("admin.comms.ack.kpi.acknowledged"),
              value: acknowledgedCount.data,
              tone: "present",
            },
            {
              key: "open",
              label: t("admin.comms.ack.kpi.open"),
              value: assignedCount.data,
              tone: "late",
            },
            /* Amber, not green: a waiver closes the row without anybody reading
               the policy, which is a decision somebody made, not compliance. */
            {
              key: "waived",
              label: t("admin.comms.ack.kpi.waived"),
              value: waivedCount.data,
              tone: "leave",
            },
          ]}
        />
      </div>

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-semibold">
              {t("admin.comms.ack.byDocument")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("admin.comms.ack.byDocumentHint")}
            </p>
          </div>
          <Badge variant="neutral">
            {t("admin.comms.ack.documentCount", { n: formatNumber(documents.length) })}
          </Badge>
        </div>
        <StateBoundary
          loading={rollup.isPending}
          error={rollup.error}
          onRetry={() => void rollup.refetch()}
          isEmpty={documents.length === 0}
          empty={
            <EmptyState
              icon={ClipboardCheck}
              title={t("admin.comms.ack.empty.docs.title")}
              hint={t("admin.comms.ack.empty.docs.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/comms/policies">{t("admin.comms.ack.empty.docs.action")}</Link>
                </Button>
              }
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={rollupColumns}
            rows={documents}
            rowKey={(row) => row.document_id}
            pageSize={10}
          />
        </StateBoundary>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="font-display text-lg font-semibold">{t("admin.comms.ack.register")}</h2>
          <p className="text-sm text-muted-foreground">{t("admin.comms.ack.registerHint")}</p>
        </div>

        <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            label={t("admin.comms.ack.filter.status")}
            value={status}
            placeholder={t("admin.comms.ack.filter.anyStatus")}
            options={ackStatusSchema.options.map((s) => ({ value: s, label: ACK_STATUS_LABEL[s] }))}
            onChange={(v) => setStatus(v as AckStatus | "")}
          />
          <SelectField
            label={t("admin.comms.ack.filter.document")}
            value={documentId}
            placeholder={t("admin.comms.ack.filter.anyDocument")}
            options={documents.map((row) => ({
              value: row.document_id,
              label: row.document_title,
            }))}
            onChange={setDocumentId}
            {...(documents.length === 0
              ? { hint: t("admin.comms.ack.filter.noDocuments") }
              : {})}
          />
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant={overdueOnly ? "default" : "outline"}
              aria-pressed={overdueOnly}
              onClick={() => setOverdueOnly((v) => !v)}
            >
              {t("admin.comms.ack.filter.overdueOnly")}
            </Button>
            {anyFilter ? (
              <Button type="button" variant="ghost" onClick={clearAll}>
                {t("admin.comms.ack.filter.clear")}
              </Button>
            ) : null}
          </div>
          <div className="flex items-end justify-end">
            <p className="text-sm text-muted-foreground">
              {total.isSuccess
                ? t("admin.comms.ack.matching", { n: formatNumber(total.data) })
                : t("admin.comms.ack.matchingUnknown")}
            </p>
          </div>
        </div>

        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? labels.error}
          partialLabel={t("admin.comms.ack.partial.names")}
          empty={
            <EmptyState
              icon={ClipboardCheck}
              title={t("admin.comms.ack.empty.rows.title")}
              hint={
                anyFilter
                  ? t("admin.comms.ack.empty.rows.filteredHint")
                  : t("admin.comms.ack.empty.rows.hint")
              }
              {...(anyFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.comms.ack.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </section>

      <div className="mt-6">
        <Notice tone="info">{t("admin.comms.ack.consentNote")}</Notice>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.ack.footnote")}</p>
    </div>
  );
}
