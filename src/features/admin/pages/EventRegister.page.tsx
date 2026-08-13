/**
 * §3 · /admin/org/events — Event Register. The venue diary.
 *
 * ── THE ROUTE EXISTED; THE SCREEN DID NOT ────────────────────────────────────
 *
 * `/admin/org/events` has been in `route-manifest.ts` since the manifest was
 * written, described as "Booked events that drive staffing requirements". No page
 * claimed the route, so it rendered a stub — while `events.api.ts` and
 * `useEventRegister.ts` sat on disk, complete and imported by nothing, their
 * headers correctly stating that `public.events` did not exist.
 *
 * It exists now (migration 043100), along with `event_labour_demand`,
 * `v_event_coverage`, and `fk_roster_slots__event` — the foreign key the 004900
 * deferred sweep had been silently skipping for ninety migrations because it was
 * registered against a table nobody had built.
 *
 * ── WHY A BOOKING IS WORTH RECORDING ─────────────────────────────────────────
 *
 * At this venue an event is not decoration on a calendar. Two things already in
 * the database are waiting on it:
 *
 *  1. `holidays.working_if_event_booked` — nineteen KA-2026 dates where the
 *     operational departments work IF something is booked, at a 2.0 pay
 *     multiplier with a compensatory off. Seeded, and unusable until now, because
 *     nothing could book.
 *  2. `roster_slots.event_id` — a column on every slot row, NULL on all of them,
 *     with no FK behind it.
 *
 * ── WHAT THIS SCREEN WILL NOT DO ─────────────────────────────────────────────
 *
 * It does not enter labour demand. `event_labour_demand` takes a required
 * headcount per department per event, and deciding that needs shift patterns and
 * a service model this product does not hold — so the coverage table below reads
 * whatever has been recorded and shows a shortfall against it, and shows nothing
 * where nothing has been stated. A department with no requirement is zero
 * required, never "covered": inventing a requirement in order to look complete is
 * how a coverage screen starts lying.
 *
 * It does not attach slots to events either. That belongs on the roster planner,
 * beside the week it applies to.
 *
 * @route /admin/org/events
 */
import { useMemo, useState } from "react";
import { CalendarDays, PartyPopper, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Required } from "@/shared/ui/Required";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import {
  SubmitAttemptScope,
  SubmitBlockers,
  blockerButtonProps,
  useSubmitAttempt,
} from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { mutationUserMessage } from "@/shared/api/query";
import { dash, formatNumber } from "@/lib/format";
import { CoverageBar } from "@/shared/ui/charts/CoverageBar";
import { SplitBar } from "@/shared/ui/charts/SplitBar";
import { TrendBars, type TrendBar } from "@/shared/ui/charts/TrendBars";
import {
  addIstDays,
  fmtCivilDate,
  fmtDateTime,
  istDate,
  istWallClockToInstant,
  nowIstDate,
} from "@/lib/datetime";
import { istWeekStart } from "@/features/team/api/roster.api";
import { t } from "@/shared/i18n/en";
import type { MessageKey } from "@/shared/i18n/en";
import {
  eventStatusValues,
  eventTypeValues,
  type EventCoverageRow,
  type EventFilters,
  type EventRow,
} from "../api/events.api";
import {
  useCreateEvent,
  useEventCount,
  useEventCoverage,
  useEvents,
} from "../hooks/useEventRegister";
import { useCompanies } from "../hooks/useMasters";

const BLOCKER_ID = "event-blockers";

/*
  The same meanings the status chips carry, so a green segment never sits beside
  an amber badge for one fact: confirmed is settled work, an enquiry is not yet,
  a completed booking is history, a cancellation is money that went away.
*/
const STATUS_TONE = {
  confirmed: "present",
  enquiry: "late",
  completed: "neutral",
  cancelled: "absent",
} as const;

/** `ck_events__status`, in the words a venue manager uses. */
const EVENT_STATUS_MAP: Record<string, StatusChipEntry> = {
  enquiry: { label: t("events.status.enquiry"), tone: "warn" },
  confirmed: { label: t("events.status.confirmed"), tone: "success" },
  completed: { label: t("events.status.completed"), tone: "neutral" },
  cancelled: { label: t("events.status.cancelled"), tone: "danger" },
};

export default function EventRegisterPage() {
  const [showPast, setShowPast] = useState(false);
  const [includeCancelled, setIncludeCancelled] = useState(false);

  /*
    One filter object, shared by the list, the count and the coverage read. Three
    queries over three slightly different predicates is how a tile ends up
    disagreeing with the grid beneath it.
  */
  const filters: EventFilters = useMemo(
    () => ({
      ...(showPast ? {} : { from: `${nowIstDate()}T00:00:00+05:30` }),
      includeCancelled,
    }),
    [showPast, includeCancelled],
  );

  const events = useEvents(filters);
  const total = useEventCount(filters);
  const coverage = useEventCoverage(filters);
  const companies = useCompanies();
  const create = useCreateEvent();
  const attempt = useSubmitAttempt();

  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [client, setClient] = useState("");
  const [eventType, setEventType] = useState<string>("wedding");
  const [status, setStatus] = useState<string>("enquiry");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("18:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("23:00");
  const [callTime, setCallTime] = useState("");
  const [guests, setGuests] = useState("");
  const [notes, setNotes] = useState("");

  const companyId = companies.data?.[0]?.id ?? null;

  /*
    Instants, built from IST wall clock — never `new Date(\`${d}T${t}\`)`, which
    would read the browser's own zone and book a Bengaluru wedding in whatever
    timezone the laptop happens to be in.
  */
  const startsAt =
    startDate === "" || startTime === "" ? null : istWallClockToInstant(startDate, startTime);
  const endsAt = endDate === "" || endTime === "" ? null : istWallClockToInstant(endDate, endTime);
  const callAt =
    startDate === "" || callTime === "" ? null : istWallClockToInstant(startDate, callTime);
  const guestCount = guests.trim() === "" ? null : Number(guests);

  /* Each of these is a CHECK on `events`, restated so the refusal arrives before
     the round trip rather than as a constraint name afterwards. */
  const blockers: string[] = [];
  if (companyId === null) blockers.push(t("events.new.blocked.company"));
  if (code.trim() === "") blockers.push(t("events.new.blocked.code"));
  if (title.trim() === "") blockers.push(t("events.new.blocked.name"));
  if (startsAt === null || endsAt === null) blockers.push(t("events.new.blocked.dates"));
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    blockers.push(t("events.new.blocked.span"));
  }
  if (callAt !== null && startsAt !== null && callAt > startsAt) {
    blockers.push(t("events.new.blocked.call"));
  }
  if (guestCount !== null && (!Number.isFinite(guestCount) || guestCount < 0)) {
    blockers.push(t("events.new.blocked.guests"));
  }

  /*
    ── WHY THESE TWO CHARTS ARE CONDITIONAL ──────────────────────────────────
    They are drawn from the LOADED ROWS, not from a server aggregate, because
    Postgres has not been asked for a per-status or per-week count here. That is
    honest only while the register is complete: the list is capped at 200, and a
    distribution drawn over the first 200 of 340 bookings is a picture of the cap,
    not of the season. So the charts appear when the server's own count agrees
    with what arrived, and a line says why when they do not.
  */
  const loaded = events.data ?? [];
  const complete = total.data !== undefined && total.data === loaded.length;

  const statusSegments = complete
    ? (["confirmed", "enquiry", "completed", "cancelled"] as const)
        .map((key) => ({
          key,
          label: t(`events.status.${key}` as MessageKey),
          value: loaded.filter((e) => e.status === key).length,
          /* The same meaning the chips carry: confirmed is settled work,
             an enquiry is not yet, a cancellation is money that went away. */
          tone: STATUS_TONE[key],
        }))
        .filter((seg) => seg.value > 0)
    : [];

  /* Eight weeks from this week's Monday — the horizon a venue actually staffs
     against. Weeks with no booking are a real zero here, not an absent record:
     the register was read in full, and nothing was found. */
  const weekBars: readonly TrendBar[] = complete
    ? Array.from({ length: 8 }, (_, i) => {
        const monday = addIstDays(istWeekStart(nowIstDate()), i * 7);
        const sunday = addIstDays(monday, 6);
        const n = loaded.filter((e) => {
          const d = istDate(e.starts_at);
          return d >= monday && d <= sunday;
        }).length;
        return {
          key: monday,
          label: fmtCivilDate(monday).slice(0, 6),
          value: n,
          tone: n === 0 ? ("neutral" as const) : ("employer" as const),
          caption: t("events.ahead.week", { week: fmtCivilDate(monday) }),
        };
      })
    : [];

  const columns: DataGridColumn<EventRow>[] = [
    {
      key: "event_code",
      header: t("events.col.code"),
      width: "11rem",
      render: (row) => <span className="font-mono text-xs">{row.event_code}</span>,
    },
    {
      key: "title",
      header: t("events.col.title"),
      render: (row) => (
        <div>
          <p className="font-medium leading-snug">{row.title}</p>
          <p className="text-xs text-muted-foreground">
            {t(`events.type.${row.event_type}` as MessageKey)}
          </p>
        </div>
      ),
    },
    {
      key: "client_name",
      header: t("events.col.client"),
      hideBelow: "lg",
      render: (row) => dash(row.client_name),
    },
    {
      key: "call_time_at",
      header: t("events.col.call"),
      width: "13rem",
      hideBelow: "lg",
      /* The figure the roster is actually built against, so it earns a column of
         its own rather than living inside a tooltip on the start time. */
      render: (row) => (row.call_time_at === null ? dash(null) : fmtDateTime(row.call_time_at)),
    },
    {
      key: "starts_at",
      header: t("events.col.starts"),
      width: "13rem",
      sortable: true,
      render: (row) => fmtDateTime(row.starts_at),
    },
    {
      key: "ends_at",
      header: t("events.col.ends"),
      width: "13rem",
      hideBelow: "lg",
      render: (row) => fmtDateTime(row.ends_at),
    },
    {
      key: "guest_count_expected",
      header: t("events.col.guests"),
      align: "right",
      width: "9rem",
      hideBelow: "md",
      /* Actual once the night is over, expected before it. Never a zero for
         "unknown" — a zero reads as "nobody came". */
      render: (row) =>
        row.guest_count_actual !== null
          ? t("events.guests.actual", { n: formatNumber(row.guest_count_actual) })
          : row.guest_count_expected !== null
            ? t("events.guests.expected", { n: formatNumber(row.guest_count_expected) })
            : t("events.guests.none"),
    },
    {
      key: "status",
      header: t("events.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={EVENT_STATUS_MAP} />,
    },
  ];

  const coverageColumns: DataGridColumn<EventCoverageRow>[] = [
    {
      key: "title",
      header: t("events.coverage.col.event"),
      render: (row) => (
        <div>
          <p className="font-medium leading-snug">{row.title}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.event_code}</p>
        </div>
      ),
    },
    {
      key: "department_name",
      header: t("events.coverage.col.dept"),
      render: (row) => row.department_name ?? t("events.coverage.noDept"),
    },
    {
      key: "required_headcount",
      header: t("events.coverage.col.required"),
      align: "right",
      width: "8rem",
      render: (row) => formatNumber(row.required_headcount),
    },
    {
      key: "rostered_headcount",
      header: t("events.coverage.col.rostered"),
      align: "right",
      width: "8rem",
      render: (row) => formatNumber(row.rostered_headcount),
    },
    {
      key: "short_by",
      header: t("events.coverage.col.short"),
      width: "13rem",
      /*
        The bar carries the pair; `short_by` stays beside it as the exact figure.
        A manager acts on "two more people", not on a rectangle — the bar is what
        makes a table of twenty rows scannable, and the number is what gets acted
        on. Neither is computed here: `short_by` is the view's own
        GREATEST(required − rostered, 0).
      */
      render: (row) => (
        <CoverageBar
          value={row.rostered_headcount}
          target={row.required_headcount === 0 ? null : row.required_headcount}
          title={`${row.title} · ${row.department_name ?? t("events.coverage.noDept")}`}
          showLabel
          format={(v) => formatNumber(v)}
        />
      ),
    },
  ];

  /* Rows where nobody has stated a requirement carry no information — the view
     emits one per event even with no demand rows, and listing those as "0 of 0"
     would bury the events that genuinely are short. */
  const coverageRows = (coverage.data ?? []).filter(
    (r) => r.required_headcount > 0 || r.rostered_headcount > 0,
  );

  return (
    <SubmitAttemptScope attempt={attempt}>
      <div>
        <PageHeader
          icon={PartyPopper}
          title={t("events.title")}
          subtitle={t("events.subtitle")}
        />

        <div className="space-y-6">
          {/* ── Filters ──────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={showPast}
                onChange={(e) => setShowPast(e.target.checked)}
              />
              {t("events.filter.window.past")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={includeCancelled}
                onChange={(e) => setIncludeCancelled(e.target.checked)}
              />
              {t("events.filter.status.cancelled")}
            </label>
            {total.data === undefined ? null : (
              <span className="num ml-auto text-xs text-muted-foreground">
                {formatNumber(total.data)}
              </span>
            )}
          </div>

          {/* ── The shape of the season ──────────────────────────────────── */}
          {complete && loaded.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-lg border bg-card p-4">
                <h2 className="font-display text-sm font-semibold">
                  {t("events.chart.mix.title")}
                </h2>
                <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
                  {t("events.chart.mix.hint")}
                </p>
                <SplitBar
                  title={t("events.chart.mix.title")}
                  segments={statusSegments}
                  showShare
                  height={12}
                  format={(v) => formatNumber(v)}
                  totalCaption={t("events.chart.mix.total", {
                    n: formatNumber(loaded.length),
                  })}
                />
              </section>

              <section className="rounded-lg border bg-card p-4">
                <h2 className="font-display text-sm font-semibold">
                  {t("events.chart.ahead.title")}
                </h2>
                <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
                  {t("events.chart.ahead.hint")}
                </p>
                <TrendBars
                  title={t("events.chart.ahead.title")}
                  bars={weekBars}
                  height={120}
                  showAxis
                  format={(v) => formatNumber(v)}
                />
              </section>
            </div>
          ) : null}

          {/* ── The register ─────────────────────────────────────────────── */}
          <section aria-labelledby="events-list">
            <h2 id="events-list" className="font-display text-lg font-semibold">
              {t("events.list.title")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("events.list.hint")}</p>
            <StateBoundary
              loading={events.isLoading}
              error={events.error ?? undefined}
              onRetry={() => void events.refetch()}
              isEmpty={events.data !== undefined && events.data.length === 0}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={t("events.list.empty.title")}
                  hint={t("events.list.empty.hint")}
                />
              }
              skeletonRows={4}
            >
              <DataGrid rows={events.data ?? []} columns={columns} rowKey={(r) => r.id} />
            </StateBoundary>
          </section>

          {/* ── Coverage ─────────────────────────────────────────────────── */}
          <section aria-labelledby="events-coverage">
            <h2 id="events-coverage" className="font-display text-lg font-semibold">
              {t("events.coverage.title")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("events.coverage.hint")}</p>
            <StateBoundary
              loading={coverage.isLoading}
              error={coverage.error ?? undefined}
              onRetry={() => void coverage.refetch()}
              isEmpty={coverage.data !== undefined && coverageRows.length === 0}
              empty={
                <EmptyState
                  icon={CalendarDays}
                  title={t("events.coverage.empty.title")}
                  hint={t("events.coverage.empty.hint")}
                />
              }
              skeletonRows={3}
            >
              <DataGrid
                rows={coverageRows}
                columns={coverageColumns}
                rowKey={(r) => `${r.event_id}:${r.department_id ?? "none"}`}
              />
            </StateBoundary>
          </section>

          {/* ── Book one ─────────────────────────────────────────────────── */}
          <section className="rounded-lg border bg-card p-4" aria-labelledby="events-new">
            <h2 id="events-new" className="font-display text-lg font-semibold">
              {t("events.new.title")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("events.new.hint")}</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <Label htmlFor="ev-code">
                  {t("events.new.code")}
                  <Required />
                </Label>
                <Input
                  required
                  id="ev-code"
                  className="mt-1.5 h-11"
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t("events.new.code.hint")}</p>
              </div>

              <div>
                <Label htmlFor="ev-title">
                  {t("events.new.name")}
                  <Required />
                </Label>
                <Input
                  required
                  id="ev-title"
                  className="mt-1.5 h-11"
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="ev-client">{t("events.new.client")}</Label>
                <Input
                  id="ev-client"
                  className="mt-1.5 h-11"
                  maxLength={200}
                  value={client}
                  onChange={(e) => setClient(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="ev-type">{t("events.new.type")}</Label>
                <select
                  id="ev-type"
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {eventTypeValues.map((v) => (
                    <option key={v} value={v}>
                      {t(`events.type.${v}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="ev-status">{t("events.new.status")}</Label>
                <select
                  id="ev-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {eventStatusValues.map((v) => (
                    <option key={v} value={v}>
                      {t(`events.status.${v}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="ev-guests">{t("events.new.guests")}</Label>
                <Input
                  id="ev-guests"
                  type="number"
                  min={0}
                  step={1}
                  className="mt-1.5 h-11"
                  value={guests}
                  onChange={(e) => setGuests(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t("events.new.guests.hint")}</p>
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <Label htmlFor="ev-sd">
                    {t("events.new.startDate")}
                    <Required />
                  </Label>
                  <Input
                    required
                    id="ev-sd"
                    type="date"
                    className="mt-1.5 h-11"
                    value={startDate}
                    onChange={(e) => {
                      setStartDate(e.target.value);
                      /* Most events end the day they start. Prefilling the end
                         date means the common case is one field, and a wedding
                         running past midnight is still one edit away. */
                      if (endDate === "") setEndDate(e.target.value);
                    }}
                  />
                </div>
                <div className="w-28">
                  <Label htmlFor="ev-st">{t("events.new.startTime")}</Label>
                  <Input
                    id="ev-st"
                    type="time"
                    className="mt-1.5 h-11"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <Label htmlFor="ev-ed">
                    {t("events.new.endDate")}
                    <Required />
                  </Label>
                  <Input
                    required
                    id="ev-ed"
                    type="date"
                    min={startDate === "" ? undefined : startDate}
                    className="mt-1.5 h-11"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <div className="w-28">
                  <Label htmlFor="ev-et">{t("events.new.endTime")}</Label>
                  <Input
                    id="ev-et"
                    type="time"
                    className="mt-1.5 h-11"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="ev-call">{t("events.new.callTime")}</Label>
                <Input
                  id="ev-call"
                  type="time"
                  className="mt-1.5 h-11"
                  value={callTime}
                  onChange={(e) => setCallTime(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("events.new.callTime.hint")}
                </p>
              </div>
            </div>

            <div className="mt-3">
              <Label htmlFor="ev-notes">{t("events.new.notes")}</Label>
              <textarea
                id="ev-notes"
                rows={2}
                maxLength={2000}
                className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {create.isError ? (
              <div className="mt-3">
                <Notice tone="error">{mutationUserMessage(create.error)}</Notice>
              </div>
            ) : null}

            <SubmitBlockers
              attempt={attempt}
              blockers={blockers}
              id={BLOCKER_ID}
              title={t("events.new.blocked.title")}
            />

            <Button
              className="mt-4 w-full"
              disabled={create.isPending}
              {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}
              onClick={() => {
                if (!attempt.press(blockers)) return;
                if (companyId === null || startsAt === null || endsAt === null) return;
                create.mutate(
                  {
                    companyId,
                    eventCode: code,
                    title,
                    clientName: client.trim() === "" ? null : client,
                    eventType,
                    locationId: null,
                    guestCountExpected: guestCount,
                    callTimeAt: callAt,
                    startsAt,
                    endsAt,
                    status,
                    notes: notes.trim() === "" ? null : notes,
                  },
                  {
                    onSuccess: () => {
                      attempt.reset();
                      setCode("");
                      setTitle("");
                      setClient("");
                      setStartDate("");
                      setEndDate("");
                      setCallTime("");
                      setGuests("");
                      setNotes("");
                      confirmSubmitted(t("events.new.done"), {
                        detail: t("events.new.doneDetail"),
                      });
                    },
                  },
                );
              }}
            >
              <Plus className="mr-2 size-4" aria-hidden />
              {create.isPending ? t("events.new.submitting") : t("events.new.submit")}
            </Button>
          </section>
        </div>
      </div>
    </SubmitAttemptScope>
  );
}
