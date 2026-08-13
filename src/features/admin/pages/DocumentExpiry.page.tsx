/**
 * §9 · /admin/documents/expiry — Expiry Tracker. Licences and certificates about
 * to lapse.
 *
 * The register is `v_document_compliance`, which is the ONLY thing in the system
 * that knows what a given employee is REQUIRED to hold: it crosses every active
 * employee against every `document_types` row flagged
 * `is_required_for_onboarding`, or matching their `employment_type`, or matching
 * their department — then classifies the newest matching document as
 * `missing | expired | expiring_soon | valid`. This screen prints that column.
 * It does not decide what is expiring and it does not count days.
 *
 * Two honest boundaries, stated on the screen rather than papered over:
 *
 *  1. THE 60-DAY BAND IS FIXED IN SQL. `expiring_soon` is
 *     `expiry_date <= util.ist_today() + 60` inside the view; it takes no
 *     parameter. So there is no "next N days" selector pretending to change it.
 *     What IS offered is a real filter on a real column — `expiry_date <= <date>`
 *     — which narrows the register without redefining the band.
 *  2. THE VIEW HAS NO UNIQUE KEY. One row is one (employee × required type)
 *     pair, so it cannot be keyset-paginated. The read is capped and the screen
 *     prints the cap beside the server count, instead of implying it is showing
 *     everything.
 *
 * @route /admin/documents/expiry
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarClock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { addIstDays, fmtCivilDate, nowIstDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import {
  COMPLIANCE_ROW_CAP,
  useCompliance,
  useComplianceCount,
  useDocumentTypeOptions,
} from "../hooks/useDocumentsAdmin";
import {
  complianceStatusValues,
  type ComplianceFilters,
  type ComplianceRow,
  type ComplianceStatus,
} from "../api/documents.api";
import { COMPLIANCE_CHIP, DOCUMENT_STATUS_CHIP } from "../documents/labels";

/** The tiles, each a server COUNT over the same predicate the grid then uses. */
const TILES: readonly { status: ComplianceStatus; label: string; tone: string }[] = [
  { status: "expired", label: t("admin.docs.exp.tile.expired"), tone: "border-destructive/50" },
  { status: "expiring_soon", label: t("admin.docs.exp.tile.expiring"), tone: "border-warning/50" },
  { status: "missing", label: t("admin.docs.exp.tile.missing"), tone: "border-destructive/50" },
  { status: "valid", label: t("admin.docs.exp.tile.valid"), tone: "border-success/50" },
];

function isComplianceStatus(value: string | null): value is ComplianceStatus {
  return value !== null && complianceStatusValues.includes(value as ComplianceStatus);
}

export default function DocumentExpiryPage() {
  const [params, setParams] = useSearchParams();

  const rawStatus = params.get("state");
  const status: ComplianceStatus | null = isComplianceStatus(rawStatus) ? rawStatus : null;
  const departmentId = params.get("department") ?? "";
  const typeId = params.get("type") ?? "";
  const lapsingBy = params.get("by") ?? "";
  const nameLike = params.get("q") ?? "";

  const departments = useRefOptions("departments");
  const types = useDocumentTypeOptions();

  const today = nowIstDate();

  const filters = useMemo<ComplianceFilters>(
    () => ({
      ...(status !== null ? { statuses: [status] } : {}),
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(typeId !== "" ? { documentTypeIds: [typeId] } : {}),
      ...(nameLike.trim() !== "" ? { nameLike: nameLike.trim() } : {}),
      ...(lapsingBy !== "" ? { expiringOnOrBefore: lapsingBy } : {}),
    }),
    [status, departmentId, typeId, nameLike, lapsingBy],
  );

  const register = useCompliance(filters);
  const total = useComplianceCount(filters);
  const rows = register.data ?? [];

  // One server count per tile — same view, same filter vocabulary, no summing.
  const counts: Record<ComplianceStatus, ReturnType<typeof useComplianceCount>> = {
    expired: useComplianceCount({ statuses: ["expired"] }),
    expiring_soon: useComplianceCount({ statuses: ["expiring_soon"] }),
    missing: useComplianceCount({ statuses: ["missing"] }),
    valid: useComplianceCount({ statuses: ["valid"] }),
  };

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const hasAnyFilter =
    status !== null ||
    departmentId !== "" ||
    typeId !== "" ||
    lapsingBy !== "" ||
    nameLike.trim() !== "";

  const columns: DataGridColumn<ComplianceRow>[] = [
    {
      key: "display_name",
      header: t("admin.docs.exp.col.employee"),
      width: "16rem",
      sortable: true,
      sortValue: (row) => row.display_name,
      render: (row) => (
        <PersonCell
          name={row.display_name}
          code={row.employee_code}
          secondary={row.department_name}
        />
      ),
    },
    {
      key: "document_type_name",
      header: t("admin.docs.exp.col.type"),
      width: "14rem",
      sortable: true,
      sortValue: (row) => row.document_type_name,
      render: (row) => row.document_type_name,
    },
    {
      key: "compliance_status",
      header: t("admin.docs.exp.col.state"),
      width: "10rem",
      render: (row) => <StatusChip status={row.compliance_status} map={COMPLIANCE_CHIP} />,
    },
    {
      key: "expiry_date",
      header: t("admin.docs.exp.col.lapses"),
      width: "10rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.expiry_date ?? "",
      render: (row) => (
        <span className="num">
          {row.expiry_date === null
            ? row.requires_expiry
              ? t("admin.docs.exp.noDate")
              : t("admin.docs.noExpiry")
            : fmtCivilDate(row.expiry_date)}
        </span>
      ),
    },
    {
      key: "document_status",
      header: t("admin.docs.exp.col.docStatus"),
      width: "10rem",
      hideBelow: "md",
      render: (row) =>
        row.document_status === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.docs.exp.noDocument")}</span>
        ) : (
          <StatusChip status={row.document_status} map={DOCUMENT_STATUS_CHIP} />
        ),
    },
    {
      key: "department_name",
      header: t("admin.docs.exp.col.department"),
      hideBelow: "lg",
      render: (row) => dash(row.department_name),
    },
  ];

  const capped = total.isSuccess && total.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={CalendarClock}
        title={t("admin.docs.exp.title")}
        subtitle={
          total.isSuccess
            ? t("admin.docs.exp.subtitle", { n: formatNumber(total.data) })
            : t("admin.docs.exp.subtitlePlain")
        }
      />

      {/*
        COMPLIANCE, IN ONE BAR. The four bands are the whole of
        `ComplianceStatus` and a requirement holds exactly one of them, so this is
        a true partition — no overlap to reason about and no remainder.

        MISSING AND EXPIRED ARE BOTH RED, deliberately. They are different
        failures — one document was never collected, the other lapsed — but they
        are the same exposure: if an inspector asks today, neither can be produced.
        Colouring "missing" amber because it feels less like a lapse would make the
        bar look better than the venue's position actually is.
      */}
      <div className="mt-4">
        <StatusMixCard
          title={t("admin.docs.exp.mix.title")}
          hint={t("admin.docs.exp.mix.hint")}
          format={(v) => formatNumber(v)}
          totalCaption={(n) => t("admin.docs.exp.mix.total", { n: formatNumber(n) })}
          segments={[
            {
              key: "valid",
              label: t("admin.docs.exp.tile.valid"),
              value: counts.valid.data,
              tone: "present",
            },
            {
              key: "expiring_soon",
              label: t("admin.docs.exp.tile.expiring"),
              value: counts.expiring_soon.data,
              tone: "late",
            },
            {
              key: "expired",
              label: t("admin.docs.exp.tile.expired"),
              value: counts.expired.data,
              tone: "absent",
            },
            {
              key: "missing",
              label: t("admin.docs.exp.tile.missing"),
              value: counts.missing.data,
              tone: "absent",
            },
          ]}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((tile) => {
          const q = counts[tile.status];
          const active = status === tile.status;
          return (
            <button
              key={tile.status}
              type="button"
              onClick={() => setParam("state", active ? "" : tile.status)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tile.tone,
                active && "ring-2 ring-primary",
              )}
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="num mt-1 font-display text-2xl font-semibold">
                {q.isPending ? "…" : q.error !== null ? "—" : formatNumber(q.data)}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.docs.exp.filter.name")}
          value={nameLike}
          onChange={(v) => setParam("q", v)}
          placeholder={t("admin.docs.exp.filter.namePlaceholder")}
        />
        <SelectField
          label={t("admin.docs.exp.filter.department")}
          value={departmentId}
          placeholder={t("admin.docs.exp.filter.anyDepartment")}
          options={(departments.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <SelectField
          label={t("admin.docs.exp.filter.type")}
          value={typeId}
          placeholder={t("admin.docs.exp.filter.anyType")}
          options={(types.data ?? [])
            .filter((row) => row.requiresExpiry)
            .map((row) => ({ value: row.id, label: row.name }))}
          onChange={(v) => setParam("type", v)}
          hint={t("admin.docs.exp.filter.typeHint")}
        />
        <TextField
          label={t("admin.docs.exp.filter.by")}
          value={lapsingBy}
          onChange={(v) => setParam("by", v)}
          type="date"
          hint={t("admin.docs.exp.filter.byHint")}
        />
        <div className="flex flex-wrap items-end gap-2 lg:col-span-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => setParam("by", addIstDays(today, 30))}
          >
            {t("admin.docs.exp.quick.30")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setParam("by", addIstDays(today, 60))}
          >
            {t("admin.docs.exp.quick.60")}
          </Button>
          <Button type="button" variant="outline" onClick={() => setParam("by", today)}>
            {t("admin.docs.exp.quick.today")}
          </Button>
          {hasAnyFilter ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setParams(new URLSearchParams(), { replace: true })}
            >
              {t("admin.docs.exp.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={register.isPending}
          error={register.error}
          onRetry={() => void register.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? departments.error ?? types.error}
          partialLabel={t("admin.docs.exp.partial")}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={
                hasAnyFilter
                  ? t("admin.docs.exp.empty.filtered.title")
                  : t("admin.docs.exp.empty.title")
              }
              hint={
                hasAnyFilter
                  ? t("admin.docs.exp.empty.filtered.hint")
                  : t("admin.docs.exp.empty.hint")
              }
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={complianceRowKey} pageSize={50} />
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        {capped ? (
          <Notice tone="warning">
            {t("admin.docs.exp.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(total.data),
              cap: formatNumber(COMPLIANCE_ROW_CAP),
            })}
          </Notice>
        ) : null}
        <Notice tone="info">{t("admin.docs.exp.footnote")}</Notice>
      </div>
    </div>
  );
}

/**
 * `v_document_compliance` has no single unique column — the grain is
 * (employee × required document type), so that pair IS the key.
 */
function complianceRowKey(row: ComplianceRow): string {
  return `${row.employee_id}|${row.document_type_id}`;
}
