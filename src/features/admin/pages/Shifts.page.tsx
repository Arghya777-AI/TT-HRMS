/**
 * /admin/time/shifts — the shift master (spec-admin §6.1).
 *
 * The load-bearing fact on this screen: `duration_minutes` is NOT a free field.
 * `shifts_before_write()` (migration 014) recomputes the wall span as
 * `((end - start) + 1440) % 1440` (a zero span meaning a 24-hour shift) and
 * raises 23514 unless `duration_minutes = span - unpaid_break_minutes`. So the
 * form renders paid duration as a derived value, states the rule in words with
 * the admin's own numbers, and sends exactly what the database is about to
 * compute. The same arithmetic in the same order — not an approximation of it.
 *
 * `crosses_midnight` is a GENERATED column and is likewise shown, never sent.
 * The 22:00–06:30 night shift is ONE attendance day filed under its start date
 * (D-15), which is why that sentence is in the form and not in a wiki.
 *
 * @route /admin/time/shifts
 */
import { Clock } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { fmtCivilTime, fmtDurationHm } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { minutesOfTime, paidDurationMinutes, wallSpanMinutes } from "../shiftTiming";
import type { OrgListFilters, Shift } from "../api/org.api";
import { useDefaultCompanyId, useOrgList } from "../hooks/useMasters";
import { MasterBanner, MasterScreen } from "../components/MasterScreen";
import { COLOUR_PATTERN, type FieldGroup, type FormValues } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useShiftRows(filters: OrgListFilters) {
  return useOrgList("shifts", filters);
}

/** 'HH:mm' → minutes past midnight, or null when it is not a wall-clock time. */
function intOf(value: string | undefined): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(n) ? n : 0;
}

/** `FormValues` adapter for the shared span rule. */
function wallSpan(values: FormValues): number | null {
  return wallSpanMinutes(values["start_time"] ?? "", values["end_time"] ?? "");
}

/**
 * The paid length, from the shared rule in `../shiftTiming`.
 *
 * The arithmetic used to live here privately. It now has a second caller — the per-employee
 * shift card, which creates a shift from typed timings — and `duration_minutes` is NOT NULL
 * with no default, so two copies of "a window ending where it starts is a full day" was one
 * copy too many.
 */
function paidDuration(values: FormValues): number | null {
  return paidDurationMinutes(
    values["start_time"] ?? "",
    values["end_time"] ?? "",
    intOf(values["unpaid_break_minutes"]),
  );
}

export default function ShiftsPage() {
  const companyId = useDefaultCompanyId();

  const groups: FieldGroup[] = [
    identityGroup(),
    {
      title: t("admin.time.shift.group.window"),
      fields: [
        {
          name: "start_time",
          label: t("admin.time.shift.field.startTime"),
          kind: "time",
          help: t("admin.time.shift.help.startTime"),
          required: true,
        },
        {
          name: "end_time",
          label: t("admin.time.shift.field.endTime"),
          kind: "time",
          help: t("admin.time.shift.help.endTime"),
          required: true,
        },
        {
          name: "crosses_midnight",
          label: t("admin.time.shift.field.crossesMidnight"),
          kind: "text",
          help: t("admin.time.shift.help.crossesMidnight"),
          derived: true,
        },
      ],
    },
    {
      title: t("admin.time.shift.group.breaks"),
      fields: [
        {
          name: "unpaid_break_minutes",
          label: t("admin.time.shift.field.unpaidBreak"),
          kind: "number",
          help: t("admin.time.shift.help.unpaidBreak"),
          required: true,
          min: 0,
          max: 720,
        },
        {
          name: "paid_break_minutes",
          label: t("admin.time.shift.field.paidBreak"),
          kind: "number",
          help: t("admin.time.shift.help.paidBreak"),
          min: 0,
          max: 720,
        },
        {
          name: "duration_minutes",
          label: t("admin.time.shift.field.duration"),
          kind: "text",
          derived: true,
          wide: true,
        },
      ],
    },
    {
      title: t("admin.time.shift.group.grace"),
      fields: [
        {
          name: "grace_in_minutes",
          label: t("admin.time.shift.field.graceIn"),
          kind: "number",
          help: t("admin.time.shift.help.graceIn"),
          required: true,
          min: 0,
          max: 240,
        },
        {
          name: "grace_out_minutes",
          label: t("admin.time.shift.field.graceOut"),
          kind: "number",
          help: t("admin.time.shift.help.graceOut"),
          required: true,
          min: 0,
          max: 240,
        },
      ],
    },
    {
      title: t("admin.time.shift.group.thresholds"),
      fields: [
        {
          name: "absent_below_minutes",
          label: t("admin.time.shift.field.absentBelow"),
          kind: "number",
          help: t("admin.time.shift.help.absentBelow"),
          required: true,
          min: 0,
          max: 1440,
        },
        {
          name: "half_day_minutes",
          label: t("admin.time.shift.field.halfDay"),
          kind: "number",
          help: t("admin.time.shift.help.halfDay"),
          required: true,
          min: 0,
          max: 1440,
        },
        {
          name: "full_day_minutes",
          label: t("admin.time.shift.field.fullDay"),
          kind: "number",
          help: t("admin.time.shift.help.fullDay"),
          required: true,
          min: 0,
          max: 1440,
        },
        {
          name: "min_minutes_for_present",
          label: t("admin.time.shift.field.minPresent"),
          kind: "number",
          help: t("admin.time.shift.help.minPresent"),
          required: true,
          min: 0,
          max: 1440,
        },
        {
          name: "ot_threshold_minutes",
          label: t("admin.time.shift.field.otThreshold"),
          kind: "number",
          help: t("admin.time.shift.help.otThreshold"),
          required: true,
          min: 0,
          max: 480,
        },
      ],
    },
    {
      title: t("admin.time.shift.group.night"),
      fields: [
        {
          name: "night_shift",
          label: t("admin.time.shift.field.nightShift"),
          kind: "checkbox",
          help: t("admin.time.shift.help.nightShift"),
        },
        {
          name: "day_cutover_time",
          label: t("admin.time.shift.field.dayCutover"),
          kind: "time",
          help: t("admin.time.shift.help.dayCutover"),
          required: true,
        },
        {
          name: "colour_hex",
          label: t("admin.time.shift.field.colour"),
          kind: "colour",
          help: t("admin.time.shift.help.colour"),
          pattern: COLOUR_PATTERN,
        },
      ],
    },
  ];

  const columns: DataGridColumn<Shift>[] = [
    {
      key: "window",
      header: t("admin.time.shift.col.window"),
      width: "13rem",
      render: (row) => {
        const end = fmtCivilTime(row.end_time);
        return (
          <span className="num">
            {fmtCivilTime(row.start_time)} –{" "}
            {row.crosses_midnight ? t("admin.time.shift.nextDay", { time: end }) : end}
          </span>
        );
      },
    },
    {
      key: "duration_minutes",
      header: t("admin.time.shift.col.duration"),
      width: "9rem",
      align: "right",
      render: (row) => fmtDurationHm(row.duration_minutes),
    },
    {
      key: "unpaid_break_minutes",
      header: t("admin.time.shift.col.break"),
      width: "8rem",
      align: "right",
      hideBelow: "md",
      render: (row) => fmtDurationHm(row.unpaid_break_minutes),
    },
    /*
      GRACE IS NO LONGER HIDDEN BELOW `lg`. It is one of the two numbers an
      administrator opens this screen to check — "9:30, and five minutes' grace" — and
      hiding it on every tablet and half-width laptop window is why it read as missing.
      Rendered with its units and direction rather than `5 / 10`, which required knowing
      the column order to interpret.
    */
    {
      key: "grace",
      header: t("admin.time.shift.col.grace"),
      width: "11rem",
      align: "right",
      render: (row) => (
        <span className="num whitespace-nowrap">
          {t("admin.time.grace.inOut", {
            in: String(row.grace_in_minutes),
            out: String(row.grace_out_minutes),
          })}
        </span>
      ),
    },
    {
      key: "thresholds",
      header: t("admin.time.shift.col.thresholds"),
      width: "11rem",
      align: "right",
      hideBelow: "lg",
      render: (row) =>
        `${row.absent_below_minutes} / ${row.half_day_minutes} / ${row.full_day_minutes}`,
    },
    {
      key: "night_shift",
      header: t("admin.time.shift.col.night"),
      width: "6rem",
      hideBelow: "lg",
      render: (row) => (row.night_shift ? t("admin.master.yes") : t("admin.master.no")),
    },
  ];

  return (
    <MasterScreen<Shift>
      icon={Clock}
      title={t("admin.time.shift.title")}
      subtitle={t("admin.time.shift.subtitle")}
      entityLabel={t("admin.time.shift.entity")}
      entity="shifts"
      useRows={useShiftRows}
      columns={columns}
      groups={groups}
      createDefaults={{
        ...BASE_CREATE_DEFAULTS,
        start_time: "09:30",
        end_time: "18:30",
        unpaid_break_minutes: "60",
        paid_break_minutes: "0",
        grace_in_minutes: "15",
        grace_out_minutes: "15",
        absent_below_minutes: "120",
        half_day_minutes: "240",
        full_day_minutes: "480",
        min_minutes_for_present: "240",
        ot_threshold_minutes: "30",
        day_cutover_time: "05:00",
        night_shift: "false",
      }}
      needsCompanyId
      companyId={companyId}
      retire="archive"
      promptOnSave
      /*
        The banner now names the precedence, because the grace fields on this form were
        silently outranked. See migration 039100: `attendance_policies.grace_*` was NOT
        NULL DEFAULT 10, so the engine's COALESCE could never fall through to the shift.
      */
      banner={
        <MasterBanner>
          {t("admin.time.shift.banner")} {t("admin.time.grace.precedence")}
        </MasterBanner>
      }
      formBanner={<MasterBanner>{t("admin.time.shift.banner")}</MasterBanner>}
      derivedDisplay={(values) => {
        const duration = paidDuration(values);
        const span = wallSpan(values);
        return {
          duration_minutes: duration === null ? dash(null) : fmtDurationHm(duration),
          crosses_midnight:
            span === null
              ? dash(null)
              : (minutesOfTime(values["end_time"]) ?? 0) <= (minutesOfTime(values["start_time"]) ?? 0)
                ? t("admin.time.shift.crosses.yes")
                : t("admin.time.shift.crosses.no"),
        };
      }}
      helpVars={(values): Record<string, string> => {
        const span = wallSpan(values);
        const duration = paidDuration(values);
        if (span === null || duration === null) return {};
        return {
          duration_minutes: t("admin.time.shift.help.duration", {
            span: fmtDurationHm(span),
            unpaid: fmtDurationHm(intOf(values["unpaid_break_minutes"])),
            duration: fmtDurationHm(duration),
          }),
        };
      }}
      validateForm={(values) => {
        const span = wallSpan(values);
        if (span === null) return t("admin.time.shift.err.window");
        const duration = span - intOf(values["unpaid_break_minutes"]);
        if (duration <= 0) return t("admin.time.shift.err.duration");
        const absent = intOf(values["absent_below_minutes"]);
        const half = intOf(values["half_day_minutes"]);
        const full = intOf(values["full_day_minutes"]);
        // Mirrors ck_shifts__thresholds so the CHECK never has to explain itself.
        if (!(absent <= half && half <= full)) return t("admin.time.shift.err.thresholdOrder");
        return null;
      }}
      buildPayload={(payload, values, mode) => {
        const duration = paidDuration(values);
        if (duration === null) return payload;
        // The DB derives this from the window and the unpaid break; we send the
        // same number so the trigger's equality check passes on the first try.
        // On an edit it must be included whenever it MOVED, even if the field
        // the admin touched was the break rather than the window.
        const unchanged = String(duration) === (values["duration_minutes"] ?? "");
        if (mode === "create" || !unchanged) return { ...payload, duration_minutes: duration };
        return payload;
      }}
    />
  );
}
