/**
 * CommandKpiStrip — the twelve tiles of spec-admin §2.1.
 *
 * Every tile: a server COUNT (or a server STATUS), a plain-English hint, an `(i)`
 * explainer naming the list it counted, and a route. Twelve numbers, twelve
 * destinations, no client arithmetic anywhere in the file.
 *
 * Two tiles are deliberately NOT what the spec's shorthand asks for, and say so
 * on screen rather than quietly counting something else:
 *
 *  * "Comp-off expiring" counts PEOPLE with credits lapsing inside 30 days, not a
 *    total number of days. Adding days across employees would be client
 *    arithmetic on comp-off (banned); `v_comp_off_balance` only exposes the sum
 *    per employee.
 *  * "Enrolment gaps" is a count, not a coverage percentage.
 *    `v_enrolment_coverage` returns only the gap rows, so a percentage would need
 *    a client-side division against headcount.
 *
 * "Absent today" is the attendance engine's own verdict and nothing else. A day
 * still in progress is `pending` and is counted by no tile — that is the fix for
 * the reference product's 10 phantom absents in a live month (DR-30). The honest
 * live figure, "the shift started and nobody arrived", is `overdue` on the ops
 * band next door.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StatusChip } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { COMP_OFF_EXPIRING_WINDOW_DAYS, DOCUMENT_EXPIRY_WINDOW_DAYS } from "../api/command.api";
import { PAYROLL_RUN_CHIP } from "../display";
import { ADMIN_ROUTES, dangerWhenAny, unavailableHint, warnWhenAny } from "../command-vocab";
import {
  useActiveKioskCount,
  useAlertCount,
  useBoardSlice,
  useCompOffExpiringCount,
  useEnrolmentGapCount,
  useExpiringDocumentCount,
  useHeadcount,
  useKioskOfflineCount,
  useLatestPayrollRun,
  useMyTaskCount,
  usePunchReviewCount,
} from "../hooks/useCommandCentre";
import { CountTile } from "./CountTile";

/** Tile 10 — the newest run's own status, through the label map (never an enum). */
function PayrollTile() {
  const payroll = useLatestPayrollRun();

  if (payroll.isPending) {
    return (
      <KpiTile
        label={t("admin.cc.kpi.payroll")}
        value={<Skeleton className="h-7 w-20" />}
        hint={t("admin.cc.tile.loading")}
        to={ADMIN_ROUTES.payrollRuns}
        drillLabel={t("admin.cc.kpi.payroll.drill")}
      />
    );
  }
  if (payroll.error !== null) {
    return (
      <KpiTile
        label={t("admin.cc.kpi.payroll")}
        value={t("common.empty")}
        hint={unavailableHint(payroll.error)}
        to={ADMIN_ROUTES.payrollRuns}
        drillLabel={t("admin.cc.kpi.payroll.drill")}
      />
    );
  }

  const run = payroll.data ?? null;
  return (
    <KpiTile
      label={t("admin.cc.kpi.payroll")}
      value={
        run === null ? t("common.empty") : <StatusChip status={run.status} map={PAYROLL_RUN_CHIP} />
      }
      hint={
        run === null
          ? t("admin.cc.kpi.payroll.none")
          : t("admin.cc.kpi.payroll.hint", { run: run.run_number })
      }
      to={ADMIN_ROUTES.payrollRuns}
      drillLabel={t("admin.cc.kpi.payroll.drill")}
      explainer={{
        formula: t("admin.cc.explainer.payroll"),
        numbers:
          run === null
            ? t("admin.cc.kpi.payroll.none")
            : t("admin.cc.explainer.payrollNumbers", { run: run.run_number }),
      }}
    />
  );
}

/**
 * Tile 11 — how many gates the SERVER considers silent. The 15-minute rule and
 * the "is it silent" decision both live in `v_exception_queue`; nothing here
 * compares a timestamp, and the hint never subtracts one count from another.
 */
function KioskTile() {
  const offlineQuery = useKioskOfflineCount();
  const activeQuery = useActiveKioskCount();

  if (offlineQuery.isPending || activeQuery.isPending) {
    return (
      <KpiTile
        label={t("admin.cc.kpi.kiosk")}
        value={<Skeleton className="h-7 w-12" />}
        hint={t("admin.cc.tile.loading")}
        to={ADMIN_ROUTES.kioskDevices}
        drillLabel={t("admin.cc.kpi.kiosk.drill")}
      />
    );
  }

  const failure = offlineQuery.error ?? activeQuery.error;
  if (failure !== null) {
    return (
      <KpiTile
        label={t("admin.cc.kpi.kiosk")}
        value={t("common.empty")}
        hint={unavailableHint(failure)}
        to={ADMIN_ROUTES.kioskDevices}
        drillLabel={t("admin.cc.kpi.kiosk.drill")}
      />
    );
  }

  const offline = offlineQuery.data ?? 0;
  const total = activeQuery.data ?? 0;
  const hint =
    total === 0
      ? t("admin.cc.kpi.kiosk.none")
      : offline === 0
        ? t("admin.cc.kpi.kiosk.allOnline", { total })
        : t("admin.cc.kpi.kiosk.offline", { count: offline, total });

  return (
    <KpiTile
      label={t("admin.cc.kpi.kiosk")}
      value={total === 0 ? t("common.empty") : String(offline)}
      hint={hint}
      tone={total === 0 ? "neutral" : dangerWhenAny(offline)}
      to={ADMIN_ROUTES.kioskDevices}
      drillLabel={t("admin.cc.kpi.kiosk.drill")}
      explainer={{ formula: t("admin.cc.explainer.kiosk"), numbers: hint }}
    />
  );
}

export interface CommandKpiStripProps {
  /** The IST business date every "today" tile is scoped to. */
  istDate: string;
}

export function CommandKpiStrip({ istDate }: CommandKpiStripProps) {
  const headcount = useHeadcount();
  const present = useBoardSlice("present", istDate);
  const onLeave = useBoardSlice("on_leave", istDate);
  const workFromHome = useBoardSlice("work_from_home", istDate);
  const late = useBoardSlice("late", istDate);
  const absent = useBoardSlice("absent", istDate);
  const exceptions = useAlertCount({});
  const myTasks = useMyTaskCount();
  const punches = usePunchReviewCount();
  const documents = useExpiringDocumentCount();
  const compOff = useCompOffExpiringCount();
  const enrolment = useEnrolmentGapCount();

  return (
    <section aria-label={t("admin.cc.kpi.section")}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <CountTile
          label={t("admin.cc.kpi.headcount")}
          hint={t("admin.cc.kpi.headcount.hint")}
          to={ADMIN_ROUTES.peopleActive}
          drillLabel={t("admin.cc.kpi.headcount.drill")}
          source={t("admin.cc.source.directory")}
          query={headcount}
        />
        <CountTile
          label={t("admin.cc.kpi.present")}
          hint={t("admin.cc.kpi.present.hint")}
          to={ADMIN_ROUTES.liveIn}
          drillLabel={t("admin.cc.kpi.present.drill")}
          source={t("admin.cc.source.board")}
          query={present}
        />
        {/*
          ON LEAVE, next to present, because they are the pair an administrator reads
          together. It is NOT the `off` chip in the ops band: that one is `off_today`,
          which folds weekly offs, holidays and comp-off in with leave, so at a venue
          with a rota it reads far higher than "who is on leave" every day of the week.
        */}
        <CountTile
          label={t("admin.cc.kpi.onLeave")}
          hint={t("admin.cc.kpi.onLeave.hint")}
          to={ADMIN_ROUTES.daysOnLeave(istDate)}
          drillLabel={t("admin.cc.kpi.onLeave.drill")}
          source={t("admin.cc.source.board")}
          query={onLeave}
        />
        <CountTile
          label={t("admin.cc.kpi.wfh")}
          hint={t("admin.cc.kpi.wfh.hint")}
          to={ADMIN_ROUTES.daysWorkFromHome(istDate)}
          drillLabel={t("admin.cc.kpi.wfh.drill")}
          source={t("admin.cc.source.board")}
          query={workFromHome}
        />
        <CountTile
          label={t("admin.cc.kpi.late")}
          hint={t("admin.cc.kpi.late.hint")}
          to={ADMIN_ROUTES.daysLate(istDate)}
          drillLabel={t("admin.cc.kpi.late.drill")}
          source={t("admin.cc.source.board")}
          query={late}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.absent")}
          hint={t("admin.cc.kpi.absent.hint")}
          to={ADMIN_ROUTES.daysAbsent(istDate)}
          drillLabel={t("admin.cc.kpi.absent.drill")}
          source={t("admin.cc.source.board")}
          query={absent}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.exceptions")}
          hint={t("admin.cc.kpi.exceptions.hint")}
          to={ADMIN_ROUTES.alerts}
          drillLabel={t("admin.cc.kpi.exceptions.drill")}
          source={t("admin.cc.source.exceptions")}
          query={exceptions}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.approvals")}
          hint={t("admin.cc.kpi.approvals.hint")}
          to={ADMIN_ROUTES.tasks}
          drillLabel={t("admin.cc.kpi.approvals.drill")}
          source={t("admin.cc.source.approvals")}
          query={myTasks}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.punches")}
          hint={t("admin.cc.kpi.punches.hint")}
          to={ADMIN_ROUTES.punchesToReview}
          drillLabel={t("admin.cc.kpi.punches.drill")}
          source={t("admin.cc.source.punches")}
          query={punches}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.documents")}
          hint={t("admin.cc.kpi.documents.hint", { days: DOCUMENT_EXPIRY_WINDOW_DAYS })}
          to={ADMIN_ROUTES.documentExpiry}
          drillLabel={t("admin.cc.kpi.documents.drill")}
          source={t("admin.cc.source.documents")}
          query={documents}
          toneFor={warnWhenAny}
        />
        <CountTile
          label={t("admin.cc.kpi.compOff")}
          hint={t("admin.cc.kpi.compOff.hint", { days: COMP_OFF_EXPIRING_WINDOW_DAYS })}
          to={ADMIN_ROUTES.compOff}
          drillLabel={t("admin.cc.kpi.compOff.drill")}
          source={t("admin.cc.source.compOff")}
          query={compOff}
          toneFor={warnWhenAny}
        />
        <PayrollTile />
        <KioskTile />
        <CountTile
          label={t("admin.cc.kpi.enrolment")}
          hint={t("admin.cc.kpi.enrolment.hint")}
          to={ADMIN_ROUTES.kioskEnrolment}
          drillLabel={t("admin.cc.kpi.enrolment.drill")}
          source={t("admin.cc.source.enrolment")}
          query={enrolment}
          toneFor={warnWhenAny}
        />
      </div>
    </section>
  );
}
