/**
 * E-02 Home — `/me`.
 *
 * Regions in the order spec-employee §5 E-02 lists them, which is also the DOM
 * order, which is also the mobile single-column order: A greeting band, B Today,
 * C Needs your attention, D my-month strip, E leave balances, F comp-off,
 * G quick actions, H upcoming holidays, I announcements, J last payslip.
 *
 * Two structural rules this page exists to honour:
 *  1. Every number is a named column of a server view, fetched by the SAME api
 *     function the corresponding detail screen calls. A tile and its detail
 *     screen therefore cannot disagree (DR-29, the "7 vs 8" defect).
 *  2. Each region owns its query and its own seven states, so one failing card
 *     never blanks the page — that is the partial state, made structural.
 *
 * Region K (team moments) is not built: it needs teammates' `date_of_birth` /
 * `show_birthday`, which employees may only see through the manager-scoped
 * `v_team_employee_basic`.
 *
 * @route /me
 */
import { Home as HomeIcon, Lock, WifiOff } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ErrorState } from "@/shared/ui/ErrorState";
import { fmtDateWeekday, fmtTime, istToday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useLatestPayslip } from "@/features/pay/hooks/usePay";
import {
  useAnnouncements,
  useAttendanceRealtime,
  useAttentionItems,
  useHomeBalances,
  useHomeMonthStrip,
  useMyEmployee,
  useTodayAttendance,
  useTodayShiftContext,
  useUpcomingHolidays,
  useWeeklyOffRule,
} from "../hooks/useHome";
import { SelfPunchCard } from "@/features/attendance/components/SelfPunchCard";
import { FaceEnrolmentAskCard } from "../components/FaceEnrolmentAskCard";
import { useIsOnline, useIstTicker } from "../hooks/useHomeUi";
import { greetingLine } from "../display";
import { GreetingBand } from "../components/GreetingBand";
import { TodayCard } from "../components/TodayCard";
import { AttentionCard } from "../components/AttentionCard";
import { MonthStrip } from "../components/MonthStrip";
import { CompOffCard, LeaveBalancesCard } from "../components/BalancesCards";
import {
  AnnouncementsCard,
  LastPayslipCard,
  QuickActions,
  UpcomingHolidaysCard,
} from "../components/SideCards";

export default function HomePage() {
  // One ticker drives the IST-hour greeting and the running-shift stopwatch.
  const nowMs = useIstTicker();
  const online = useIsOnline();
  const today = istToday();

  // Region B stays live: own-row attendance_days changes invalidate today + strip.
  useAttendanceRealtime();

  const meQuery = useMyEmployee();
  const shiftQuery = useTodayShiftContext();
  const weeklyOffQuery = useWeeklyOffRule();
  const todayQuery = useTodayAttendance();
  const attentionQuery = useAttentionItems();
  const monthQuery = useHomeMonthStrip();
  const balancesQuery = useHomeBalances();
  const holidaysQuery = useUpcomingHolidays(4);
  const announcementsQuery = useAnnouncements(3);
  const payslipQuery = useLatestPayslip();

  const me = meQuery.data ?? null;

  // The partial state, stated rather than implied: each card already shows its
  // own failure, and this line tells the employee the page is incomplete so they
  // do not read a missing card as a zero.
  const partial = [
    todayQuery,
    attentionQuery,
    monthQuery,
    balancesQuery,
    holidaysQuery,
    announcementsQuery,
    payslipQuery,
  ].some((q) => q.isError);

  // A signed-in account with no employee row is kiosk-only staff (E-01): the
  // honest answer is the no-permission state, not a page of empty cards.
  if (!meQuery.isPending && !meQuery.isError && me === null) {
    return (
      <div className="container py-6">
        <PageHeader icon={HomeIcon} title={t("shell.nav.home")} />
        <EmptyState
          icon={Lock}
          title={t("home.state.noEmployee.title")}
          hint={t("home.state.noEmployee.hint")}
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      {!online ? (
        <p
          className="mb-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="status"
        >
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          {t("home.state.offline")}
        </p>
      ) : null}

      {partial && online ? (
        <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" role="status">
          {t("home.state.partial")}
        </p>
      ) : null}

      <PageHeader
        icon={HomeIcon}
        title={greetingLine(me?.first_name ?? null, nowMs)}
        subtitle={t("home.greeting.subtitle", {
          date: fmtDateWeekday(nowMs),
          time: fmtTime(nowMs),
        })}
      />

      {/* Region A. On an identity read failure the band shows the error + retry
          rather than a skeleton that never resolves. */}
      {meQuery.isError ? (
        <div className="mb-5">
          <ErrorState error={meQuery.error} retry={() => void meQuery.refetch()} />
        </div>
      ) : (
        <GreetingBand
          me={me}
          shift={shiftQuery.data?.shift ?? null}
          shiftSource={shiftQuery.data?.source ?? null}
          weeklyOffRule={weeklyOffQuery.data ?? null}
          loading={meQuery.isPending || (me !== null && shiftQuery.isPending)}
        />
      )}

      {/* The punch button, above everything else on the page: it is the one
          thing on /me that is time-critical, and the employee is standing at
          their desk about to start or end a shift. It owns its own queries and
          renders nothing but a sentence when web punch is not enabled for the
          account, so it cannot push the rest of the page down for people who
          cannot use it. */}
      <div className="mb-4">
        {/*
          Above the punch card deliberately: if HR has asked this person to enrol,
          the punch card below will tell them their face is not registered, and this
          is the sentence that explains what to do about it. Reversing the order
          would show the symptom before the cause.
        */}
        <FaceEnrolmentAskCard />
        <SelfPunchCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Region B + C */}
        <TodayCard query={todayQuery} nowMs={nowMs} today={today} />
        <AttentionCard query={attentionQuery} nowMs={nowMs} />

        {/* Region D */}
        <MonthStrip query={monthQuery} />

        {/* Region E + F */}
        <LeaveBalancesCard query={balancesQuery} />
        <CompOffCard query={balancesQuery} />

        {/* Region G */}
        <QuickActions />

        {/* Region H + I + J */}
        <UpcomingHolidaysCard
          query={holidaysQuery}
          hasCalendar={me === null ? null : me.holiday_calendar_id !== null}
        />
        <AnnouncementsCard query={announcementsQuery} />
        <LastPayslipCard query={payslipQuery} />
      </div>
    </div>
  );
}
