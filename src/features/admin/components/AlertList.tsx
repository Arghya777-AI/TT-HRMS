/**
 * AlertList — the compact alert feed on the Command Centre.
 *
 * The full grid lives on `/admin/alerts`; this is the morning summary: severity
 * first, newest next, each row a sentence the VIEW wrote (`description`) plus a
 * link to the screen that can fix it. Nothing here re-describes an exception in
 * its own words, so the feed and the owning screen cannot tell two stories about
 * the same problem.
 *
 * Person names come from the shared `useEmployeeLabels` map — the same map the
 * rest of the console uses — so an id resolves to one name everywhere, and an
 * out-of-scope id says so instead of printing a uuid.
 */
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { ExceptionRow } from "../api/command.api";
import { alertKindLabel, alertRoute, SEVERITY_CHIP } from "../command-vocab";
import { alertRowKey } from "../api/command.api";
import type { EmployeeLabelMap } from "../hooks/useEmployeeLabels";
import { PersonCell } from "./PersonCell";

export interface AlertListProps {
  rows: readonly ExceptionRow[];
  /** Shared id → name/code map; `undefined` while it is still loading. */
  labels: EmployeeLabelMap | undefined;
}

export function AlertList({ rows, labels }: AlertListProps) {
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {rows.map((row) => {
        const label = row.employee_id === null ? null : labels?.get(row.employee_id) ?? null;
        const unresolvedPerson = row.employee_id !== null && labels !== undefined && label === null;
        return (
          <li key={alertRowKey(row)} className="p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusChip status={row.severity} map={SEVERITY_CHIP} />
                <span className="text-sm font-medium">{alertKindLabel(row.exception_kind)}</span>
              </div>
              <Link
                to={alertRoute(row, label?.code ?? null)}
                className="inline-flex shrink-0 items-center gap-1 rounded text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("admin.alert.open")}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <p className="mt-1.5 text-sm text-foreground">{row.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {row.employee_id === null ? null : label !== null ? (
                <PersonCell name={label.name} code={label.code} />
              ) : unresolvedPerson ? (
                <span>{t("admin.person.outOfScope")}</span>
              ) : null}
              {row.ist_date !== null ? <span>{fmtCivilDate(row.ist_date)}</span> : null}
              <span>{t("admin.alert.raisedAt", { when: fmtDateTime(row.occurred_at) })}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
