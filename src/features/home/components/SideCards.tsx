/**
 * Regions G, H, I and J — quick actions, upcoming holidays, announcements and the
 * last payslip.
 *
 * Region J is the masked one: net pay is integer paise from `payslips`, rendered
 * through `<MaskedValue kind="money">` so it starts as `₹•,••,•••` — a fixed
 * group shape that never leaks magnitude (DR-22).
 *
 * These are card LISTS at every width, not tables, so they carry no grid chrome
 * on three rows (DR-46) and need no <768px conversion.
 */
import { Link } from "react-router-dom";
import {
  Banknote,
  CalendarDays,
  ClipboardList,
  HeartHandshake,
  Inbox,
  Megaphone,
  PartyPopper,
  Wrench,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { MaskedValue } from "@/shared/ui/MaskedValue";
import { fmtCivilDate, fmtCivilDateWeekday, fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { formatPaise } from "@/lib/money";
import { useCan } from "@/app/auth/AuthProvider";
import { t } from "@/shared/i18n/en";
import type { MessageKey } from "@/shared/i18n/en";
import type { Capability } from "@/shared/auth/capabilities";
import type { PayslipSummary } from "@/features/pay/api/pay.api";
import type { Announcement, Holiday } from "../api/home.api";
import { announcementBadge } from "../display";
import { Fact, HomeCard, RegionBody, RowsSkeleton } from "./HomeCard";

// -----------------------------------------------------------------------------
// Region G — quick actions
// -----------------------------------------------------------------------------

interface QuickAction {
  to: string;
  labelKey: MessageKey;
  icon: ComponentType<{ className?: string }>;
  /** Omit for a tile every signed-in employee may open. */
  cap?: Capability;
}

/**
 * Up to six actions, each a real route from the manifest — never more than eight,
 * and one icon per concept (DR-42). P1.5/P2 destinations are deliberately absent:
 * a tile that lands on "not switched on yet" is not an action.
 *
 * `cap` narrows a tile to a reader who can actually open it, for the same reason:
 * a tile that lands on "you do not have access" is not an action either. Holidays
 * is admin-tier now (see `FOOTER_ITEMS` in nav-model.ts), so an employee must not
 * be offered it here.
 */
const QUICK_ACTIONS: readonly QuickAction[] = [
  { to: "/me/leave/apply", labelKey: "home.quick.applyLeave", icon: CalendarDays },
  { to: "/me/regularizations/new", labelKey: "home.quick.regularize", icon: Wrench },
  { to: "/me/comp-off", labelKey: "home.quick.compOff", icon: HeartHandshake },
  { to: "/me/approvals", labelKey: "home.quick.approvals", icon: Inbox },
  { to: "/me/holidays", labelKey: "home.quick.holidays", icon: PartyPopper, cap: "admin.access" },
  { to: "/me/payslips", labelKey: "home.quick.payslips", icon: ClipboardList },
];

export function QuickActions() {
  const canAdmin = useCan("admin.access");
  // The grid is `grid-cols-2 sm:grid-cols-3`, so dropping one tile reflows to five
  // and needs no layout change.
  const actions = QUICK_ACTIONS.filter((a) => a.cap === undefined || canAdmin);
  return (
    <HomeCard icon={Zap} title={t("home.quick.title")} className="lg:col-span-3">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {actions.map((action) => (
          <li key={action.to}>
            <Button asChild variant="outline" className="h-12 w-full justify-start">
              <Link to={action.to}>
                <action.icon className="h-4 w-4" aria-hidden />
                <span className="truncate">{t(action.labelKey)}</span>
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </HomeCard>
  );
}

// -----------------------------------------------------------------------------
// Region H — upcoming holidays
// -----------------------------------------------------------------------------

export interface HolidaysCardProps {
  query: UseQueryResult<Holiday[], Error>;
  /**
   * `false` = no `holiday_calendar_id` on the employee, which is a different
   * story from "no holidays" and gets its own state. `null` = still resolving,
   * so the skeleton shows instead of a wrong answer (the holidays query stays
   * disabled until the calendar id is known).
   */
  hasCalendar: boolean | null;
}

export function UpcomingHolidaysCard({ query, hasCalendar }: HolidaysCardProps) {
  /*
    THE CARD STAYS FOR EVERYONE; only its "View all" link is admin-tier.

    What was hidden was the holidays TAB — the screen. When the next holidays are
    is ordinary information an employee is entitled to see, and this card renders
    it inline from `home.api`, so removing the card would withhold something
    nobody asked to withhold. The link would land on a refusal, so that goes.
  */
  const canSeeHolidays = useCan("admin.access");
  if (hasCalendar === null) {
    return (
      <HomeCard icon={PartyPopper} title={t("home.holidays.title")}>
        <RowsSkeleton rows={3} />
      </HomeCard>
    );
  }
  if (!hasCalendar) {
    return (
      <HomeCard icon={PartyPopper} title={t("home.holidays.title")}>
        <EmptyState
          icon={PartyPopper}
          title={t("home.holidays.noCalendar.title")}
          hint={t("home.holidays.noCalendar.hint")}
        />
      </HomeCard>
    );
  }
  return (
    <HomeCard
      icon={PartyPopper}
      title={t("home.holidays.title")}
      {...(canSeeHolidays
        ? {
            action: (
              <Button asChild variant="ghost" size="sm">
                <Link to="/me/holidays">{t("home.holidays.viewAll")}</Link>
              </Button>
            ),
          }
        : {})}
    >
      <RegionBody
        query={query}
        skeleton={<RowsSkeleton rows={3} />}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            icon={PartyPopper}
            title={t("home.holidays.empty.title")}
            hint={t("home.holidays.empty.hint")}
          />
        }
      >
        {(rows) => (
          <ul className="divide-y">
            {rows.map((h) => (
              <li key={h.id} className="py-2.5 first:pt-0 last:pb-0">
                <p className="num text-xs text-muted-foreground">
                  {fmtCivilDateWeekday(h.holiday_date)}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="min-w-0">{h.name}</span>
                  {h.is_optional ? (
                    <Badge variant="info">{t("home.holidays.optional")}</Badge>
                  ) : null}
                  {!h.is_paid ? (
                    <Badge variant="neutral">{t("home.holidays.unpaid")}</Badge>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </RegionBody>
    </HomeCard>
  );
}

// -----------------------------------------------------------------------------
// Region I — announcements
// -----------------------------------------------------------------------------

export interface AnnouncementsCardProps {
  query: UseQueryResult<Announcement[], Error>;
}

export function AnnouncementsCard({ query }: AnnouncementsCardProps) {
  return (
    <HomeCard
      icon={Megaphone}
      title={t("home.news.title")}
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/me/notifications">{t("home.news.viewAll")}</Link>
        </Button>
      }
    >
      <RegionBody
        query={query}
        skeleton={<RowsSkeleton rows={2} />}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            icon={Megaphone}
            title={t("home.news.empty.title")}
            hint={t("home.news.empty.hint")}
          />
        }
      >
        {(rows) => (
          <ul className="divide-y">
            {rows.slice(0, 3).map((a) => (
              <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="min-w-0">{a.title}</span>
                  {a.pinned ? <Badge variant="neutral">{t("home.news.pinned")}</Badge> : null}
                  {(() => {
                    const badge = announcementBadge(a.priority);
                    return badge === null ? null : (
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    );
                  })()}
                </div>
                {a.requires_acknowledgement ? (
                  <p className="mt-0.5 text-xs text-warning">{t("home.news.needsAck")}</p>
                ) : null}
                {a.published_at !== null ? (
                  <p className="num mt-0.5 text-xs text-muted-foreground">
                    {fmtDateTime(a.published_at)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </RegionBody>
    </HomeCard>
  );
}

// -----------------------------------------------------------------------------
// Region J — last payslip (net pay masked by default)
// -----------------------------------------------------------------------------

export interface LastPayslipCardProps {
  query: UseQueryResult<PayslipSummary | null, Error>;
}

export function LastPayslipCard({ query }: LastPayslipCardProps) {
  return (
    <HomeCard
      icon={Banknote}
      title={t("home.payslip.title")}
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/me/payslips">{t("home.payslip.viewAll")}</Link>
        </Button>
      }
    >
      <RegionBody
        query={query}
        skeleton={<RowsSkeleton rows={2} />}
        isEmpty={(row) => row === null}
        empty={
          <EmptyState
            icon={Banknote}
            title={t("home.payslip.empty.title")}
            hint={t("home.payslip.empty.hint")}
          />
        }
      >
        {(row) => {
          if (row === null) return null;
          const period = row.pay_period?.name ?? fmtCivilDate(row.period_start);
          return (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="min-w-0">{period}</span>
                {row.is_reversed ? (
                  <Badge variant="danger">{t("home.payslip.reversed")}</Badge>
                ) : null}
              </div>
              <dl className="grid grid-cols-2 gap-4">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t("home.payslip.netPay")}</dt>
                  <dd className="mt-0.5 font-display text-lg font-semibold">
                    <MaskedValue kind="money" value={formatPaise(row.net_pay_paise)} />
                  </dd>
                </div>
                <Fact
                  label={t("home.payslip.paidDays")}
                  value={t("home.unit.days", { count: formatNumber(row.paid_days) })}
                />
              </dl>
              <p className="text-xs text-muted-foreground">{t("home.payslip.maskHint")}</p>
              {row.pay_period !== null ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/me/payslips/${row.pay_period.code}`}>{t("home.payslip.open")}</Link>
                </Button>
              ) : null}
            </div>
          );
        }}
      </RegionBody>
    </HomeCard>
  );
}
