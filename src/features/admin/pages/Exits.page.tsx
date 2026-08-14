/**
 * §2 · /admin/people/exits — Exits & Clearance: who is on notice, who has left,
 * and what is still outstanding on each of them.
 *
 * RECON FIRST, and it decides what this screen may claim:
 *
 *  1. THE STAGE IS A PROJECTION, NOT A FORM FIELD. `employees.employment_status`,
 *     `resignation_date`, `last_working_day` and `exit_type` are written by
 *     `trg_ele__status_projection` (migration 011 §1) when a `notice_started` /
 *     `resigned` / `terminated` / `absconded` / `retired` / `contract_ended`
 *     event is INSERTed into `employee_lifecycle_events`. So this register reads
 *     the projection and never offers to set the stage directly: the way to move
 *     someone to `exited` is to record the event, and no deployed RPC does that
 *     from the browser. The screen says so instead of shipping a dead control.
 *  2. WHAT AN ADMIN MAY ACTUALLY SETTLE IS THE THREE SETTLEMENT FLAGS.
 *     `full_and_final_settled_on`, `exit_interview_done` and `is_rehire_eligible`
 *     are inside the granted UPDATE column set (migration 051 §2,
 *     `EDITABLE_EXIT_COLUMNS`), and `employees` is in
 *     `audit.reason_required_tables` — so each of the three actions here is one
 *     audited `updateEmployee` carrying a typed reason and an optimistic lock on
 *     `updated_at`. Nothing is computed: the date written is today in IST.
 *  3. THERE IS NO CLEARANCE-CHECKLIST TABLE. `clearance` occurs twice in the
 *     migrations, both times as the `EXIT_CLEARANCE` document TYPE; no view
 *     aggregates exit dues, no table holds clearance line items. The recoverable
 *     half of a clearance IS deployed — `v_asset_custody`, the open allocations
 *     with the server's own `days_in_custody` and `is_return_overdue` — so the
 *     panel shows that and names the gap for the rest.
 *  4. EVERY FIGURE IS A SERVER COUNT over the same predicate its tile drills
 *     into (`count=exact`), built from the same `LifecycleFilters` object as the
 *     register read. Counting loaded rows would tie a tile to the 200-row cap.
 *
 * @route /admin/people/exits
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Boxes, ClipboardCheck, DoorOpen, Package, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import {
  addIstDays,
  fmtCivilDate,
  fmtDateTime,
  istMonthRange,
  nowIstDate,
  nowIstMonth,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { Notice } from "../components/Notice";
import { CoverageBar } from "@/shared/ui/charts/CoverageBar";
import {
  CLEARANCE_REASON_MIN_LENGTH,
  clearanceStatusValues,
  needsReason,
  type ClearanceStatus,
} from "../api/clearance.api";
import {
  useClearanceProgress,
  useEmployeeClearance,
  useOpenClearance,
  useSetClearanceStatus,
} from "../hooks/useClearance";
import { PersonCell } from "../components/PersonCell";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import { useRefOptions } from "../hooks/useMasters";
import {
  useExitCustody,
  useLifecycleCount,
  useLifecycleEmployeeUpdate,
  useLifecycleRegister,
} from "../hooks/usePeopleLifecycle";
import {
  EXIT_TYPE_LABELS,
  LIFECYCLE_LIST_LIMIT,
  exitTypeValues,
  isExitType,
  type LifecycleEmployee,
  type LifecycleFilters,
} from "../api/lifecycle.api";
import { EMPLOYMENT_STATUS_LABELS, type EmploymentStatus } from "../api/employees.api";
import type { CustodyRow } from "../api/assets.api";

/** The stages an exit register is about. Danger tones where an admin must look. */
const STAGE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
};

const EXIT_TYPE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  resignation: { label: EXIT_TYPE_LABELS.resignation, tone: "info" },
  termination: { label: EXIT_TYPE_LABELS.termination, tone: "danger" },
  end_of_contract: { label: EXIT_TYPE_LABELS.end_of_contract, tone: "neutral" },
  retirement: { label: EXIT_TYPE_LABELS.retirement, tone: "neutral" },
  absconding: { label: EXIT_TYPE_LABELS.absconding, tone: "danger" },
  death: { label: EXIT_TYPE_LABELS.death, tone: "neutral" },
};

const CUSTODY_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  allocated: { label: t("admin.exits.custody.allocated"), tone: "info" },
  acknowledged: { label: t("admin.exits.custody.acknowledged"), tone: "info" },
  return_requested: { label: t("admin.exits.custody.returnRequested"), tone: "warn" },
};

/** Which slice of the leaving population the register shows. */
type Slice = "on_notice" | "exited" | "all";

const SLICE_STATUSES: Readonly<Record<Slice, readonly EmploymentStatus[]>> = {
  on_notice: ["on_notice"],
  exited: ["exited"],
  all: ["on_notice", "exited", "retired", "absconding"],
};

const SLICE_OPTIONS: readonly { value: Slice; label: string }[] = [
  { value: "on_notice", label: t("admin.exits.slice.onNotice") },
  { value: "exited", label: t("admin.exits.slice.exited") },
  { value: "all", label: t("admin.exits.slice.all") },
];

/** The `last_working_day` window, as bounds Postgres filters on. */
type LwdWindow = "" | "next30" | "thisMonth" | "last90";

const WINDOW_OPTIONS: readonly { value: LwdWindow; label: string }[] = [
  { value: "", label: t("admin.exits.window.any") },
  { value: "next30", label: t("admin.exits.window.next30") },
  { value: "thisMonth", label: t("admin.exits.window.thisMonth") },
  { value: "last90", label: t("admin.exits.window.last90") },
];

/** Whether the flag is outstanding, unset, or done — a tri-state, never a guess. */
type FlagFilter = "" | "pending" | "done";

const SETTLEMENT_OPTIONS: readonly { value: FlagFilter; label: string }[] = [
  { value: "", label: t("admin.exits.settlement.any") },
  { value: "pending", label: t("admin.exits.settlement.pending") },
  { value: "done", label: t("admin.exits.settlement.done") },
];

const INTERVIEW_OPTIONS: readonly { value: FlagFilter; label: string }[] = [
  { value: "", label: t("admin.exits.interview.any") },
  { value: "pending", label: t("admin.exits.interview.pending") },
  { value: "done", label: t("admin.exits.interview.done") },
];

function isSlice(v: string | null): v is Slice {
  return v === "on_notice" || v === "exited" || v === "all";
}

function isWindow(v: string | null): v is LwdWindow {
  return v === "next30" || v === "thisMonth" || v === "last90";
}

function isFlagFilter(v: string | null): v is FlagFilter {
  return v === "pending" || v === "done";
}

function windowFilters(lwdWindow: LwdWindow, today: string): LifecycleFilters {
  switch (lwdWindow) {
    case "":
      return {};
    case "next30":
      return { lastWorkingDayFrom: today, lastWorkingDayTo: addIstDays(today, 30) };
    case "thisMonth": {
      const range = istMonthRange(nowIstMonth());
      return { lastWorkingDayFrom: range.from, lastWorkingDayTo: range.to };
    }
    case "last90":
      return { lastWorkingDayFrom: addIstDays(today, -90), lastWorkingDayTo: today };
  }
}

/** `pending` → the flag is outstanding; `done` → it is recorded. */
function flag(value: FlagFilter): boolean | undefined {
  if (value === "pending") return true;
  if (value === "done") return false;
  return undefined;
}

export default function ExitsPage() {
  const [params, setParams] = useSearchParams();
  const today = nowIstDate();

  const sliceParam = params.get("slice");
  const slice: Slice = isSlice(sliceParam) ? sliceParam : "on_notice";
  const windowParam = params.get("window");
  const lwdWindow: LwdWindow = isWindow(windowParam) ? windowParam : "";
  const typeParam = params.get("type");
  const exitType = isExitType(typeParam) ? typeParam : "";
  const settlementParam = params.get("settlement");
  const settlement: FlagFilter = isFlagFilter(settlementParam) ? settlementParam : "";
  const interviewParam = params.get("interview");
  const interview: FlagFilter = isFlagFilter(interviewParam) ? interviewParam : "";
  const departmentId = params.get("department") ?? "";
  const nameTerm = params.get("q") ?? "";
  const openId = params.get("open");

  const departments = useRefOptions("departments");

  /** Filters that scope EVERY count on the page, tiles included. */
  const scope = useMemo<LifecycleFilters>(
    () => ({
      ...(departmentId !== "" ? { departmentIds: [departmentId] } : {}),
      ...(nameTerm.trim() !== "" ? { nameLike: nameTerm.trim() } : {}),
    }),
    [departmentId, nameTerm],
  );

  const filters = useMemo<LifecycleFilters>(() => {
    const settlementPending = flag(settlement);
    const interviewPending = flag(interview);
    return {
      ...scope,
      statuses: SLICE_STATUSES[slice],
      ...windowFilters(lwdWindow, today),
      ...(exitType !== "" ? { exitTypes: [exitType] } : {}),
      ...(settlementPending !== undefined ? { settlementPending } : {}),
      ...(interviewPending !== undefined ? { interviewPending } : {}),
    };
  }, [scope, slice, lwdWindow, today, exitType, settlement, interview]);

  const onNoticeFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.on_notice }),
    [scope],
  );
  const exitedFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.exited }),
    [scope],
  );
  const settlementPendingFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.exited, settlementPending: true }),
    [scope],
  );
  const interviewPendingFilters = useMemo<LifecycleFilters>(
    () => ({ ...scope, statuses: SLICE_STATUSES.exited, interviewPending: true }),
    [scope],
  );

  const onNoticeCount = useLifecycleCount(onNoticeFilters);
  const exitedCount = useLifecycleCount(exitedFilters);
  const settlementCount = useLifecycleCount(settlementPendingFilters);
  const interviewCount = useLifecycleCount(interviewPendingFilters);

  const listTotal = useLifecycleCount(filters);
  const register = useLifecycleRegister(filters, "lastWorkingDay");
  const rows = register.data ?? [];
  const openRow = rows.find((r) => r.id === openId) ?? null;

  const hasFilter =
    slice !== "on_notice" ||
    lwdWindow !== "" ||
    exitType !== "" ||
    settlement !== "" ||
    interview !== "" ||
    departmentId !== "" ||
    nameTerm.trim() !== "";

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    // A panel opened from the old list must not survive a change of list.
    if (name !== "open") next.delete("open");
    setParams(next, { replace: true });
  }

  function setMany(entries: readonly (readonly [string, string])[]): void {
    const next = new URLSearchParams(params);
    for (const [name, value] of entries) {
      if (value === "") next.delete(name);
      else next.set(name, value);
    }
    next.delete("open");
    setParams(next, { replace: true });
  }

  function clearAll(): void {
    setParams(new URLSearchParams(), { replace: true });
  }

  const columns: DataGridColumn<LifecycleEmployee>[] = [
    {
      key: "display_name",
      header: t("admin.exits.col.employee"),
      width: "16rem",
      sortable: true,
      render: (r) => (
        <PersonCell name={r.display_name} code={r.employee_code} secondary={r.designation_name} />
      ),
    },
    {
      key: "employment_status",
      header: t("admin.exits.col.stage"),
      width: "9rem",
      render: (r) => <StatusChip status={r.employment_status} map={STAGE_CHIP} />,
    },
    {
      key: "exit_type",
      header: t("admin.exits.col.exitType"),
      width: "10rem",
      render: (r) =>
        r.exit_type === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.exits.noExitType")}</span>
        ) : (
          <StatusChip status={r.exit_type} map={EXIT_TYPE_CHIP} />
        ),
    },
    {
      key: "resignation_date",
      header: t("admin.exits.col.resigned"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (r) => <span className="num">{fmtCivilDate(r.resignation_date)}</span>,
    },
    {
      key: "last_working_day",
      header: t("admin.exits.col.lastWorkingDay"),
      width: "11rem",
      align: "right",
      sortable: true,
      render: (r) =>
        r.last_working_day === null ? (
          // `ck_employees__exit_fields` forbids this on an exited row, so a blank
          // here means notice has started and the leaving date is not yet set.
          <span className="text-xs text-warning">{t("admin.exits.noLastDay")}</span>
        ) : (
          <span className="num">{fmtCivilDate(r.last_working_day)}</span>
        ),
    },
    {
      key: "notice_period_days",
      header: t("admin.exits.col.notice"),
      width: "8rem",
      align: "right",
      hideBelow: "lg",
      render: (r) => (
        <span className="num">
          {t("admin.exits.days", { n: formatNumber(r.notice_period_days) })}
        </span>
      ),
    },
    {
      key: "full_and_final_settled_on",
      header: t("admin.exits.col.settled"),
      width: "10rem",
      align: "right",
      render: (r) =>
        r.full_and_final_settled_on === null ? (
          <span className="text-xs text-warning">{t("admin.exits.settlement.pendingShort")}</span>
        ) : (
          <span className="num text-success">{fmtCivilDate(r.full_and_final_settled_on)}</span>
        ),
    },
    {
      key: "exit_interview_done",
      header: t("admin.exits.col.interview"),
      width: "9rem",
      hideBelow: "lg",
      render: (r) =>
        r.exit_interview_done ? (
          <span className="text-xs text-success">{t("admin.exits.interview.doneShort")}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("admin.exits.interview.pendingShort")}
          </span>
        ),
    },
    {
      key: "is_rehire_eligible",
      header: t("admin.exits.col.rehire"),
      width: "9rem",
      hideBelow: "lg",
      render: (r) =>
        r.is_rehire_eligible === null ? (
          <span className="text-xs text-muted-foreground">{t("admin.exits.rehire.unset")}</span>
        ) : r.is_rehire_eligible ? (
          <span className="text-xs text-success">{t("admin.exits.rehire.yes")}</span>
        ) : (
          <span className="text-xs text-destructive">{t("admin.exits.rehire.no")}</span>
        ),
    },
  ];

  const capped = listTotal.isSuccess && listTotal.data > rows.length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={DoorOpen}
        title={t("admin.exits.title")}
        subtitle={
          listTotal.isSuccess
            ? t("admin.exits.subtitle.count", { n: formatNumber(listTotal.data) })
            : t("admin.exits.subtitle.plain")
        }
      />

      {/*
        WHAT THE VENUE STILL OWES ITS LEAVERS.

        The four tiles cannot be stacked: `settlement pending` and `interview
        pending` are both `exited` NARROWED, so they are subsets of the exited tile
        AND overlap each other — somebody can be waiting on both.

        So the bar splits the EXITED population by the one that is money:
        settlement outstanding, versus settled. Exact, because settlement-pending
        is a strict subset of exited. An unsettled full-and-final is a statutory
        obligation with a clock on it, which is why it is the band drawn in red
        rather than the exit interview.
      */}
      {exitedCount.data !== undefined && settlementCount.data !== undefined ? (
        <div className="mt-4">
          <StatusMixCard
            title={t("admin.exits.mix.title")}
            hint={t("admin.exits.mix.hint")}
            format={(v) => formatNumber(v)}
            totalCaption={(n) => t("admin.exits.mix.total", { n: formatNumber(n) })}
            segments={[
              {
                key: "settlement",
                label: t("admin.exits.mix.pending"),
                value: settlementCount.data,
                tone: "absent",
              },
              {
                key: "settled",
                label: t("admin.exits.mix.settled"),
                value: Math.max(exitedCount.data - settlementCount.data, 0),
                tone: "present",
              },
            ]}
          />
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={t("admin.exits.tile.onNotice")}
          hint={t("admin.exits.tile.onNoticeHint")}
          query={onNoticeCount}
          onClick={() => setMany([["slice", "on_notice"]])}
        />
        <Tile
          label={t("admin.exits.tile.exited")}
          hint={t("admin.exits.tile.exitedHint")}
          query={exitedCount}
          onClick={() => setMany([["slice", "exited"]])}
        />
        <Tile
          label={t("admin.exits.tile.settlementPending")}
          hint={t("admin.exits.tile.settlementPendingHint")}
          tone="danger"
          query={settlementCount}
          onClick={() =>
            setMany([
              ["slice", "exited"],
              ["settlement", "pending"],
            ])
          }
        />
        <Tile
          label={t("admin.exits.tile.interviewPending")}
          hint={t("admin.exits.tile.interviewPendingHint")}
          query={interviewCount}
          onClick={() =>
            setMany([
              ["slice", "exited"],
              ["interview", "pending"],
            ])
          }
        />
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.exits.projectionNotice")}</Notice>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SelectField
          label={t("admin.exits.filter.slice")}
          value={slice}
          options={SLICE_OPTIONS}
          onChange={(v) => setParam("slice", v)}
        />
        <SelectField
          label={t("admin.exits.filter.window")}
          value={lwdWindow}
          options={WINDOW_OPTIONS}
          onChange={(v) => setParam("window", v)}
          hint={t("admin.exits.filter.windowHint")}
        />
        <SelectField
          label={t("admin.exits.filter.exitType")}
          value={exitType}
          placeholder={t("admin.exits.filter.anyExitType")}
          options={exitTypeValues.map((v) => ({ value: v, label: EXIT_TYPE_LABELS[v] }))}
          onChange={(v) => setParam("type", v)}
        />
        <SelectField
          label={t("admin.exits.filter.settlement")}
          value={settlement}
          options={SETTLEMENT_OPTIONS}
          onChange={(v) => setParam("settlement", v)}
        />
        <SelectField
          label={t("admin.exits.filter.interview")}
          value={interview}
          options={INTERVIEW_OPTIONS}
          onChange={(v) => setParam("interview", v)}
        />
        <SelectField
          label={t("admin.exits.filter.department")}
          value={departmentId}
          placeholder={t("admin.exits.filter.anyDepartment")}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => setParam("department", v)}
        />
        <TextField
          label={t("admin.exits.filter.name")}
          value={nameTerm}
          onChange={(v) => setParam("q", v)}
          placeholder={t("admin.exits.filter.namePlaceholder")}
        />
        {hasFilter ? (
          <div className="flex items-end">
            <Button type="button" variant="ghost" onClick={clearAll}>
              {t("admin.exits.filter.clear")}
            </Button>
          </div>
        ) : null}
      </div>

      {capped ? (
        <div className="mt-4">
          <Notice tone="warning">
            {t("admin.exits.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(listTotal.data),
              cap: formatNumber(LIFECYCLE_LIST_LIMIT),
            })}
          </Notice>
        </div>
      ) : null}

      {openRow !== null ? (
        <ExitPanel row={openRow} today={today} onClose={() => setParam("open", "")} />
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={register.isPending}
          error={register.error}
          onRetry={() => void register.refetch()}
          isEmpty={rows.length === 0}
          partialError={listTotal.error}
          partialLabel={t("admin.exits.partial.total")}
          empty={
            <EmptyState
              icon={DoorOpen}
              title={t("admin.exits.empty.title")}
              hint={t("admin.exits.empty.hint")}
              {...(hasFilter
                ? {
                    action: (
                      <Button variant="outline" onClick={clearAll}>
                        {t("admin.exits.filter.clear")}
                      </Button>
                    ),
                  }
                : {})}
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            pageSize={50}
            onRowClick={(r) => setParam("open", r.id)}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="note">{t("admin.exits.clearanceScope")}</Notice>
      </div>
    </div>
  );
}

/** A tile whose number is a Postgres COUNT over the slice it opens. */
function Tile({
  label,
  hint,
  query,
  tone = "neutral",
  onClick,
}: {
  label: string;
  hint: string;
  query: { data: number | undefined; error: Error | null; isPending: boolean };
  tone?: "neutral" | "danger";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "danger"
            ? "num mt-1 font-display text-2xl font-semibold text-destructive"
            : "num mt-1 font-display text-2xl font-semibold"
        }
      >
        {query.isPending ? "…" : query.error !== null ? t("common.empty") : formatNumber(query.data)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/** One labelled server value. Never blank, never a plausible zero. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num truncate text-sm">{value}</dd>
    </div>
  );
}

/**
 * One leaver: the exit record as the projection wrote it, the property still out
 * on them, and the three settlement flags an admin may actually change.
 *
 * Each action is an audited UPDATE with `expectedUpdatedAt` set, so a panel left
 * open while someone else edits the same row saves NOTHING and reports it,
 * instead of overwriting the other edit.
 */
function ExitPanel({
  row,
  today,
  onClose,
}: {
  row: LifecycleEmployee;
  today: string;
  onClose: () => void;
}) {
  const update = useLifecycleEmployeeUpdate(row.employee_code);
  const custody = useExitCustody(row.id);
  const items = custody.data ?? [];

  async function patch(values: Readonly<Record<string, unknown>>, reason: string): Promise<void> {
    await update.saveAsync(
      { employeeId: row.id, patch: values, expectedUpdatedAt: row.updated_at },
      reason,
    );
  }

  const custodyColumns: DataGridColumn<CustodyRow>[] = [
    {
      key: "asset_tag",
      header: t("admin.exits.custody.col.asset"),
      render: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{r.asset_name}</span>
          <span className="num text-xs text-muted-foreground">
            {r.asset_tag}
            {r.serial_number === null ? "" : ` · ${r.serial_number}`}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("admin.exits.custody.col.status"),
      width: "11rem",
      render: (r) => <StatusChip status={r.status} map={CUSTODY_CHIP} />,
    },
    {
      key: "days_in_custody",
      header: t("admin.exits.custody.col.days"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      // The server's own day count — never a client date subtraction.
      render: (r) => <span className="num">{dash(r.days_in_custody, formatNumber)}</span>,
    },
    {
      key: "expected_return_date",
      header: t("admin.exits.custody.col.due"),
      width: "11rem",
      align: "right",
      render: (r) => (
        <span className={r.is_return_overdue === true ? "num text-destructive" : "num"}>
          {fmtCivilDate(r.expected_return_date)}
        </span>
      ),
    },
  ];

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">{t("admin.exits.panel.title")}</h2>
          <PersonCell
            name={row.display_name}
            code={row.employee_code}
            secondary={row.designation_name}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}`}>
              {t("admin.exits.panel.openPerson")}
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/admin/people/${encodeURIComponent(row.employee_code)}/audit`}>
              {t("admin.exits.panel.openHistory")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="mr-1 size-4" aria-hidden />
            {t("admin.exits.panel.close")}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusChip status={row.employment_status} map={STAGE_CHIP} />
        {row.exit_type === null ? null : (
          <StatusChip status={row.exit_type} map={EXIT_TYPE_CHIP} />
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Fact label={t("admin.exits.fact.joined")} value={fmtCivilDate(row.date_of_join)} />
        <Fact label={t("admin.exits.col.resigned")} value={fmtCivilDate(row.resignation_date)} />
        <Fact
          label={t("admin.exits.col.lastWorkingDay")}
          value={fmtCivilDate(row.last_working_day)}
        />
        <Fact
          label={t("admin.exits.col.notice")}
          value={t("admin.exits.days", { n: formatNumber(row.notice_period_days) })}
        />
        <Fact
          label={t("admin.exits.col.settled")}
          value={fmtCivilDate(row.full_and_final_settled_on)}
        />
        <Fact
          label={t("admin.exits.col.interview")}
          value={
            row.exit_interview_done
              ? t("admin.exits.interview.doneShort")
              : t("admin.exits.interview.pendingShort")
          }
        />
        <Fact
          label={t("admin.exits.col.rehire")}
          value={
            row.is_rehire_eligible === null
              ? t("admin.exits.rehire.unset")
              : row.is_rehire_eligible
                ? t("admin.exits.rehire.yes")
                : t("admin.exits.rehire.no")
          }
        />
        <Fact label={t("admin.exits.fact.department")} value={dash(row.department_name)} />
        <Fact label={t("admin.exits.fact.manager")} value={dash(row.reporting_manager_name)} />
        <Fact label={t("admin.exits.fact.location")} value={dash(row.location_name)} />
        <Fact label={t("admin.exits.fact.workEmail")} value={dash(row.work_email)} />
        <Fact label={t("admin.exits.fact.updated")} value={fmtDateTime(row.updated_at)} />
      </dl>

      {row.exit_reason === null ? null : (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{t("admin.exits.fact.exitReason")}</p>
          <p className="text-sm">{row.exit_reason}</p>
        </div>
      )}

      {row.employment_status === "on_notice" && row.last_working_day === null ? (
        <div className="mt-3">
          <Notice tone="warning">{t("admin.exits.noLastDayNotice")}</Notice>
        </div>
      ) : null}

      {update.userMessage !== null ? (
        <div className="mt-3">
          <Notice tone="error">{update.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ReasonActionButton
          label={t("admin.exits.action.settle")}
          title={t("admin.exits.action.settleTitle")}
          description={t("admin.exits.action.settleDescription", {
            name: row.display_name,
            code: row.employee_code,
            date: fmtCivilDate(today),
          })}
          confirmLabel={t("admin.exits.action.settleConfirm")}
          minLength={15}
          variant="default"
          size="default"
          disabled={row.full_and_final_settled_on !== null || update.isPending}
          disabledHint={t("admin.exits.action.settleDisabled")}
          onConfirm={(reason) => patch({ full_and_final_settled_on: today }, reason)}
        />
        <ReasonActionButton
          label={t("admin.exits.action.interview")}
          title={t("admin.exits.action.interviewTitle")}
          description={t("admin.exits.action.interviewDescription", {
            name: row.display_name,
            code: row.employee_code,
          })}
          confirmLabel={t("admin.exits.action.interviewConfirm")}
          minLength={15}
          size="default"
          disabled={row.exit_interview_done || update.isPending}
          disabledHint={t("admin.exits.action.interviewDisabled")}
          onConfirm={(reason) => patch({ exit_interview_done: true }, reason)}
        />
        <ReasonActionButton
          label={t("admin.exits.action.rehireYes")}
          title={t("admin.exits.action.rehireYesTitle")}
          description={t("admin.exits.action.rehireDescription", {
            name: row.display_name,
            code: row.employee_code,
            value: t("admin.exits.rehire.yes"),
          })}
          confirmLabel={t("admin.exits.action.rehireConfirm")}
          minLength={15}
          size="default"
          disabled={row.is_rehire_eligible === true || update.isPending}
          disabledHint={t("admin.exits.action.rehireDisabled")}
          onConfirm={(reason) => patch({ is_rehire_eligible: true }, reason)}
        />
        <ReasonActionButton
          label={t("admin.exits.action.rehireNo")}
          title={t("admin.exits.action.rehireNoTitle")}
          description={t("admin.exits.action.rehireDescription", {
            name: row.display_name,
            code: row.employee_code,
            value: t("admin.exits.rehire.no"),
          })}
          confirmLabel={t("admin.exits.action.rehireConfirm")}
          minLength={15}
          size="default"
          disabled={row.is_rehire_eligible === false || update.isPending}
          disabledHint={t("admin.exits.action.rehireDisabled")}
          onConfirm={(reason) => patch({ is_rehire_eligible: false }, reason)}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t("admin.exits.action.footnote")}</p>

      <h3 className="mt-6 flex items-center gap-2 font-display text-base font-semibold">
        <Boxes className="size-4" aria-hidden />
        {t("admin.exits.custody.title")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.exits.custody.hint")}</p>

      <div className="mt-3">
        <StateBoundary
          loading={custody.isPending}
          error={custody.error}
          onRetry={() => void custody.refetch()}
          isEmpty={items.length === 0}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={Package}
              title={t("admin.exits.custody.empty.title")}
              hint={t("admin.exits.custody.empty.hint")}
            />
          }
        >
          <DataGrid
            columns={custodyColumns}
            rows={items}
            rowKey={(r) => r.allocation_id}
            pageSize={50}
          />
        </StateBoundary>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/assets/exit-liability">
            <Workflow className="mr-2 size-4" aria-hidden />
            {t("admin.exits.custody.openLiability")}
          </Link>
        </Button>
      </div>

      {/*
        AFTER custody, deliberately. The asset list is the evidence somebody needs
        in front of them before they tick "all assets returned" — putting the
        checklist first would invite attesting to something they have not looked at.
      */}
      <ClearanceChecklist employeeId={row.id} />
    </section>
  );
}

/** The chips, in the words the screen uses for them. */
const CLEARANCE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.exits.clr.status.pending"), tone: "warn" },
  cleared: { label: t("admin.exits.clr.status.cleared"), tone: "success" },
  waived: { label: t("admin.exits.clr.status.waived"), tone: "info" },
  blocked: { label: t("admin.exits.clr.status.blocked"), tone: "danger" },
};

/**
 * One leaver's no-dues checklist.
 *
 * Its own component so the lines and the progress are read only for the person
 * actually opened — a register of forty leavers would otherwise fire eighty
 * queries nobody asked for.
 */
function ClearanceChecklist({ employeeId }: { readonly employeeId: string }) {
  const lines = useEmployeeClearance(employeeId);
  const progress = useClearanceProgress(employeeId);
  const open = useOpenClearance();
  const setStatus = useSetClearanceStatus();
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const rows = lines.data ?? [];
  /* NULL progress means no checklist has been opened, which is not the same as an
     empty one — so the screen offers to open it rather than drawing "0 of 0". */
  const notOpened = progress.data === null && rows.length === 0;

  return (
    <div className="mt-6">
      <h3 className="flex items-center gap-2 font-display text-base font-semibold">
        <ClipboardCheck className="size-4" aria-hidden />
        {t("admin.exits.clr.title")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("admin.exits.clr.hint")}</p>

      {notOpened ? (
        <div className="mt-3 rounded-md border bg-muted/20 p-4">
          <p className="text-sm text-muted-foreground">{t("admin.exits.clr.notOpened")}</p>
          <Button
            className="mt-3"
            size="sm"
            disabled={open.isPending}
            onClick={() =>
              open.mutate({
                input: { employeeId },
                reason: "exits console: open the no-dues checklist for this leaver",
              })
            }
          >
            {open.isPending ? t("admin.exits.clr.opening") : t("admin.exits.clr.open")}
          </Button>
          {open.userMessage === null ? null : (
            <div className="mt-2">
              <Notice tone="error">{open.userMessage}</Notice>
            </div>
          )}
        </div>
      ) : (
        <>
          {progress.data === null || progress.data === undefined ? null : (
            <div className="mt-3 rounded-md border bg-card p-3">
              <CoverageBar
                value={progress.data.settled_items}
                target={progress.data.total_items}
                title={t("admin.exits.clr.title")}
                showLabel
                height={12}
                /* `is_clear` is the VIEW's answer, not a recount here: every
                   mandatory line settled, optional ones need not be. */
                caption={
                  progress.data.is_clear
                    ? t("admin.exits.clr.clear")
                    : t("admin.exits.clr.outstanding", {
                        n: formatNumber(progress.data.mandatory_outstanding),
                      })
                }
              />
            </div>
          )}

          <ul className="mt-3 space-y-2">
            {rows.map((line) => (
              <li key={line.id} className="rounded-md border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium leading-snug">
                      {line.label}
                      {line.is_mandatory ? null : (
                        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                          {t("admin.exits.clr.optional")}
                        </span>
                      )}
                    </p>
                    {line.owner_hint === null ? null : (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("admin.exits.clr.owner", { who: line.owner_hint })}
                      </p>
                    )}
                    {line.note === null ? null : (
                      <p className="mt-1 text-xs text-muted-foreground">{line.note}</p>
                    )}
                  </div>
                  <StatusChip status={line.status} map={CLEARANCE_CHIP} />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {clearanceStatusValues.map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={line.status === status ? "default" : "outline"}
                      disabled={setStatus.isPending}
                      onClick={() => {
                        /*
                          A waiver or a block needs a sentence, so those open the
                          box instead of firing. The server refuses them without
                          one too — this is only so the refusal arrives before the
                          round trip.
                        */
                        if (needsReason(status, "")) {
                          setNoteFor(line.id);
                          setNote(line.note ?? "");
                          return;
                        }
                        setStatus.mutate({
                          input: { clearanceId: line.id, status, note: null },
                          reason: `exits console: mark "${line.label}" as ${status}`,
                        });
                      }}
                    >
                      {CLEARANCE_CHIP[status]?.label ?? status}
                    </Button>
                  ))}
                </div>

                {noteFor === line.id ? (
                  <div className="mt-2">
                    <textarea
                      rows={2}
                      className="w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={t("admin.exits.clr.notePlaceholder", {
                        n: String(CLEARANCE_REASON_MIN_LENGTH),
                      })}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <div className="mt-1.5 flex gap-1.5">
                      {(["waived", "blocked"] as const).map((status: ClearanceStatus) => (
                        <Button
                          key={status}
                          size="sm"
                          variant="outline"
                          disabled={needsReason(status, note) || setStatus.isPending}
                          onClick={() => {
                            setStatus.mutate(
                              {
                                input: { clearanceId: line.id, status, note },
                                reason: `exits console: mark "${line.label}" as ${status}`,
                              },
                              {
                                onSuccess: () => {
                                  setNoteFor(null);
                                  setNote("");
                                },
                              },
                            );
                          }}
                        >
                          {CLEARANCE_CHIP[status]?.label ?? status}
                        </Button>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setNoteFor(null)}>
                        {t("admin.exits.clr.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          {setStatus.userMessage === null ? null : (
            <div className="mt-2">
              <Notice tone="error">{setStatus.userMessage}</Notice>
            </div>
          )}
        </>
      )}
    </div>
  );
}
