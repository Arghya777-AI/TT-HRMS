/**
 * §8 · /admin/payroll/statutory — PF, ESI, PT, LWF and TDS for one payroll run.
 *
 * RECON FIRST, and it changed the design: there is NO `v_statutory` view, no
 * statutory-summary table and no per-run PF/ESI/PT total column anywhere in the
 * deployed schema. What IS deployed is the evidence trail:
 *
 *   * `payslip_lines` rows carrying the statutory `salary_components.code`
 *     (`PF_EE`, `PF_ER`, `EPS_ER`, `EDLI_ER`, `ESI_EE`, `ESI_ER`, `PT`, `LWF_EE`,
 *     `LWF_ER`, `TDS`, `GRATUITY_PROV` — the exact codes `compute_payslip` writes),
 *     each with `amount_paise`, `ytd_amount_paise` and `calc_basis`, the wage and
 *     rate the engine applied. Read here through `v_payslip_detail`.
 *   * `statutory_settings`, the rate set the run PINNED
 *     (`payroll_runs.statutory_settings_id`), so reprinting an old run shows the
 *     ceilings that were in force then rather than today's.
 *
 * So this screen is the statutory REGISTER at line grain — one row per employee
 * per head — plus the rate card that produced it. It does NOT show a run-level
 * "PF payable" figure, because computing one would mean summing paise in the
 * browser: precisely the statutory maths that must never happen client-side. The
 * missing server piece is named on screen, not papered over. The tiles are
 * `count=exact` row counts (how many LINES exist for a head), which is a
 * cardinality, not a total.
 *
 * Lines are deliberately NOT pivoted to one row per employee: a single run can
 * carry two lines for the same code (a regular line and an arrear line), and
 * collapsing them would require adding them together.
 *
 * @route /admin/payroll/statutory
 */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { Money } from "@/shared/ui/Money";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatNumber, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, type SelectOption } from "../components/Field";
import { CountTile } from "../components/CountTile";
import { PAYROLL_RUN_CHIP } from "../display";
import { useAdminPayrollRuns } from "../hooks/useAdminPayroll";
import {
  useStatutoryLineCount,
  useStatutoryLines,
  useStatutorySettings,
} from "../hooks/usePayrollStatutory";
import {
  LINE_ROW_CAP,
  STATUTORY_HEADS,
  STATUTORY_HEAD_KEYS,
  isStatutoryHead,
  readPtSlabs,
  type StatutoryHead,
} from "../api/payroll-statutory.api";
import type { PayrollRun, PayslipLine } from "../api/payroll.api";

function headLabel(head: StatutoryHead): string {
  switch (head) {
    case "pf":
      return t("admin.stat.head.pf");
    case "esi":
      return t("admin.stat.head.esi");
    case "pt":
      return t("admin.stat.head.pt");
    case "lwf":
      return t("admin.stat.head.lwf");
    case "tds":
      return t("admin.stat.head.tds");
    case "gratuity":
      return t("admin.stat.head.gratuity");
  }
}

function runOptions(runs: readonly PayrollRun[] | undefined): SelectOption[] {
  return (runs ?? []).map((run) => ({
    value: run.id,
    label: `${run.run_number} · ${PAYROLL_RUN_CHIP[run.status].label}`,
  }));
}

/** `calc_basis` is jsonb — printed as the proof it is, never re-derived. */
function basisText(basis: unknown): string {
  if (basis === null || basis === undefined) return dash(null);
  if (typeof basis === "string") return basis;
  try {
    return JSON.stringify(basis);
  } catch {
    return dash(null);
  }
}

export default function PayrollStatutoryPage() {
  const [params, setParams] = useSearchParams();
  const runs = useAdminPayrollRuns(null);

  const headParam = params.get("head");
  const head: StatutoryHead | null = isStatutoryHead(headParam) ? headParam : null;
  const firstRunId = runs.data?.[0]?.id ?? "";
  const runId = params.get("run") ?? firstRunId;

  const run = useMemo(
    () => (runs.data ?? []).find((candidate) => candidate.id === runId) ?? null,
    [runs.data, runId],
  );
  const settings = useStatutorySettings(run?.statutory_settings_id ?? null);
  const lines = useStatutoryLines(runId, head);
  const rows = useMemo(() => lines.data ?? [], [lines.data]);
  const matching = useStatutoryLineCount(runId, head);

  const counts: Record<StatutoryHead, ReturnType<typeof useStatutoryLineCount>> = {
    pf: useStatutoryLineCount(runId, "pf"),
    esi: useStatutoryLineCount(runId, "esi"),
    pt: useStatutoryLineCount(runId, "pt"),
    lwf: useStatutoryLineCount(runId, "lwf"),
    tds: useStatutoryLineCount(runId, "tds"),
    gratuity: useStatutoryLineCount(runId, "gratuity"),
  };

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const ptSlabs = readPtSlabs(settings.data?.pt_slabs);

  const columns: DataGridColumn<PayslipLine>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.stat.col.employee"),
        width: "16rem",
        render: (row) => (
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.department_name}
          />
        ),
      },
      {
        key: "label",
        header: t("admin.stat.col.head"),
        width: "14rem",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span>{dash(row.label)}</span>
            <span className="num text-xs text-muted-foreground">{dash(row.component_code)}</span>
          </span>
        ),
      },
      {
        key: "line_kind",
        header: t("admin.stat.col.side"),
        width: "11rem",
        hideBelow: "md",
        render: (row) =>
          row.line_kind === null ? (
            dash(null)
          ) : (
            <span className="text-xs">
              {row.line_kind === "employer_contribution"
                ? t("admin.stat.side.employer")
                : t("admin.stat.side.employee")}
            </span>
          ),
      },
      {
        key: "amount_paise",
        header: t("admin.stat.col.amount"),
        width: "11rem",
        align: "right",
        sortable: true,
        render: (row) => <Money paise={row.amount_paise} className="font-medium" />,
      },
      {
        key: "ytd_amount_paise",
        header: t("admin.stat.col.ytd"),
        width: "11rem",
        align: "right",
        hideBelow: "md",
        render: (row) => <Money paise={row.ytd_amount_paise} />,
      },
      {
        key: "is_arrear",
        header: t("admin.stat.col.arrear"),
        width: "8rem",
        hideBelow: "lg",
        render: (row) =>
          row.is_arrear === true ? (
            <span className="text-xs font-medium text-warning">{t("admin.stat.arrearYes")}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{dash(null)}</span>
          ),
      },
      {
        key: "calc_basis",
        header: t("admin.stat.col.basis"),
        width: "22rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="num block max-w-[22rem] truncate text-xs text-muted-foreground">
            {basisText(row.calc_basis)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.stat.title")}
        subtitle={t("admin.stat.subtitle")}
      />

      <Notice tone="warning" className="mb-4">
        {t("admin.stat.gap.noSummaryView")}
      </Notice>

      <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <SelectField
          label={t("admin.stat.filter.run")}
          value={runId}
          options={runOptions(runs.data)}
          placeholder={t("admin.stat.filter.chooseRun")}
          onChange={(value) => setParam("run", value)}
        />
        <SelectField
          label={t("admin.stat.filter.head")}
          value={head ?? ""}
          options={STATUTORY_HEAD_KEYS.map((key) => ({ value: key, label: headLabel(key) }))}
          placeholder={t("admin.stat.filter.allHeads")}
          onChange={(value) => setParam("head", value)}
        />
        <div className="flex flex-col justify-end gap-1">
          {run !== null ? <StatusChip status={run.status} map={PAYROLL_RUN_CHIP} /> : null}
          <p className="text-sm text-muted-foreground">
            {matching.isSuccess
              ? t("admin.stat.matching", { n: formatNumber(matching.data) })
              : t("admin.stat.matchingUnknown")}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STATUTORY_HEAD_KEYS.map((key) => (
          <CountTile
            key={key}
            label={headLabel(key)}
            hint={t("admin.stat.tile.hint", { codes: STATUTORY_HEADS[key].join(", ") })}
            to={`/admin/payroll/statutory?run=${encodeURIComponent(runId)}&head=${key}`}
            drillLabel={headLabel(key)}
            source={t("admin.stat.source.lines")}
            query={counts[key]}
          />
        ))}
      </div>

      <section className="mt-6">
        <h2 className="mb-2 font-display text-lg font-semibold">{t("admin.stat.rates.title")}</h2>
        <StateBoundary
          loading={settings.isPending && (run?.statutory_settings_id ?? null) !== null}
          error={settings.error}
          onRetry={() => void settings.refetch()}
          isEmpty={
            (run?.statutory_settings_id ?? null) === null ||
            (settings.isSuccess && settings.data === null)
          }
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.stat.rates.empty.title")}
              hint={t("admin.stat.rates.empty.hint")}
            />
          }
          skeletonRows={2}
        >
          {settings.data !== null && settings.data !== undefined ? (
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">
                {t("admin.stat.rates.effective", {
                  from: fmtCivilDate(settings.data.effective_from),
                  to:
                    settings.data.effective_to === null
                      ? t("admin.common.noExpiry")
                      : fmtCivilDate(settings.data.effective_to),
                })}
              </p>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.pfEmployee")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.pf_employee_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.pfEmployer")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.pf_employer_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.pfCeiling")}
                  </dt>
                  <dd>
                    <Money paise={settings.data.pf_wage_ceiling_paise} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.eps")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.eps_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.edli")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.edli_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.pfAdmin")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.pf_admin_charges_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.esiEmployee")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.esi_employee_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.esiEmployer")}
                  </dt>
                  <dd className="num">{formatPercent(settings.data.esi_employer_pct)}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.esiCeiling")}
                  </dt>
                  <dd>
                    <Money paise={settings.data.esi_wage_ceiling_paise} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.lwfEmployee")}
                  </dt>
                  <dd>
                    <Money paise={settings.data.lwf_employee_amount_paise} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.lwfEmployer")}
                  </dt>
                  <dd>
                    <Money paise={settings.data.lwf_employer_amount_paise} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t("admin.stat.rate.otMultiplier")}
                  </dt>
                  <dd className="num">
                    {t("admin.stat.rate.times", {
                      n: formatNumber(settings.data.overtime_multiplier_statutory),
                    })}
                  </dd>
                </div>
              </dl>

              <h3 className="mt-4 text-sm font-semibold">
                {t("admin.stat.pt.title", { state: settings.data.pt_state })}
              </h3>
              {ptSlabs === null ? (
                <p className="mt-1 text-sm text-muted-foreground">{t("admin.stat.pt.unreadable")}</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {ptSlabs.map((slab) => (
                    <li key={`${slab.from}:${slab.to ?? "top"}`} className="num text-sm">
                      <Money paise={slab.from} />
                      {" – "}
                      {slab.to === null ? t("admin.stat.pt.andAbove") : <Money paise={slab.to} />}
                      {" → "}
                      <Money paise={slab.amount} className="font-medium" />
                    </li>
                  ))}
                </ul>
              )}

              {settings.data.notes !== null ? (
                <p className="mt-3 text-sm text-muted-foreground">{settings.data.notes}</p>
              ) : null}
            </div>
          ) : null}
        </StateBoundary>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 font-display text-lg font-semibold">
          {t("admin.stat.register.title")}
        </h2>
        <StateBoundary
          loading={lines.isPending && runId !== ""}
          error={lines.error}
          onRetry={() => void lines.refetch()}
          isEmpty={runId !== "" && rows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.stat.empty.title")}
              hint={head !== null ? t("admin.stat.empty.filtered") : t("admin.stat.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          {runId === "" ? (
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.stat.noRun.title")}
              hint={t("admin.stat.noRun.hint")}
            />
          ) : (
            <>
              <DataGrid
                columns={columns}
                rows={rows}
                rowKey={(row) => row.line_id ?? `${row.payslip_id}:${row.sequence ?? 0}`}
                pageSize={50}
              />
              {rows.length >= LINE_ROW_CAP ? (
                <div className="mt-3">
                  <Notice tone="warning">
                    {t("admin.common.rowCap", { count: formatNumber(LINE_ROW_CAP) })}
                  </Notice>
                </div>
              ) : null}
            </>
          )}
        </StateBoundary>
      </section>

      <div className="mt-6">
        <Notice tone="info">{t("admin.stat.footnote")}</Notice>
      </div>
    </div>
  );
}
