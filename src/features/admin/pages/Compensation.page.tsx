/**
 * /admin/payroll/compensation — current pay for every employee, masked by default,
 * with an audited reveal per person.
 *
 * MASKING (D-19, DR-22, DR-52). Salary is masked for every persona INCLUDING
 * admin. The mask is `<Money masked>` → `₹•,••,•••`, a fixed group shape, so it
 * cannot leak magnitude the way `***` vs `*****` did in the reference product.
 *
 * REVEAL IS A LOGGED READ, NOT A CSS TOGGLE. Pressing Reveal opens
 * `<ReasonDialog>` (≥15 characters, D-21) and calls
 * `reveal_employee_salary(p_employee_id, p_reason)`, which writes
 * `data_access_log` with the actor, the fields and the purpose BEFORE it returns a
 * figure. The numbers then displayed are the ones that RPC returned — so what is
 * on screen is exactly what the audit row says was read. Reveals are per row,
 * per session, and are never persisted.
 *
 * `v_salary_revisions.is_current` decides what "current" means (approved, and the
 * effective window covers today) — the same definition the payslip engine uses.
 * `increment_pct` and `months_since_last_revision` are server columns; this screen
 * does not compute an increment or a duration.
 *
 * @route /admin/payroll/compensation
 */
import { useMemo, useState } from "react";
import { Banknote, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Money } from "@/shared/ui/Money";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatPercent } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { RevisionRow } from "../api/payroll.api";
import type { RevealedSalaryLine } from "../api/payroll-detail.api";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  PAYROLL_ROW_CAP,
  useCurrentCompensation,
  useRevealSalary,
  type RevealInput,
} from "../hooks/useAdminPayroll";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

/** What one successful reveal produced, kept for this session only. */
interface Revealed {
  readonly monthlyGrossPaise: number;
  readonly monthlyEmployerContributionPaise: number;
  readonly monthlyCtcPaise: number;
  readonly annualCtcPaise: number;
}

export default function AdminCompensationPage() {
  const { employee } = useAuth();
  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const compensation = useCurrentCompensation();

  const [employeeFilter, setEmployeeFilter] = useState("");
  const [revealed, setRevealed] = useState<ReadonlyMap<string, Revealed>>(new Map());
  const [revealMiss, setRevealMiss] = useState<string | null>(null);

  const prompt = useReasonPrompt<RevealInput>();
  const { ask, close: closePrompt, target, isOpen } = prompt;

  const reveal = useRevealSalary((lines: RevealedSalaryLine[], input: RevealInput) => {
    // Match on revision_id: the RPC returns every revision, and picking "the
    // biggest number" would be a guess. If the current revision is not in the
    // payload, nothing is unmasked and the dialog says so.
    const match = lines.find((line) => line.revision_id === input.revisionId);
    if (match === undefined) {
      setRevealMiss(t("admin.comp.noMatch", { name: input.employeeName }));
      closePrompt();
      return;
    }
    setRevealMiss(null);
    setRevealed((prev) => {
      const next = new Map(prev);
      next.set(input.revisionId, {
        monthlyGrossPaise: match.monthly_gross_paise,
        monthlyEmployerContributionPaise: match.monthly_employer_contribution_paise,
        monthlyCtcPaise: match.monthly_ctc_paise,
        annualCtcPaise: match.annual_ctc_paise,
      });
      return next;
    });
    closePrompt();
  });

  const rows = useMemo(() => {
    const all = compensation.data ?? [];
    if (employeeFilter === "") return all;
    return all.filter((row) => row.employee_id === employeeFilter);
  }, [compensation.data, employeeFilter]);

  const capped = (compensation.data ?? []).length >= PAYROLL_ROW_CAP;
  const revealedCount = revealed.size;

  const columns: DataGridColumn<RevisionRow>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.comp.col.employee"),
        width: "16rem",
        sortable: true,
        sortValue: (row) => labels.data?.get(row.employee_id)?.name ?? "",
        render: (row) => {
          const label = labels.data?.get(row.employee_id);
          return (
            <PersonCell
              name={label?.name ?? null}
              code={label?.code ?? null}
              secondary={label?.designation ?? null}
            />
          );
        },
      },
      {
        key: "department",
        header: t("admin.comp.col.department"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => dash(labels.data?.get(row.employee_id)?.department ?? null),
      },
      {
        key: "effective_from",
        header: t("admin.comp.col.effectiveFrom"),
        width: "10rem",
        sortable: true,
        render: (row) => fmtCivilDate(row.effective_from),
      },
      {
        key: "monthly_gross_paise",
        header: t("admin.comp.col.gross"),
        width: "11rem",
        align: "right",
        render: (row) => {
          const shown = revealed.get(row.revision_id);
          return shown === undefined ? (
            <Money paise={row.monthly_gross_paise} masked />
          ) : (
            <Money paise={shown.monthlyGrossPaise} />
          );
        },
      },
      {
        key: "monthly_employer_contribution_paise",
        header: t("admin.comp.col.employer"),
        width: "11rem",
        align: "right",
        hideBelow: "lg",
        render: (row) => {
          const shown = revealed.get(row.revision_id);
          return shown === undefined ? (
            <Money paise={row.monthly_employer_contribution_paise} masked />
          ) : (
            <Money paise={shown.monthlyEmployerContributionPaise} />
          );
        },
      },
      {
        key: "monthly_ctc_paise",
        header: t("admin.comp.col.monthlyCtc"),
        width: "11rem",
        align: "right",
        render: (row) => {
          const shown = revealed.get(row.revision_id);
          return shown === undefined ? (
            <Money paise={row.monthly_ctc_paise} masked />
          ) : (
            <Money paise={shown.monthlyCtcPaise} className="font-semibold" />
          );
        },
      },
      {
        key: "annual_ctc_paise",
        header: t("admin.comp.col.annualCtc"),
        width: "12rem",
        align: "right",
        hideBelow: "md",
        render: (row) => {
          const shown = revealed.get(row.revision_id);
          return shown === undefined ? (
            <Money paise={row.annual_ctc_paise} masked />
          ) : (
            <Money paise={shown.annualCtcPaise} />
          );
        },
      },
      {
        key: "increment_pct",
        header: t("admin.comp.col.increment"),
        width: "10rem",
        align: "right",
        hideBelow: "lg",
        // A growth rate, not a share: it is printed as the server computed it and
        // is deliberately NOT clamped to [0,100].
        render: (row) => dash(row.increment_pct, (pct) => formatPercent(pct)),
      },
      {
        key: "months_since_last_revision",
        header: t("admin.comp.col.monthsSince"),
        width: "11rem",
        align: "right",
        hideBelow: "lg",
        render: (row) =>
          dash(row.months_since_last_revision, (months) =>
            t("admin.comp.months", { count: months }),
          ),
      },
      {
        key: "reveal",
        header: t("admin.comp.col.reveal"),
        width: "9rem",
        align: "right",
        render: (row) => {
          const shown = revealed.get(row.revision_id);
          if (shown !== undefined) {
            return (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setRevealed((prev) => {
                    const next = new Map(prev);
                    next.delete(row.revision_id);
                    return next;
                  })
                }
              >
                <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t("common.hide")}
              </Button>
            );
          }
          const label = labels.data?.get(row.employee_id);
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={reveal.isPending}
              onClick={() => {
                reveal.reset();
                ask({
                  employeeId: row.employee_id,
                  employeeName: label?.name ?? t("admin.common.unknownPerson"),
                  revisionId: row.revision_id,
                });
              }}
            >
              {t("common.reveal")}
            </Button>
          );
        },
      },
    ],
    [labels.data, revealed, reveal, ask],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Banknote}
        title={t("admin.comp.title")}
        subtitle={t("admin.comp.subtitle")}
      />

      <Notice tone="info" className="mb-4">
        {t("admin.comp.maskNotice")}
      </Notice>

      {revealMiss !== null ? (
        <Notice
          tone="error"
          className="mb-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setRevealMiss(null)}>
              {t("admin.common.dismiss")}
            </Button>
          }
        >
          {revealMiss}
        </Notice>
      ) : null}

      {revealedCount > 0 ? (
        <Notice
          tone="warning"
          className="mb-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setRevealed(new Map())}>
              {t("admin.comp.hideAll")}
            </Button>
          }
        >
          {t("admin.comp.revealedCount", { count: revealedCount })}
        </Notice>
      ) : null}

      {capped ? (
        <Notice tone="warning" className="mb-4">
          {t("admin.common.rowCap", { count: PAYROLL_ROW_CAP })}
        </Notice>
      ) : null}

      <StateBoundary
        loading={compensation.isLoading}
        error={compensation.error ?? undefined}
        onRetry={() => void compensation.refetch()}
        partialError={labels.error ?? undefined}
        partialLabel={t("admin.common.partial.names")}
        skeletonRows={6}
      >
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.revision_id}
          pageSize={25}
          toolbar={
            <div className="grid w-full gap-3 sm:max-w-sm">
              <SelectField
                label={t("admin.common.filter.employee")}
                value={employeeFilter}
                options={employeeChoices}
                placeholder={t("admin.common.filter.allEmployees")}
                onChange={setEmployeeFilter}
                disabled={labels.isLoading}
              />
            </div>
          }
          emptyState={
            <EmptyState
              icon={Banknote}
              title={t("admin.comp.empty.title")}
              hint={t("admin.comp.empty.hint")}
            />
          }
        />
      </StateBoundary>

      <ReasonDialog
        open={isOpen}
        title={t("admin.comp.dialog.title", { name: target?.employeeName ?? "" })}
        description={t("admin.comp.dialog.description")}
        actorName={employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.comp.dialog.confirm")}
        pending={reveal.isPending}
        errorMessage={reveal.userMessage}
        onConfirm={(reason) => {
          if (target !== null) reveal.save(target, reason);
        }}
        onCancel={() => {
          reveal.reset();
          closePrompt();
        }}
      />
    </div>
  );
}
