/**
 * NetPayTrend — what actually reached the bank, month by month.
 *
 * The one real trend on the payslip list and it had no picture. The table gives
 * twelve rows of figures; the question people arrive with is "why was March
 * lower", and that is a shape question — a dip is visible in a bar chart and
 * invisible in a column of numbers you have to read pairwise.
 *
 * ── EVERY BAR IS ONE SERVER FIGURE ─────────────────────────────────────────
 *
 * `payslips.net_pay_paise`, one payslip per bar. Nothing is summed, averaged or
 * annualised here. The reference line is `ytd_net_paise / months`, and it is the
 * ONE derived number on the chart — labelled as an average so it cannot be
 * mistaken for a figure payroll stamped, and computed from two columns that are
 * both on the same row rather than from the bars themselves. If a month's payslip
 * is missing from the list, the average does not move.
 *
 * ── IT RESPECTS THE REVEAL ─────────────────────────────────────────────────
 *
 * This page masks every rupee until the session reveal is opened. The bars keep
 * their SHAPE while masked — a proportion is not an amount — but every tooltip
 * and legend figure prints the mask, so nothing leaks through a chart the page is
 * still hiding. Shape without figures is the same trade the payslip viewer's
 * split bars make.
 */
import { TrendBars, type TrendBar } from "@/shared/ui/charts/TrendBars";
import { MASKED_INR_SHAPE, formatPaise } from "@/lib/money";
import { fmtCivilMonth } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { PayslipSummary } from "../api/pay.api";

export interface NetPayTrendProps {
  /** Newest first, as the list fetches them. */
  readonly rows: readonly PayslipSummary[];
  /** The period key the row list already computes — kept as one definition. */
  readonly periodKey: (row: PayslipSummary) => string;
  readonly masked: boolean;
}

export function NetPayTrend({ rows, periodKey, masked }: NetPayTrendProps) {
  /*
    Two payslips is the fewest that can show a direction. One bar on its own is a
    number with decoration, and the table above already renders that better.
  */
  if (rows.length < 2) return null;

  const money = (paise: number): string => (masked ? MASKED_INR_SHAPE : formatPaise(paise));

  /*
    Oldest first for the chart. `rows` is newest-first because that is the right
    order for a list; time runs the other way on an axis, and a reversed axis is
    the kind of thing nobody notices and everybody misreads.
  */
  const chronological = [...rows].reverse();

  const bars: readonly TrendBar[] = chronological.map((row) => ({
    key: row.id,
    label: fmtCivilMonth(periodKey(row)).slice(0, 3),
    value: row.net_pay_paise,
    /*
      A reversed payslip is a correction, not a month's pay — coloured as a
      deduction so it cannot be read as earnings, and captioned so the colour is
      never the only explanation.
    */
    tone: row.is_reversed ? "deduction" : "earning",
    caption: row.is_reversed
      ? t("pay.trend.reversed")
      : t("pay.trend.paidOn", { date: row.paid_on ?? "—" }),
  }));

  /*
    The average, from the newest row's own cumulative total divided by the months
    that contributed to it. Taken from `ytd_net_paise` rather than from the bars
    so a filtered or partial list cannot shift the line — the figure the server
    stamped is the figure the line uses.
  */
  const latest = rows[0];
  const months = chronological.length;
  const reference =
    latest?.ytd_net_paise != null && months > 0
      ? {
          value: latest.ytd_net_paise / months,
          label: t("pay.trend.average"),
        }
      : undefined;

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{t("pay.trend.title")}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{t("pay.trend.hint")}</p>
      <div className="mt-3">
        <TrendBars
          bars={bars}
          title={t("pay.trend.title")}
          format={money}
          height={140}
          showAxis={!masked}
          {...(reference !== undefined ? { reference } : {})}
        />
      </div>
    </section>
  );
}
