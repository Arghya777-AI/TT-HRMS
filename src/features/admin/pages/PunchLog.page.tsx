/**
 * §4 · /admin/attendance/punches — Punch Log. The raw, append-only scan log.
 *
 * This is the system of record for one camera at one gate, and it is the screen
 * an auditor or an aggrieved employee is shown. Four rules follow from that:
 *
 *  1. VOIDED ROWS ARE STRUCK THROUGH AND STILL PRESENT. `fetchPunchLog` defaults
 *     to hiding them; this page passes `includeVoided: true` on every read and
 *     never offers a way to remove them from the list. A void sets four columns
 *     on an existing row — `is_voided`, `voided_by`, `voided_at`, `void_reason` —
 *     and migration 016 refuses a DELETE outright. The screen says so in as many
 *     words, above the grid, because "voided" reads as "gone" to most people and
 *     an admin who believes a mistake can be erased will make worse decisions.
 *  2. THIS PAGE DOES NOT DECIDE WHICH SCAN WAS ARRIVAL. `derived_direction` comes
 *     from `v_attendance_punch_detail`: 'IN' on the first scan of the IST day,
 *     'OUT' on the last when there is more than one, 'SCAN' for everything
 *     between. Unlimited scans in the middle change neither. Nothing is computed
 *     here — the whole product exists so that this rule lives in Postgres.
 *  3. THE TOTAL IS A SERVER COUNT. The header figure is a `count=exact` over the
 *     same `PunchFilters` object the rows are read with, so it cannot drift as
 *     the admin pages further (DR-29).
 *  4. NO RAW ENUM ON SCREEN. Source renders the view's own `source_label`
 *     ('Kiosk — Face', 'Manual (admin)'); the enum appears only inside the URL's
 *     filter value. Confidence is a server-banded high/medium/low, not a float
 *     the reader has to interpret.
 *
 * Timestamps are `fmtDateTime` — 'dd-MMM-yyyy HH:mm IST', 24-hour, IST suffix
 * mandatory. Filter state lives in the URL, so a filtered log is a link.
 *
 * @route /admin/attendance/punches
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { canonicalPunchLogParams, isOn } from "../punchLogParams";
import { ScanFace, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { PunchLocation } from "@/shared/ui/PunchLocation";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { addIstDays, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { asArray } from "@/lib/asArray";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import { useKioskDevices } from "../hooks/useKioskConsole";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import {
  PUNCH_LOG_PAGE_SIZE,
  flattenPunches,
  newVoidIdempotencyKey,
  punchDirectionLabel,
  punchSourceValues,
  usePunchLog,
  usePunchLogCount,
  usePunchSourceOptions,
  useVoidPunch,
  useVoidReasonCodeOptions,
  type VoidPunchInput,
} from "../hooks/usePunchConsole";
import type { PunchFilters, PunchRow, VoidReasonCode } from "../api/attendance.api";

/** The default window: a week of scans, which is what a correction pass covers. */
const DEFAULT_DAYS_BACK = 6;

/** Server-banded match confidence. The float itself is never the headline. */
const CONFIDENCE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  high: { label: t("admin.punch.confidence.high"), tone: "success" },
  medium: { label: t("admin.punch.confidence.medium"), tone: "warn" },
  low: { label: t("admin.punch.confidence.low"), tone: "danger" },
};

/** Arrival and departure are the two an admin scans the log for. */
const DERIVED_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  IN: { label: t("admin.punch.derived.arrival"), tone: "success" },
  OUT: { label: t("admin.punch.derived.departure"), tone: "info" },
  SCAN: { label: t("admin.punch.derived.between"), tone: "neutral" },
};

function isPunchSource(value: string): boolean {
  return (punchSourceValues as readonly string[]).includes(value);
}

/** What the void dialog is asking about, plus the key that makes a retry safe. */
interface VoidTarget extends VoidPunchInput {
  readonly employeeName: string;
  readonly employeeCode: string;
  readonly punchedAtLabel: string;
}

export default function PunchLogPage() {
  const [params, setParams] = useSearchParams();
  const { employee } = useAuth();

  /*
    ── EVERY LINK INTO THIS PAGE WAS ARRIVING UNFILTERED ──────────────────────
    "All scans for this person" on an employee's attendance page sends
    `?employee=<uuid>`. This page read `?emp=`. The two were written separately and
    never matched, so the button opened the whole log for every employee — which is
    the one thing it promises not to do. Three other links in the app send `?date=`
    to mean "the scans on this day", and that was read as nothing at all, so a
    day-scoped link landed on the default 30-day range. The Command Palette's
    "punches to review" sends `review=true` against a test for `"1"`.

    None of them were broken by a rename: they never worked. So rather than teach the
    reader four spellings and leave the URL ambiguous, an arriving alias is REWRITTEN
    ONCE to the canonical form below. Reading both spellings instead looks simpler and
    is worse — the dropdown writes `emp`, so `?employee=X` plus a dropdown change
    leaves both in the URL, and clearing the dropdown would resurrect X instead of
    clearing the filter.
  */
  useEffect(() => {
    const next = canonicalPunchLogParams(params);
    // `replace`, so normalising does not put a dead URL in the back button.
    if (next !== null) setParams(next, { replace: true });
  }, [params, setParams]);

  const today = nowIstDate();
  const from = params.get("from") ?? params.get("date") ?? addIstDays(today, -DEFAULT_DAYS_BACK);
  const to = params.get("to") ?? params.get("date") ?? today;
  /*
    `emp` is what the dropdown writes and the canonical key; `employee` is read here too
    so the very first render — before the effect above has rewritten the URL — already
    filters. Without it the page flashes the full log for every employee.
  */
  const employeeId = params.get("emp") ?? params.get("employee") ?? "";
  const deviceId = params.get("device") ?? "";
  const source = params.get("source") ?? "";
  const onlyVoided = isOn(params.get("voided"));
  const onlyNeedsReview = isOn(params.get("review"));

  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const devices = useKioskDevices();
  const sourceChoices = usePunchSourceOptions();
  const voidCodeChoices = useVoidReasonCodeOptions();

  const [voidCode, setVoidCode] = useState<VoidReasonCode>("admin_void");

  const filters = useMemo<PunchFilters>(
    () => ({
      from,
      to,
      // Evidence: voided scans stay in the list. There is no UI to drop them.
      includeVoided: true,
      ...(employeeId !== "" ? { employeeIds: [employeeId] } : {}),
      ...(deviceId !== "" ? { deviceIds: [deviceId] } : {}),
      ...(source !== "" && isPunchSource(source) ? { sources: [source] } : {}),
      ...(onlyVoided ? { onlyVoided: true } : {}),
      ...(onlyNeedsReview ? { onlyNeedsReview: true } : {}),
    }),
    [from, to, employeeId, deviceId, source, onlyVoided, onlyNeedsReview],
  );

  const log = usePunchLog(filters);
  const total = usePunchLogCount(filters);
  const rows = flattenPunches(log.data);

  const prompt = useReasonPrompt<VoidTarget>();
  const { ask, close: closePrompt, target, isOpen } = prompt;
  const [done, setDone] = useState<string | null>(null);

  const doVoid = useVoidPunch((input) => {
    closePrompt();
    setDone(t("admin.punch.done.voided", { code: input.voidReasonCode }));
  });

  function setParam(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: false });
  }

  const hasNarrowing =
    employeeId !== "" || deviceId !== "" || source !== "" || onlyVoided || onlyNeedsReview;

  const columns: DataGridColumn<PunchRow>[] = useMemo(
    () => [
      {
        key: "punched_at",
        header: t("admin.punch.col.scannedAt"),
        width: "14rem",
        sortable: true,
        sortValue: (row) => row.punched_at,
        render: (row) => (
          <span className={cn("num", row.is_voided && "line-through opacity-60")}>
            {fmtDateTime(row.punched_at)}
          </span>
        ),
      },
      {
        key: "employee",
        header: t("admin.punch.col.employee"),
        width: "14rem",
        sortable: true,
        sortValue: (row) => row.display_name,
        render: (row) => (
          <span className={cn(row.is_voided && "line-through opacity-60")}>
            <PersonCell name={row.display_name} code={row.employee_code} />
          </span>
        ),
      },
      {
        key: "derived_direction",
        header: t("admin.punch.col.direction"),
        width: "10rem",
        render: (row) =>
          row.derived_direction === null ? (
            dash(null)
          ) : (
            <StatusChip status={row.derived_direction} map={DERIVED_CHIP} />
          ),
      },
      {
        key: "direction",
        header: t("admin.punch.col.recordedKind"),
        width: "9rem",
        hideBelow: "lg",
        // What the device claimed. The server's own derivation is the column
        // above; this one is provenance.
        render: (row) => dash(row.direction, punchDirectionLabel),
      },
      {
        key: "source_label",
        header: t("admin.punch.col.source"),
        width: "12rem",
        // The view's own label — never the bare `source` enum (DR-53).
        render: (row) => dash(row.source_label),
      },
      {
        /*
          Gate device, or — for a web punch, which has none — the address it arrived
          from. See migration 080: the IP was recorded all along and no view exposed it.
        */
        key: "device_label",
        header: t("admin.punch.col.device"),
        width: "12rem",
        hideBelow: "md",
        render: (row) =>
          row.device_label !== null
            ? row.device_label
            : row.ip_address !== null
              ? (
                <span className="num text-xs text-muted-foreground" title={t("attendance.day.ipHint")}>
                  {t("attendance.day.ip", { ip: row.ip_address })}
                </span>
              )
              : dash(null),
      },
      {
        /*
          LOCATION. The coordinates were always being captured — a web punch stores
          lat/lng/accuracy and the row schema already carried them — but no column
          ever showed them, so the log looked as though location was not recorded at
          all.

          THIS CELL USED TO SHOW A GEOFENCE VERDICT and no longer does. The verdict
          had two problems: it answered a question nobody could act on ("inside a
          radius somebody configured once?"), and its NULL case — not evaluated,
          which was EVERY punch, because the venue has no coordinates set — sat one
          word away from "outside" in a column a manager skims. A tri-state where
          two of the states look like the same accusation is worse than no column.

          `PunchLocation` replaces it with the thing that was actually wanted: the
          real place name from OpenStreetMap, the coordinate, and the accuracy that
          says how much of the coordinate to believe. `geofence_ok` is still in the
          view and still written — it is simply not drawn here.
        */
        key: "lat",
        header: t("punch.place.column"),
        width: "20rem",
        hideBelow: "lg",
        render: (row) => (
          // `showWhenAbsent` stays on: in an audit log "no location recorded" is
          // itself a fact worth reading, and most kiosk punches have no fix.
          <PunchLocation row={row} variant="inline" />
        ),
      },
      {
        key: "confidence_badge",
        header: t("admin.punch.col.confidence"),
        width: "9rem",
        hideBelow: "lg",
        render: (row) =>
          row.confidence_badge === null ? (
            dash(null)
          ) : (
            <StatusChip status={row.confidence_badge} map={CONFIDENCE_CHIP} />
          ),
      },
      {
        key: "is_voided",
        header: t("admin.punch.col.state"),
        width: "18rem",
        render: (row) => {
          if (!row.is_voided) {
            return row.needs_review ? (
              <StatusChip
                status="needs_review"
                map={{ needs_review: { label: t("admin.punch.state.needsReview"), tone: "warn" } }}
              />
            ) : (
              <StatusChip
                status="live"
                map={{ live: { label: t("admin.punch.state.live"), tone: "success" } }}
              />
            );
          }
          return (
            <span className="flex flex-col gap-1 leading-tight">
              <StatusChip
                status="voided"
                map={{ voided: { label: t("admin.punch.state.voided"), tone: "danger" } }}
              />
              <span className="text-xs text-muted-foreground">
                {row.voided_at === null
                  ? t("admin.punch.voidedNoTime")
                  : t("admin.punch.voidedAt", { at: fmtDateTime(row.voided_at) })}
              </span>
              <span className="break-words text-xs text-muted-foreground">
                {dash(row.void_reason)}
              </span>
            </span>
          );
        },
      },
      {
        key: "actions",
        header: t("admin.punch.col.actions"),
        width: "8rem",
        align: "right",
        render: (row) => {
          if (row.is_voided) {
            return (
              <span className="text-xs text-muted-foreground">
                {t("admin.punch.alreadyVoided")}
              </span>
            );
          }
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={doVoid.isPending}
              onClick={() =>
                ask({
                  punchId: row.id,
                  punchedAt: row.punched_at,
                  voidReasonCode: voidCode,
                  idempotencyKey: newVoidIdempotencyKey(),
                  // Null for an archived employee — the punch survives them, the
                  // label view does not. Voiding is still legitimate (a wrong
                  // scan is wrong whoever it belonged to), so the dialog names
                  // what it can rather than refusing the action.
                  employeeName: row.display_name ?? t("admin.punch.archivedEmployee"),
                  employeeCode: row.employee_code ?? "—",
                  punchedAtLabel: fmtDateTime(row.punched_at),
                })
              }
            >
              {t("admin.punch.action.void")}
            </Button>
          );
        },
      },
    ],
    [ask, doVoid.isPending, voidCode],
  );

  const subtitle = total.isSuccess
    ? t("admin.punch.subtitle.count", { n: formatNumber(total.data) })
    : t("admin.punch.subtitle.plain");

  return (
    <div className="container py-6">
      <PageHeader icon={ScanFace} title={t("admin.punch.title")} subtitle={subtitle} />

      {/* The load-bearing sentence of this screen. Not a tooltip. */}
      <div className="mt-4">
        <Notice tone="info">{t("admin.punch.evidenceNotice")}</Notice>
      </div>

      {/*
        Deliberately NOT in the filter toolbar: this does not change which rows
        are shown, it chooses the machine-readable prefix the NEXT void is filed
        under. Sitting among the filters, it read as one.
      */}
      <div className="mt-3 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
        <SelectField
          label={t("admin.punch.voidCode.label")}
          value={voidCode}
          options={voidCodeChoices}
          onChange={(value) => setVoidCode(value as VoidReasonCode)}
          hint={t("admin.punch.voidCode.hint")}
        />
      </div>

      {done !== null ? (
        <Notice
          tone="success"
          className="mt-3"
          action={
            <Button variant="ghost" size="sm" onClick={() => setDone(null)}>
              {t("admin.common.dismiss")}
            </Button>
          }
        >
          {done}
        </Notice>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={log.isPending}
          error={log.error}
          onRetry={() => void log.refetch()}
          partialError={total.error ?? devices.error ?? labels.error}
          partialLabel={t("admin.punch.partial")}
          skeletonRows={6}
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={PUNCH_LOG_PAGE_SIZE}
            toolbar={
              <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <TextField
                  label={t("admin.common.filter.from")}
                  type="date"
                  value={from}
                  onChange={(value) => setParam("from", value)}
                  hint={t("admin.punch.filter.dateHint")}
                />
                <TextField
                  label={t("admin.common.filter.to")}
                  type="date"
                  value={to}
                  onChange={(value) => setParam("to", value)}
                />
                <SelectField
                  label={t("admin.common.filter.employee")}
                  value={employeeId}
                  options={employeeChoices}
                  placeholder={t("admin.common.filter.allEmployees")}
                  onChange={(value) => setParam("emp", value)}
                  disabled={labels.isLoading}
                />
                <SelectField
                  label={t("admin.punch.filter.device")}
                  value={deviceId}
                  options={asArray(devices.data).map((d) => ({ value: d.id, label: d.label }))}
                  placeholder={t("admin.punch.filter.anyDevice")}
                  onChange={(value) => setParam("device", value)}
                  disabled={devices.isLoading}
                />
                <SelectField
                  label={t("admin.punch.filter.source")}
                  value={source}
                  options={sourceChoices}
                  placeholder={t("admin.punch.filter.anySource")}
                  onChange={(value) => setParam("source", value)}
                />
                <div className="flex flex-wrap items-end gap-2 lg:col-span-2">
                  <Button
                    type="button"
                    variant={onlyVoided ? "default" : "outline"}
                    aria-pressed={onlyVoided}
                    onClick={() => setParam("voided", onlyVoided ? "" : "1")}
                  >
                    {t("admin.punch.filter.onlyVoided")}
                  </Button>
                  <Button
                    type="button"
                    variant={onlyNeedsReview ? "default" : "outline"}
                    aria-pressed={onlyNeedsReview}
                    onClick={() => setParam("review", onlyNeedsReview ? "" : "1")}
                  >
                    {t("admin.punch.filter.onlyReview")}
                  </Button>
                  {hasNarrowing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        const next = new URLSearchParams();
                        next.set("from", from);
                        next.set("to", to);
                        setParams(next, { replace: false });
                      }}
                    >
                      {t("admin.punch.filter.clear")}
                    </Button>
                  ) : null}
                </div>
              </div>
            }
            emptyState={
              <EmptyState
                icon={ScanLine}
                title={t("admin.punch.empty.title")}
                hint={
                  hasNarrowing ? t("admin.punch.empty.filtered") : t("admin.punch.empty.hint")
                }
              />
            }
          />

          {log.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() => void log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
              >
                {log.isFetchingNextPage
                  ? t("admin.punch.loadingMore")
                  : t("admin.punch.loadMore")}
              </Button>
            </div>
          ) : null}
        </StateBoundary>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.punch.footnote")}</p>

      <ReasonDialog
        open={isOpen}
        title={t("admin.punch.dialog.title", {
          name: target?.employeeName ?? "",
          at: target?.punchedAtLabel ?? "",
        })}
        description={t("admin.punch.dialog.description", {
          code: target === null ? "" : voidReasonCodeName(target.voidReasonCode, voidCodeChoices),
        })}
        actorName={employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.punch.action.void")}
        pending={doVoid.isPending}
        errorMessage={doVoid.userMessage}
        onConfirm={(reason) => {
          if (target !== null) doVoid.save(target, reason);
        }}
        onCancel={() => {
          doVoid.reset();
          closePrompt();
        }}
      />
    </div>
  );
}

/** The chosen code's English label, for the dialog's one-line diff preview. */
function voidReasonCodeName(
  code: VoidReasonCode,
  choices: readonly { value: string; label: string }[],
): string {
  return choices.find((c) => c.value === code)?.label ?? code;
}
