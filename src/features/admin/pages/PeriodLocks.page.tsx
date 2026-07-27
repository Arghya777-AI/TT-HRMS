/**
 * §4 · /admin/attendance/locks — Period Locks. Which date ranges are frozen, who
 * froze them, when, and why.
 *
 * A lock is the promise a payroll run rests on: while it stands, neither the
 * nightly engine nor the Recompute Console may move a figure inside its range
 * (`recompute_attendance_range` drops hard-locked cells and reports them as
 * `days_skipped_locked`). So this screen treats both acts as evidence:
 *
 *  - TAKING A LOCK asks for a reason. `attendance_locks` is in
 *    `audit.reason_required_tables` AND has a NOT NULL `reason` with a ≥10
 *    CHECK, so the sentence is stored twice — once as the row the grid renders,
 *    once as the audit entry. Nothing here ever defaults it.
 *  - RELEASING A LOCK is the more dangerous act, and the confirmation says what
 *    it means in as many words: figures that were frozen can move again. RLS
 *    limits the UPDATE to `super_admin` (`attendance_locks__super_update`), so an
 *    ordinary admin sees the button disabled WITH THE REASON rather than a button
 *    that fails at zero rows.
 *
 * Released locks stay on the list. A lock that vanished when it was lifted would
 * make an audit trail with a hole in it indistinguishable from one that was
 * tampered with.
 *
 * @route /admin/attendance/locks
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldCheck, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { compareCivilDates, fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import {
  LOCK_ROW_CAP,
  useAttendanceLocks,
  useCreateLock,
  useLockActorNames,
  useUnlockPeriod,
} from "../hooks/useAttendanceControls";
import type { AttendanceLock, CreateLockInput } from "../api/attendance.api";

/** `ck_al__scope` — the four values the CHECK constraint allows. */
type LockScope = "company" | "location" | "department" | "employee";

const SCOPE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  company: { label: t("admin.locks.scope.company"), tone: "danger" },
  location: { label: t("admin.locks.scope.location"), tone: "warn" },
  department: { label: t("admin.locks.scope.department"), tone: "warn" },
  employee: { label: t("admin.locks.scope.employee"), tone: "info" },
};

/** `ck_al__lock_kind` — 'soft' or 'hard'. */
const KIND_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  soft: { label: t("admin.locks.kind.soft"), tone: "info" },
  hard: { label: t("admin.locks.kind.hard"), tone: "danger" },
};

const STATE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  live: { label: t("admin.locks.state.live"), tone: "warn" },
  released: { label: t("admin.locks.state.released"), tone: "neutral" },
};

function isLockScope(value: string): value is LockScope {
  return (
    value === "company" || value === "location" || value === "department" || value === "employee"
  );
}

function scopeOptions(): SelectOption[] {
  return [
    { value: "company", label: t("admin.locks.scope.company") },
    { value: "location", label: t("admin.locks.scope.location") },
    { value: "department", label: t("admin.locks.scope.department") },
    { value: "employee", label: t("admin.locks.scope.employee") },
  ];
}

export default function PeriodLocksPage() {
  const [params, setParams] = useSearchParams();
  const { user, can } = useAuth();
  const profileId = user?.id ?? null;
  const isSuper = can("admin.super");
  const today = nowIstDate();

  const view = params.get("view") === "live" ? "live" : "all";

  const locks = useAttendanceLocks();
  const actors = useLockActorNames(locks.data);
  const companyId = useDefaultCompanyId();
  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const departments = useRefOptions("departments");
  const locations = useRefOptions("locations");

  // ── The create-lock form ────────────────────────────────────────────────────
  const [scope, setScope] = useState<LockScope>("company");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [targetId, setTargetId] = useState("");
  const [hardLock, setHardLock] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const create = useCreateLock((lock) => {
    setDone(
      t("admin.locks.done.created", {
        from: fmtCivilDate(lock.from_date),
        to: fmtCivilDate(lock.to_date),
      }),
    );
    setTargetId("");
  });
  const unlock = useUnlockPeriod((lock) => {
    setDone(
      t("admin.locks.done.released", {
        from: fmtCivilDate(lock.from_date),
        to: fmtCivilDate(lock.to_date),
      }),
    );
  });

  const rangeError: string | null =
    fromDate === "" || toDate === ""
      ? t("admin.locks.error.rangeRequired")
      : compareCivilDates(toDate, fromDate) < 0
        ? t("admin.locks.error.reversed")
        : null;

  const targetError: string | null =
    scope !== "company" && targetId === "" ? t("admin.locks.error.pickTarget") : null;

  const createBlocked: string | null =
    profileId === null
      ? t("admin.locks.blocked.noSession")
      : companyId === null
        ? t("admin.locks.blocked.noCompany")
        : rangeError !== null
          ? rangeError
          : targetError !== null
            ? targetError
            : null;

  const createInput: CreateLockInput = {
    companyId: companyId ?? "",
    fromDate,
    toDate,
    scope,
    lockKind: hardLock && isSuper ? "hard" : "soft",
    lockedBy: profileId ?? "",
    ...(scope === "location" && targetId !== "" ? { locationId: targetId } : {}),
    ...(scope === "department" && targetId !== "" ? { departmentId: targetId } : {}),
    ...(scope === "employee" && targetId !== "" ? { employeeId: targetId } : {}),
  };

  // ── The grid ────────────────────────────────────────────────────────────────
  const allRows = locks.data ?? [];
  const rows = useMemo(
    () => (view === "live" ? allRows.filter((lock) => lock.unlocked_at === null) : allRows),
    [allRows, view],
  );
  const capped = allRows.length >= LOCK_ROW_CAP;

  const actorName = (id: string | null): string | null => {
    if (id === null) return null;
    return actors.data?.get(id)?.full_name ?? null;
  };

  const targetLabel = (lock: AttendanceLock): string => {
    if (lock.scope === "company") return t("admin.locks.target.wholeCompany");
    if (lock.scope === "location") {
      return dash(locations.data?.find((row) => row.id === lock.location_id)?.name ?? null);
    }
    if (lock.scope === "department") {
      return dash(departments.data?.find((row) => row.id === lock.department_id)?.name ?? null);
    }
    if (lock.scope === "employee") {
      const label = lock.employee_id !== null ? labels.data?.get(lock.employee_id) : undefined;
      return label !== undefined ? `${label.name} · ${label.code}` : dash(null);
    }
    return dash(null);
  };

  const columns: DataGridColumn<AttendanceLock>[] = [
    {
      key: "period",
      header: t("admin.locks.col.period"),
      width: "14rem",
      sortable: true,
      sortValue: (lock) => lock.from_date,
      render: (lock) => (
        <span className="num">
          {lock.from_date === lock.to_date
            ? fmtCivilDate(lock.from_date)
            : t("admin.common.dateRange", {
                from: fmtCivilDate(lock.from_date),
                to: fmtCivilDate(lock.to_date),
              })}
        </span>
      ),
    },
    {
      key: "scope",
      header: t("admin.locks.col.scope"),
      width: "9rem",
      render: (lock) => <StatusChip status={lock.scope} map={SCOPE_CHIP} />,
    },
    {
      key: "target",
      header: t("admin.locks.col.target"),
      width: "13rem",
      render: (lock) => <span className="normal-case">{targetLabel(lock)}</span>,
    },
    {
      key: "lock_kind",
      header: t("admin.locks.col.kind"),
      width: "8rem",
      hideBelow: "md",
      render: (lock) => <StatusChip status={lock.lock_kind} map={KIND_CHIP} />,
    },
    {
      key: "state",
      header: t("admin.locks.col.state"),
      width: "9rem",
      render: (lock) => (
        <StatusChip status={lock.unlocked_at === null ? "live" : "released"} map={STATE_CHIP} />
      ),
    },
    {
      key: "locked_by",
      header: t("admin.locks.col.lockedBy"),
      width: "14rem",
      hideBelow: "md",
      render: (lock) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium normal-case">{dash(actorName(lock.locked_by))}</span>
          <span className="num text-xs text-muted-foreground">{fmtDateTime(lock.locked_at)}</span>
        </span>
      ),
    },
    {
      key: "reason",
      header: t("admin.locks.col.reason"),
      hideBelow: "lg",
      render: (lock) => <span className="normal-case">{dash(lock.reason)}</span>,
    },
    {
      key: "released",
      header: t("admin.locks.col.released"),
      width: "16rem",
      hideBelow: "lg",
      render: (lock) => {
        if (lock.unlocked_at === null) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="font-medium normal-case">{dash(actorName(lock.unlocked_by))}</span>
            <span className="num text-xs text-muted-foreground">
              {fmtDateTime(lock.unlocked_at)}
            </span>
            <span className="text-xs text-muted-foreground normal-case">
              {dash(lock.unlock_reason)}
            </span>
          </span>
        );
      },
    },
    {
      key: "actions",
      header: t("admin.locks.col.actions"),
      width: "11rem",
      align: "right",
      render: (lock) => {
        if (lock.unlocked_at !== null) {
          return <span className="text-xs text-muted-foreground">{t("admin.locks.alreadyReleased")}</span>;
        }
        const blocked: string | null = !isSuper
          ? t("admin.locks.blocked.notSuper")
          : profileId === null
            ? t("admin.locks.blocked.noSession")
            : null;
        return (
          <ReasonActionButton
            label={t("admin.locks.action.release")}
            title={t("admin.locks.dialog.releaseTitle", {
              from: fmtCivilDate(lock.from_date),
              to: fmtCivilDate(lock.to_date),
            })}
            description={t("admin.locks.dialog.releaseDescription", {
              from: fmtCivilDate(lock.from_date),
              to: fmtCivilDate(lock.to_date),
              target: targetLabel(lock),
            })}
            confirmLabel={t("admin.locks.dialog.releaseConfirm")}
            minLength={SENSITIVE_REASON_LENGTH}
            variant="destructive"
            disabled={blocked !== null || unlock.isPending}
            {...(blocked !== null ? { disabledHint: blocked } : {})}
            onConfirm={(reason) =>
              unlock.saveAsync(
                {
                  lockId: lock.id,
                  unlockedBy: profileId ?? "",
                  fromDate: lock.from_date,
                  toDate: lock.to_date,
                },
                reason,
              )
            }
          />
        );
      },
    },
  ];

  const targetChoices: readonly SelectOption[] =
    scope === "location"
      ? (locations.data ?? []).map((row) => ({ value: row.id, label: row.name }))
      : scope === "department"
        ? (departments.data ?? []).map((row) => ({ value: row.id, label: row.name }))
        : scope === "employee"
          ? employeeChoices
          : [];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.locks.title")}
        subtitle={t("admin.locks.subtitle")}
        actions={
          <Button asChild variant="ghost">
            <Link to="/admin/attendance/recompute">{t("admin.locks.openRecompute")}</Link>
          </Button>
        }
      />

      {done !== null ? (
        <Notice
          tone="success"
          className="mt-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setDone(null)}>
              {t("admin.common.dismiss")}
            </Button>
          }
        >
          {done}
        </Notice>
      ) : null}

      {/* ── Take a lock ─────────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.locks.create.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.locks.create.hint")}</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField
            label={t("admin.common.filter.from")}
            type="date"
            value={fromDate}
            onChange={setFromDate}
            {...(rangeError !== null ? { error: rangeError } : {})}
          />
          <TextField
            label={t("admin.common.filter.to")}
            type="date"
            value={toDate}
            onChange={setToDate}
          />
          <SelectField
            label={t("admin.locks.create.scope")}
            value={scope}
            options={scopeOptions()}
            onChange={(value) => {
              if (isLockScope(value)) {
                setScope(value);
                setTargetId("");
              }
            }}
          />
          {scope !== "company" ? (
            <SelectField
              label={t("admin.locks.create.target")}
              value={targetId}
              placeholder={t("admin.locks.create.pickTarget")}
              options={targetChoices}
              disabled={labels.isLoading || departments.isLoading || locations.isLoading}
              onChange={setTargetId}
              {...(targetError !== null ? { error: targetError } : {})}
            />
          ) : null}
        </div>

        {/* Native input — this repo has no shadcn checkbox atom (MasterFormSheet
            uses the same pattern). A hard lock is super-admin-only by RLS. */}
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={hardLock && isSuper}
            disabled={!isSuper}
            onChange={(event) => setHardLock(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>
            <span className="font-medium">{t("admin.locks.create.hardLabel")}</span>
            <span className="block text-xs text-muted-foreground">
              {isSuper ? t("admin.locks.create.hardHint") : t("admin.locks.create.hardNotSuper")}
            </span>
          </span>
        </label>

        <div className="mt-4">
          <ReasonActionButton
            label={t("admin.locks.create.submit")}
            title={t("admin.locks.dialog.createTitle", {
              from: fmtCivilDate(fromDate),
              to: fmtCivilDate(toDate),
            })}
            description={t("admin.locks.dialog.createDescription", {
              from: fmtCivilDate(fromDate),
              to: fmtCivilDate(toDate),
              scope:
                scope === "company"
                  ? t("admin.locks.target.wholeCompany")
                  : (targetChoices.find((option) => option.value === targetId)?.label ??
                    t("common.empty")),
            })}
            confirmLabel={t("admin.locks.dialog.createConfirm")}
            minLength={SENSITIVE_REASON_LENGTH}
            variant="default"
            size="default"
            disabled={createBlocked !== null || create.isPending}
            {...(createBlocked !== null ? { disabledHint: createBlocked } : {})}
            onConfirm={(reason) => create.saveAsync(createInput, reason)}
          />
        </div>

        {createBlocked !== null ? (
          <p className="mt-2 text-xs text-muted-foreground">{createBlocked}</p>
        ) : null}
      </section>

      {capped ? (
        <Notice tone="warning" className="mt-4">
          {t("admin.common.rowCap", { count: LOCK_ROW_CAP })}
        </Notice>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={locks.isPending}
          error={locks.error}
          onRetry={() => void locks.refetch()}
          partialError={actors.error ?? labels.error ?? undefined}
          partialLabel={t("admin.locks.partial")}
          skeletonRows={5}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(lock) => lock.id}
            pageSize={25}
            toolbar={
              <div className="grid w-full gap-3 sm:grid-cols-3">
                <SelectField
                  label={t("admin.locks.filter.view")}
                  value={view}
                  options={[
                    { value: "all", label: t("admin.locks.filter.all") },
                    { value: "live", label: t("admin.locks.filter.liveOnly") },
                  ]}
                  onChange={(value) => {
                    const next = new URLSearchParams(params);
                    if (value === "all") next.delete("view");
                    else next.set("view", value);
                    setParams(next, { replace: true });
                  }}
                />
                <div className="flex items-end sm:col-span-2 sm:justify-end">
                  <p className="text-sm text-muted-foreground">
                    {t("admin.locks.showing", { n: formatNumber(rows.length) })}
                  </p>
                </div>
              </div>
            }
            emptyState={
              <EmptyState
                icon={Snowflake}
                title={
                  view === "live"
                    ? t("admin.locks.empty.liveTitle")
                    : t("admin.locks.empty.title")
                }
                hint={t("admin.locks.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.locks.footnote")}</Notice>
      </div>
    </div>
  );
}
