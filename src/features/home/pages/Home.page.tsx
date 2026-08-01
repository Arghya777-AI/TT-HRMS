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
import { EqualHeightRow } from "../components/EqualHeightRow";
import { AttentionCard } from "../components/AttentionCard";
import { MyMonthCalendar } from "../components/MyMonthCalendar";
import { InstallAppCard } from "@/shared/pwa/InstallAppCard";
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
      {/*
        THE INSTALL OFFER, ON THE SCREEN EVERY EMPLOYEE LANDS ON. `md:hidden` because it is only
        about phones. It was originally only inside the "More" menu, which assumes somebody goes
        looking for it — and the staff this is for will not. It removes itself once installed.
      */}
      <div className="mb-4 md:hidden">
        <InstallAppCard autoOpenGuideOnIos />
      </div>

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

      {/*
        Above the punch card deliberately: if HR has asked this person to enrol, the
        punch card will tell them their face is not registered, and this is the sentence
        that explains what to do about it. Reversing the order would show the symptom
        before the cause. It stays FULL WIDTH — it is a paragraph of prose, and prose in
        a one-third column is a column of two-word lines.
      */}
      <FaceEnrolmentAskCard />

      {/*
        ── ONE ROW, THREE COLUMNS ────────────────────────────────────────────────
        The punch card used to sit full-width above this grid, so a confirmed punch
        pushed Today and Needs-your-attention most of a screen down: on a laptop you
        punched in and then had to scroll to see whether the day had been recorded.
        Now the three things an employee opens this page for share the first row.

        THE PUNCH CARD IS STILL FIRST IN SOURCE ORDER, so it is the first thing a screen
        reader reaches and the top card on a phone. Being time-critical did not require
        being full-width; it required being first.

        THE BREAKPOINTS. One column below 640, two from 640, three from 1024. The middle
        step is the one that was missing — the old grid went straight from one column to
        three at `lg`, so every tablet and every half-width laptop window rendered a
        single tall stack, which is the shape being complained about.

        `items-start` matters: without it CSS grid stretches every card in a row to the
        tallest one, so an expanded punch confirmation would pad Today and Attention with
        empty space and give back the vertical room it just saved.
      */}
      {/*
        ALL THREE THE HEIGHT OF THE SHORTEST. Equalising to the tallest is what CSS grid
        does for free and it is the wrong direction here — the notification list has no
        natural end, so matching it would hand back all the vertical space this row was
        created to save. `EqualHeightRow` measures instead and caps to the shortest, with
        the overflow scrolling inside each card under a sticky header, and one Expand
        control for when somebody wants the whole list at once.
      */}
      <EqualHeightRow className="sm:grid-cols-2 lg:grid-cols-3">
        <SelfPunchCard />
        {/* Region B + C */}
        <TodayCard query={todayQuery} nowMs={nowMs} today={today} />
        <AttentionCard query={attentionQuery} nowMs={nowMs} />
      </EqualHeightRow>

      {/*
        The calendar sits directly under today's shift and the punch card, which is
        where it was asked for and where it belongs: those two answer "what am I doing
        now", and this answers "what has the month looked like". It is full width rather
        than a third of a row, because a seven-column grid squeezed into one column of
        three is unreadable on a laptop and impossible on a phone.
      */}
      <div className="mt-4">
        <MyMonthCalendar />
      </div>

      <div className="mt-4 grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">

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
