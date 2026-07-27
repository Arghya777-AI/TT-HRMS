/**
 * SalarySection — E-08 Cards A–E, the whole salary-structure model.
 *
 * Rendered by `/me/profile/salary` (E-07 Tab 7 is the same read-only view) and
 * linked to from `/me/payslips`, so there is ONE implementation of these five
 * cards and the two routes cannot drift apart.
 *
 * Every figure is a column of `v_employee_current_salary` or
 * `v_salary_revisions`: gross, employer contribution, CTC, the A/B/C buckets,
 * `increment_amount_paise`, `increment_pct`, `months_since_previous` and
 * `months_since_last_revision`. Nothing on this screen is subtracted, divided or
 * averaged in the browser — including "duration since last revision", which the
 * reference product computed client-side and got 10 months where the revision
 * table said 21 (spec-screens S-10).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { Money } from "@/shared/ui/Money";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtCivilMonth, istMonthOfDate } from "@/lib/datetime";
import { dash, formatPercent } from "@/lib/format";
import { useCurrentSalary, useCurrentSalaryRevision, useSalaryRevisions } from "../hooks/usePay";
import { revisionKindLabel } from "../display";
import { CtcTimelineChart } from "./CtcTimelineChart";
import { SalaryStructureTable } from "./SalaryStructureTable";
import type { SalaryRevision } from "../api/pay.api";
import type { AmountReveal } from "../reveal";
import type { QueryError } from "@/shared/api/query";

export interface SalarySectionProps {
  reveal: AmountReveal;
  /** From `useIdentityGate()` — no employee row means no-permission, not empty. */
  identityError: QueryError | undefined;
  identityResolving: boolean;
}

function Card({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  /** `| undefined` spelled out: the tree runs exactOptionalPropertyTypes. */
  subtitle?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={className}>
      <div className="mb-3">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** '+10.0%' / '−4.0%' — a growth rate, so it is NOT clamped to [0,100]. */
function signedPct(pct: number | null): string {
  if (pct === null) return t("common.empty");
  const rendered = formatPercent(pct);
  return pct > 0 ? `+${rendered}` : rendered;
}

export function SalarySection({ reveal, identityError, identityResolving }: SalarySectionProps) {
  const masked = !reveal.revealed;
  const structure = useCurrentSalary();
  const revisions = useSalaryRevisions();
  const current = useCurrentSalaryRevision();

  const structureRows = structure.data ?? [];
  const structureHeader = structureRows[0];
  const revisionRows = revisions.data ?? [];

  // ---------------------------------------------------------------------------
  // Card D — revision details
  // ---------------------------------------------------------------------------
  const revisionColumns: DataGridColumn<SalaryRevision>[] = [
    {
      key: "effective_from",
      header: t("pay.salary.col.effectiveFrom"),
      render: (row) => fmtCivilDate(row.effective_from),
    },
    {
      key: "revision_kind",
      header: t("pay.salary.col.kind"),
      render: (row) => revisionKindLabel(row.revision_kind),
      hideBelow: "md",
    },
    {
      key: "status",
      header: t("pay.salary.col.status"),
      render: (row) => <StatusChip status={row.status} />,
    },
    {
      key: "monthly_ctc_paise",
      header: t("pay.salary.col.newCtc"),
      align: "right",
      render: (row) => <Money paise={row.monthly_ctc_paise} masked={masked} />,
    },
    {
      key: "previous_monthly_ctc_paise",
      header: t("pay.salary.col.previousCtc"),
      align: "right",
      hideBelow: "lg",
      render: (row) => <Money paise={row.previous_monthly_ctc_paise} masked={masked} />,
    },
    {
      key: "increment_amount_paise",
      header: t("pay.salary.col.increment"),
      align: "right",
      hideBelow: "md",
      render: (row) => <Money paise={row.increment_amount_paise} masked={masked} />,
    },
    {
      key: "increment_pct",
      header: t("pay.salary.col.incrementPct"),
      align: "right",
      render: (row) => signedPct(row.increment_pct),
    },
    {
      key: "months_since_previous",
      header: t("pay.salary.col.monthsBetween"),
      align: "right",
      hideBelow: "lg",
      render: (row) => dash(row.months_since_previous, (v) => t("pay.salary.months", { count: v })),
    },
  ];

  // ---------------------------------------------------------------------------
  // Card E — structure history (the effective windows of each revision)
  // ---------------------------------------------------------------------------
  const historyColumns: DataGridColumn<SalaryRevision>[] = [
    {
      key: "effective_from",
      header: t("pay.salary.col.effectiveFrom"),
      render: (row) => fmtCivilDate(row.effective_from),
    },
    {
      key: "effective_to",
      header: t("pay.salary.col.effectiveTo"),
      // NULL is open-ended: 'Current', never a year-3000 sentinel (§8).
      render: (row) =>
        row.effective_to === null ? t("pay.salary.current") : fmtCivilDate(row.effective_to),
    },
    {
      key: "revision_number",
      header: t("pay.salary.col.version"),
      hideBelow: "lg",
      render: (row) =>
        t("pay.salary.versionLabel", {
          number: row.revision_number,
          kind: revisionKindLabel(row.revision_kind),
        }),
    },
    {
      key: "monthly_gross_paise",
      header: t("pay.salary.total.gross"),
      align: "right",
      render: (row) => <Money paise={row.monthly_gross_paise} masked={masked} />,
    },
    {
      key: "monthly_employer_contribution_paise",
      header: t("pay.salary.total.employer"),
      align: "right",
      hideBelow: "md",
      render: (row) => <Money paise={row.monthly_employer_contribution_paise} masked={masked} />,
    },
    {
      key: "monthly_ctc_paise",
      header: t("pay.salary.total.ctc"),
      align: "right",
      render: (row) => <Money paise={row.monthly_ctc_paise} masked={masked} />,
    },
  ];

  const rev = current.data;

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------------- A */}
      <Card
        title={t("pay.salary.cardA.heading")}
        subtitle={
          structureHeader === undefined
            ? undefined
            : t("pay.salary.cardA.effective", {
                date: fmtCivilDate(structureHeader.effective_from),
                structure: structureHeader.salary_structure_code ?? t("pay.salary.noStructureCode"),
              })
        }
      >
        <div className="rounded-lg border bg-card">
          <StateBoundary
            loading={identityResolving || structure.isPending}
            error={identityError ?? structure.error}
            onRetry={() => void structure.refetch()}
            isEmpty={structureRows.length === 0}
            skeletonRows={4}
            empty={
              <div className="p-4">
                <EmptyState
                  title={t("pay.salary.empty.title")}
                  hint={t("pay.salary.empty.hint")}
                  action={
                    <Link
                      to="/me/helpdesk"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t("pay.salary.empty.action")}
                    </Link>
                  }
                />
              </div>
            }
          >
            <SalaryStructureTable rows={structureRows} masked={masked} />
          </StateBoundary>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* -------------------------------------------------------------- B */}
        <Card title={t("pay.salary.cardB.heading")} className="lg:col-span-2">
          <StateBoundary
            loading={identityResolving || current.isPending}
            error={identityError ?? current.error}
            onRetry={() => void current.refetch()}
            isEmpty={rev === null || rev === undefined}
            skeletonRows={3}
            empty={
              <EmptyState
                title={t("pay.salary.cardB.empty.title")}
                hint={t("pay.salary.cardB.empty.hint")}
              />
            }
          >
            {rev !== null && rev !== undefined ? (
              <div className="space-y-3">
                <KpiTile
                  label={t("pay.salary.cardB.months")}
                  value={
                    rev.months_since_last_revision === null
                      ? t("common.empty")
                      : t("pay.salary.months", { count: rev.months_since_last_revision })
                  }
                  hint={t("pay.salary.cardB.months.hint", {
                    date: fmtCivilDate(rev.effective_from),
                  })}
                  explainer={{
                    formula: t("pay.salary.cardB.months.formula"),
                    numbers: t("pay.salary.cardB.months.numbers", {
                      date: fmtCivilDate(rev.effective_from),
                      months:
                        rev.months_since_last_revision === null
                          ? t("common.empty")
                          : String(rev.months_since_last_revision),
                    }),
                  }}
                />
                <KpiTile
                  label={t("pay.salary.cardB.period")}
                  value={fmtCivilMonth(istMonthOfDate(rev.effective_from))}
                  hint={revisionKindLabel(rev.revision_kind)}
                />
                {/* No revision percentage on a first/initial revision: the spec
                    says omit the row rather than print a misleading '0%'. */}
                {rev.increment_pct !== null ? (
                  <KpiTile
                    label={t("pay.salary.cardB.pct")}
                    value={signedPct(rev.increment_pct)}
                    tone={rev.increment_pct > 0 ? "success" : "neutral"}
                    {...(rev.months_since_previous === null
                      ? {}
                      : { hint: t("pay.salary.cardB.pct.hint", { months: rev.months_since_previous }) })}
                    explainer={{
                      formula: t("pay.salary.cardB.pct.formula"),
                      numbers: t("pay.salary.cardB.pct.numbers", {
                        pct: signedPct(rev.increment_pct),
                        months:
                          rev.months_since_previous === null
                            ? t("common.empty")
                            : String(rev.months_since_previous),
                      }),
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </StateBoundary>
        </Card>

        {/* -------------------------------------------------------------- C */}
        <Card
          title={t("pay.salary.cardC.heading")}
          subtitle={t("pay.salary.cardC.subtitle")}
          className="lg:col-span-3"
        >
          <div className="rounded-lg border bg-card p-4">
            <StateBoundary
              loading={identityResolving || revisions.isPending}
              error={identityError ?? revisions.error}
              onRetry={() => void revisions.refetch()}
              skeletonRows={3}
            >
              <CtcTimelineChart revisions={revisionRows} revealed={reveal.revealed} />
            </StateBoundary>
          </div>
        </Card>
      </div>

      {/* ---------------------------------------------------------------- D */}
      <Card title={t("pay.salary.cardD.heading")} subtitle={t("pay.salary.cardD.subtitle")}>
        <StateBoundary
          loading={identityResolving}
          error={identityError ?? revisions.error}
          onRetry={() => void revisions.refetch()}
          skeletonRows={3}
        >
          <DataGrid
            columns={revisionColumns}
            rows={revisionRows}
            rowKey={(row) => row.revision_id}
            loading={revisions.isPending}
            emptyState={
              <EmptyState
                title={t("pay.salary.cardD.empty.title")}
                hint={t("pay.salary.cardD.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </Card>

      {/* ---------------------------------------------------------------- E */}
      <Card title={t("pay.salary.cardE.heading")} subtitle={t("pay.salary.cardE.subtitle")}>
        <StateBoundary
          loading={identityResolving}
          error={identityError ?? revisions.error}
          onRetry={() => void revisions.refetch()}
          skeletonRows={3}
        >
          <DataGrid
            columns={historyColumns}
            rows={revisionRows}
            rowKey={(row) => `history-${row.revision_id}`}
            loading={revisions.isPending}
            emptyState={
              <EmptyState
                title={t("pay.salary.cardE.empty.title")}
                hint={t("pay.salary.cardE.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </Card>
    </div>
  );
}
