/**
 * EmployeeLinksPanel — every screen that is ABOUT this one person, from their record.
 *
 * WHY. Nine admin screens can be scoped to a single employee — their attendance, their
 * scans, their leave ledger, their balances, their compensation, their field history, the
 * policy resolver, face enrolment — and the employee record linked to none of them. An
 * administrator looking at Asha and wanting to know why she was marked late had to leave
 * the record, find Attendance, find the date, filter to her, and then come back to change
 * anything. That is the "go from anywhere to anywhere" this fixes.
 *
 * IT LINKS, IT DOES NOT REBUILD. Each destination already exists and already accepts the
 * scope in its URL — `?emp=` on the punch log and balances, `?employee=` on the resolver
 * and the enrolment console, `:code` on the four per-employee routes. Re-implementing any
 * of them here would be a second copy of a screen that has RLS, audit reads and a state
 * machine behind it, and the copy would drift. The deep-link params are the contract.
 *
 * WHAT IS DELIBERATELY NOT HERE. Editing. This panel is navigation only, because the edits
 * belong on the screens that own them: a leave adjustment writes a ledger entry with a
 * reason, a grace change is an attendance-policy assignment with an effective date, a shift
 * change is a dated assignment that a roster slot can outrank. Offering a bare "grace
 * period" box on the employee record would write none of that history, and history is the
 * only reason those numbers can be trusted later.
 */
import { Link } from "react-router-dom";
import {
  Banknote,
  CalendarClock,
  CalendarDays,
  Clock,
  FileText,
  ScanFace,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import type { ComponentType } from "react";
import { t } from "@/shared/i18n/en";
import type { MessageKey } from "@/shared/i18n/en";

export interface EmployeeLinksPanelProps {
  /** `employees.employee_code` — the four `:code` routes key on this. */
  readonly employeeCode: string;
  /** `employees.id` — every `?emp=`/`?employee=` filter keys on this. */
  readonly employeeId: string;
  readonly displayName: string;
}

interface LinkSpec {
  readonly to: string;
  readonly labelKey: MessageKey;
  readonly hintKey: MessageKey;
  readonly icon: ComponentType<{ className?: string }>;
}

/*
  ONLY DESTINATIONS THAT ACTUALLY HONOUR THE SCOPE.

  Checked one by one, because a link that silently ignores its filter is worse than no
  link — it drops an administrator on 78 rows while implying one. `LeaveAdjustments`
  read no params at all until this change; `DocumentRepository` reads only `status` and
  `AttendanceExceptions` only kind/severity/date, so neither is linked from here yet.
  Both are listed in the commit as known gaps rather than papered over.
*/
function linksFor(code: string, id: string): readonly LinkSpec[] {
  const c = encodeURIComponent(code);
  const e = encodeURIComponent(id);
  return [
    // ── Attendance ────────────────────────────────────────────────────────────
    {
      to: `/admin/people/${c}/attendance`,
      labelKey: "admin.p360.links.attendance",
      hintKey: "admin.p360.links.attendanceHint",
      icon: Clock,
    },
    {
      to: `/admin/attendance/punches?emp=${e}`,
      labelKey: "admin.p360.links.scans",
      hintKey: "admin.p360.links.scansHint",
      icon: ScanFace,
    },
    {
      // Also where a per-employee SHIFT and its grace period are set.
      to: `/admin/time/resolver?employee=${e}`,
      labelKey: "admin.p360.links.resolver",
      hintKey: "admin.p360.links.resolverHint",
      icon: CalendarClock,
    },
    // ── Leave ─────────────────────────────────────────────────────────────────
    {
      to: `/admin/leave/balances?emp=${e}`,
      labelKey: "admin.p360.links.balances",
      hintKey: "admin.p360.links.balancesHint",
      icon: CalendarDays,
    },
    {
      to: `/admin/leave/adjustments?emp=${e}`,
      labelKey: "admin.p360.links.adjust",
      hintKey: "admin.p360.links.adjustHint",
      icon: SlidersHorizontal,
    },
    {
      to: `/admin/leave/ledger/${c}`,
      labelKey: "admin.p360.links.ledger",
      hintKey: "admin.p360.links.ledgerHint",
      icon: ScrollText,
    },
    // ── Money ─────────────────────────────────────────────────────────────────
    {
      to: `/admin/people/${c}/compensation`,
      labelKey: "admin.p360.links.compensation",
      hintKey: "admin.p360.links.compensationHint",
      icon: Banknote,
    },
    {
      to: `/admin/people/transfers?employee=${e}`,
      labelKey: "admin.p360.links.transfers",
      hintKey: "admin.p360.links.transfersHint",
      icon: TrendingUp,
    },
    // ── Identity & record ─────────────────────────────────────────────────────
    {
      to: `/admin/kiosk/enrolment?employee=${c}`,
      labelKey: "admin.p360.links.face",
      hintKey: "admin.p360.links.faceHint",
      icon: FileText,
    },
    {
      to: `/admin/people/${c}/audit`,
      labelKey: "admin.p360.links.history",
      hintKey: "admin.p360.links.historyHint",
      icon: ShieldCheck,
    },
  ];
}

export function EmployeeLinksPanel({
  employeeCode,
  employeeId,
  displayName,
}: EmployeeLinksPanelProps) {
  const links = linksFor(employeeCode, employeeId);

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="font-display text-sm font-semibold">
        {t("admin.p360.links.title", { name: displayName })}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("admin.p360.links.subtitle")}</p>

      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {links.map((link) => {
          const Icon = link.icon;
          return (
            <li key={link.to}>
              <Link
                to={link.to}
                className="flex h-full items-start gap-2.5 rounded-lg border bg-background/60 p-3 transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(link.labelKey)}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t(link.hintKey)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
