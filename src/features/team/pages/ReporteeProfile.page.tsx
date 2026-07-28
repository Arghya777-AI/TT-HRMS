/**
 * /team/people/:employeeCode — Reportee profile. The employee record, filtered
 * to exactly what a manager may see.
 *
 * THE FILTER IS THE VIEW, NOT THIS PAGE
 * -------------------------------------
 * Every field below comes from `v_team_employee_basic`, which IS the §4.6
 * manager column allow-list. Salary, PAN, Aadhaar, bank account, home address
 * and dependents are not masked here — they are NOT IN THE VIEW. That is a
 * stronger guarantee than masking: there is no value in the browser to leak, no
 * network payload to inspect, and consequently NO REVEAL CONTROL on this screen.
 * A manager has no reveal right, so offering a button that would always fail
 * would be worse than not offering one. The screen says so in words at the
 * bottom, because "I couldn't find the salary" and "a manager may not see the
 * salary" are different facts and the second is the true one.
 *
 * `birthday_display` is day+month with no year, rendered by the view exactly so
 * a team can mark a birthday without anybody's age becoming a manager's data.
 *
 * THE TWO SECTIONS MIGRATION 055 MADE POSSIBLE
 * --------------------------------------------
 * Migrations 010/016/034 told readers that managers read `v_team_custom_fields`
 * and `v_team_punches`; neither view was ever created, and until migration 055
 * this page said so in words instead of rendering sections it had no read path
 * for. Both views now exist with the same posture as the allow-list above
 * (`security_barrier`, self OR `app.is_manager_of` OR scoped admin), so:
 *
 *  - RECENT SCANS come from `v_team_punches` — the raw log, minus the gate capture
 *    photo, the IP/user-agent forensics and the face-match distances, which are
 *    not in the view. The SCAN LOCATION is now in it (migration 077): the client
 *    asked for the place a punch was taken to be visible wherever punches appear,
 *    and a manager was the only reader who could not answer the question their own
 *    reportee is most likely to ask them. The view's row predicate is unchanged, so
 *    this is the same audience seeing one more column about the same people — and
 *    the accuracy is shown with the coordinate, never without it.
 *    A window of business dates rather than only today, because
 *    a single day's card is blank for anyone on a weekly off and a blank card
 *    reads as a broken gate. Voided scans are shown, struck through and
 *    labelled: the log is append-only evidence, and hiding a voided scan would
 *    make a correction look like it never happened.
 *  - ADDITIONAL DETAILS come from `v_team_custom_fields`, which exposes a
 *    reportee's NON-PII fields only — the predicate is on the DEFINITION as well
 *    as the row, so a field the designer marked as personal data never reaches a
 *    manager. An empty result is therefore ambiguous in exactly one direction,
 *    and the card states both readings rather than claiming a blank record.
 *
 * WHAT IS STILL NOT HERE AND WHY (deliberate absences, not omissions)
 * ------------------------------------------------------------------
 *  - Attendance history, leave balances, documents. Those are their own routes
 *    (`/team/attendance`, `/team/leave`) with their own server views; a summary
 *    invented here would be a second number able to disagree with them (DR-29).
 *  - Appraisal ratings and goals. No such table exists on this backend at all;
 *    `/team/performance` is where that gap is stated once.
 *
 * The live facts on the page are today's gate row, straight from
 * `v_attendance_today_board` (first scan, last scan, scan count, day status) and
 * the scan log itself. Not one of them is computed here — including the "N
 * scans" beside the log, which is a `count=exact` over the same predicate as the
 * rows.
 *
 * @route /team/people/:employeeCode
 */
import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Briefcase,
  CalendarClock,
  Clock,
  ListTree,
  Mail,
  ScanFace,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { PunchLocation } from "@/shared/ui/PunchLocation";
import { FaceLoginSwitch } from "@/shared/ui/FaceLoginSwitch";
import { useFaceLoginAccess } from "@/features/settings/hooks/useFaceLogin";
import { dash, formatNumber } from "@/lib/format";
import {
  addIstDays,
  fmtCivilDate,
  fmtCivilDayMonthWeekday,
  fmtCivilTime,
  fmtDateTime,
  fmtDurationHm,
  fmtTime,
} from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { Notice } from "@/features/admin/components/Notice";
import { Fact, FactCard, FactGrid, YesNo } from "../components/TeamFacts";
import {
  REPORTEE_SCAN_WINDOW_DAYS,
  useIstToday,
  useMyEmployeeId,
  useReportee,
  useReporteeCustomFields,
  useReporteeEdge,
  useReporteePunchCount,
  useReporteePunches,
  useReporteeToday,
  useShiftMap,
  useTeamMembers,
} from "../hooks/useTeamToday";
import {
  DAY_STATUS_CHIP,
  EMPLOYMENT_STATUS_CHIP,
  EMPLOYMENT_TYPE_LABELS,
  PUNCH_DIRECTION_LABELS,
  PUNCH_SOURCE_LABELS,
  isCarriedCustomFieldType,
  type TeamCustomField,
  type TeamPunch,
} from "../api/team.api";

/**
 * A custom field's value, from whichever typed column the definition put it in.
 *
 * `undefined` lets `<Fact>` render the em dash. The `multi_select` / `file` /
 * `employee_ref` kinds are a DIFFERENT state from "no value": their value lives
 * in `value_json` / `value_document_id`, which the view does not carry, so the
 * card says that instead of showing a dash a manager would read as blank.
 */
function customFieldValue(row: TeamCustomField): ReactNode {
  if (!isCarriedCustomFieldType(row.field_type)) {
    return (
      <span className="text-muted-foreground">{t("teamExtra.reportee.custom.notCarried")}</span>
    );
  }
  if (row.value_text !== null) return row.value_text;
  if (row.value_number !== null) return <span className="num">{formatNumber(row.value_number)}</span>;
  if (row.value_date !== null) return <span className="num">{fmtCivilDate(row.value_date)}</span>;
  if (row.value_boolean !== null) {
    return row.value_boolean ? t("profile.custom.yes") : t("profile.custom.no");
  }
  return undefined;
}

export default function ReporteeProfilePage() {
  const { employeeCode = "" } = useParams<{ employeeCode: string }>();
  const navigate = useNavigate();
  const istDate = useIstToday();
  const myEmployeeId = useMyEmployeeId();

  const reportee = useReportee(employeeCode);
  const member = reportee.data ?? null;
  const employeeId = member?.id ?? null;

  const edge = useReporteeEdge(myEmployeeId, employeeId);
  const today = useReporteeToday(employeeId, istDate);

  /**
   * The scan window: the last `REPORTEE_SCAN_WINDOW_DAYS` business dates ending
   * today. `addIstDays` walks the IST calendar — this is a date range, not a
   * duration, and both bounds go to Postgres as civil dates.
   */
  const scanFrom = useMemo(() => addIstDays(istDate, -(REPORTEE_SCAN_WINDOW_DAYS - 1)), [istDate]);
  const punches = useReporteePunches(employeeId, scanFrom, istDate);
  const punchTotal = useReporteePunchCount(employeeId, scanFrom, istDate);
  const customFields = useReporteeCustomFields(employeeId);
  const scanRows = useMemo(() => punches.data ?? [], [punches.data]);
  const customRows = useMemo(() => customFields.data ?? [], [customFields.data]);

  /**
   * The two manager pointers, resolved to names through the SAME allow-list
   * view. A manager outside the caller's own team is not in it, and the honest
   * render for that is an em dash — never the uuid.
   */
  const managerIds = useMemo(() => {
    const ids: string[] = [];
    if (member?.reporting_manager_id != null) ids.push(member.reporting_manager_id);
    if (member?.dotted_line_manager_id != null) ids.push(member.dotted_line_manager_id);
    return ids;
  }, [member?.reporting_manager_id, member?.dotted_line_manager_id]);
  const managers = useTeamMembers(managerIds);
  const managerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of managers.data ?? []) m.set(row.id, row.display_name);
    return m;
  }, [managers.data]);

  const shiftIds = useMemo(
    () => (member?.shift_id != null ? [member.shift_id] : []),
    [member?.shift_id],
  );
  const shifts = useShiftMap(shiftIds);
  const shift = member?.shift_id != null ? shifts.map.get(member.shift_id) : undefined;

  const gateRow = today.data ?? null;

  const backButton = (
    <Button variant="outline" size="sm" onClick={() => void navigate("/team/people")}>
      <ArrowLeft className="mr-2 size-4" aria-hidden />
      {t("team.reportee.back")}
    </Button>
  );

  /**
   * The scan log's columns. `direction` is PROVENANCE, not the fact that decided
   * the day: the engine takes arrival from the FIRST scan of the business date
   * and departure from the LAST, whatever the gate wrote in this column.
   */
  /*
    The manager's copy of the face sign-in switch. Scoped by the DATABASE: passing this
    reportee's id to `v_face_login_access` returns a row only if the caller is that
    person, their reporting manager, or an admin in scope — so a manager cannot reach
    a switch for somebody outside their team by editing the url.
  */
  const faceAccess = useFaceLoginAccess(employeeId === null ? [] : [employeeId]);
  const faceRow = faceAccess.data?.[0] ?? null;

  const scanColumns: DataGridColumn<TeamPunch>[] = [
    {
      key: "effective_date",
      header: t("teamExtra.reportee.scans.col.date"),
      width: "9rem",
      render: (row) => (
        <span className={cn("num", row.is_voided && "text-muted-foreground line-through")}>
          {fmtCivilDayMonthWeekday(row.effective_date)}
        </span>
      ),
    },
    {
      key: "ist_time_hm",
      header: t("teamExtra.reportee.scans.col.time"),
      width: "7rem",
      // Pre-rendered 'HH:MM' by the view — this page formats no instant.
      render: (row) => (
        <span className={cn("num", row.is_voided && "text-muted-foreground line-through")}>
          {row.ist_time_hm}
        </span>
      ),
    },
    {
      key: "direction",
      header: t("teamExtra.reportee.scans.col.direction"),
      width: "8rem",
      render: (row) => PUNCH_DIRECTION_LABELS[row.direction],
    },
    {
      key: "source",
      header: t("teamExtra.reportee.scans.col.method"),
      hideBelow: "md",
      render: (row) => PUNCH_SOURCE_LABELS[row.source],
    },
    {
      key: "device_label",
      header: t("teamExtra.reportee.scans.col.gate"),
      hideBelow: "lg",
      render: (row) => dash(row.device_label),
    },
    {
      /*
        WHERE, for the manager who will actually be asked about it. Reached the
        team screens in migration 077 — `v_team_punches` had never projected the
        coordinate, so this was the one attendance surface that could not answer
        "was my punch recorded from the right place?".

        `showWhenAbsent={false}`: a manager reading a reportee's scans should see a
        dash where no fix was taken, not a column of "No location recorded" that
        reads as a list of things the person failed to do. Most gate scans have no
        fix at all.
      */
      key: "lat",
      header: t("punch.place.column"),
      hideBelow: "lg",
      render: (row) => <PunchLocation row={row} variant="inline" showWhenAbsent={false} />,
    },
    {
      key: "flags",
      header: t("teamExtra.reportee.scans.col.flags"),
      render: (row) => {
        const flags: string[] = [];
        if (row.is_voided) {
          flags.push(
            row.void_reason === null
              ? t("teamExtra.reportee.scans.flag.voided")
              : t("teamExtra.reportee.scans.flag.voidedWhy", { reason: row.void_reason }),
          );
        }
        if (row.needs_review) flags.push(t("teamExtra.reportee.scans.flag.review"));
        // Two dates the SERVER stored that differ: the scan happened after
        // midnight and the engine filed it under the shift's business date.
        if (row.ist_date !== row.effective_date) {
          flags.push(
            t("teamExtra.reportee.scans.flag.carried", { date: fmtCivilDate(row.ist_date) }),
          );
        }
        return flags.length === 0 ? dash(null) : flags.join(" · ");
      },
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserCog}
        title={member?.display_name ?? t("team.reportee.title")}
        subtitle={
          member !== null
            ? t("team.reportee.subtitle", {
                code: member.employee_code,
                designation: member.designation_name ?? t("common.empty"),
              })
            : t("team.reportee.subtitlePlain")
        }
        actions={backButton}
      />

      <StateBoundary
        loading={reportee.isPending}
        error={reportee.error}
        onRetry={() => void reportee.refetch()}
        skeletonRows={5}
      >
        {member === null ? null : (
          <div className="space-y-4">
            {/* --- Reporting line: the reason this page is visible at all --- */}
            <FactCard
              icon={Users}
              title={t("team.reportee.card.reporting.title")}
              description={t("team.reportee.card.reporting.desc")}
            >
              <FactGrid>
                <Fact
                  label={t("team.reportee.field.reportsToMe")}
                  value={
                    edge.data === null || edge.data === undefined
                      ? undefined
                      : edge.data.is_direct
                        ? t("team.people.depth.direct")
                        : t("team.people.depth.levels", {
                            n: formatNumber(edge.data.depth),
                          })
                  }
                  hint={t("team.reportee.field.reportsToMeHint")}
                />
                <Fact
                  label={t("team.reportee.field.reportingManager")}
                  value={
                    member.reporting_manager_id === null
                      ? undefined
                      : dash(managerNameById.get(member.reporting_manager_id) ?? null)
                  }
                />
                <Fact
                  label={t("team.reportee.field.dottedLine")}
                  value={
                    member.dotted_line_manager_id === null
                      ? undefined
                      : dash(managerNameById.get(member.dotted_line_manager_id) ?? null)
                  }
                  hint={t("team.reportee.field.dottedLineHint")}
                />
              </FactGrid>
            </FactCard>

            {/* --- Today at the gate: the only live numbers on the page --- */}
            <FactCard
              icon={Clock}
              title={t("team.reportee.card.today.title")}
              description={t("team.reportee.card.today.desc")}
              actions={
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/team">{t("team.reportee.openBoard")}</Link>
                </Button>
              }
            >
              <StateBoundary
                loading={today.isPending}
                error={today.error}
                onRetry={() => void today.refetch()}
                skeletonRows={1}
              >
                {gateRow === null ? (
                  <p className="text-sm text-muted-foreground">
                    {t("team.reportee.today.notOnBoard")}
                  </p>
                ) : (
                  <FactGrid>
                    <Fact
                      label={t("team.reportee.field.dayStatus")}
                      value={<StatusChip status={gateRow.status} map={DAY_STATUS_CHIP} />}
                    />
                    <Fact
                      label={t("team.reportee.field.firstScan")}
                      value={<span className="num">{dash(gateRow.first_in_hm)}</span>}
                      hint={t("team.reportee.field.firstScanHint")}
                    />
                    <Fact
                      label={t("team.reportee.field.lastScan")}
                      value={<span className="num">{dash(gateRow.last_out_hm)}</span>}
                      hint={t("team.reportee.field.lastScanHint")}
                    />
                    <Fact
                      label={t("team.reportee.field.scans")}
                      value={<span className="num">{formatNumber(gateRow.punch_count)}</span>}
                      hint={t("team.reportee.field.scansHint")}
                    />
                    <Fact
                      label={t("team.reportee.field.expectedBy")}
                      value={
                        gateRow.expected_by === null ? undefined : (
                          <span className="num">{fmtTime(gateRow.expected_by)}</span>
                        )
                      }
                      hint={t("team.reportee.field.expectedByHint")}
                    />
                    <Fact
                      label={t("team.reportee.field.worked")}
                      value={
                        <span className="num">
                          {gateRow.worked_hm ?? fmtDurationHm(gateRow.worked_minutes)}
                        </span>
                      }
                      hint={t("team.reportee.field.workedHint")}
                    />
                    <Fact
                      label={t("team.reportee.field.late")}
                      value={
                        gateRow.is_late ? (
                          <span className="num text-warning">
                            {fmtDurationHm(gateRow.late_minutes)}
                          </span>
                        ) : (
                          t("team.reportee.field.notLate")
                        )
                      }
                      hint={t("team.reportee.field.lateHint")}
                    />
                  </FactGrid>
                )}
              </StateBoundary>
            </FactCard>

            {/*
              --- Face sign-in, which a manager may set for their own reportee ---

              Rendered only when the database returned a row, which for this url means
              the caller really is this person's reporting manager (or an admin in
              scope). A manager who edits the url to somebody else's code gets no row
              and therefore no control, without this page deciding anything.
            */}
            {faceRow !== null ? <FaceLoginSwitch row={faceRow} audience="other" /> : null}

            {/* --- The raw scan log, minus the forensics the view withholds --- */}
            <FactCard
              icon={ScanFace}
              title={t("teamExtra.reportee.scans.title")}
              description={t("teamExtra.reportee.scans.desc", {
                days: formatNumber(REPORTEE_SCAN_WINDOW_DAYS),
                from: fmtCivilDate(scanFrom),
                to: fmtCivilDate(istDate),
              })}
              actions={
                punchTotal.isSuccess ? (
                  <span className="num text-xs text-muted-foreground">
                    {t("teamExtra.reportee.scans.count", { n: formatNumber(punchTotal.data) })}
                  </span>
                ) : null
              }
            >
              <StateBoundary
                loading={punches.isPending}
                error={punches.error}
                onRetry={() => void punches.refetch()}
                isEmpty={scanRows.length === 0}
                partialError={punchTotal.error}
                partialLabel={t("teamExtra.reportee.scans.partial")}
                empty={
                  <EmptyState
                    icon={ScanFace}
                    title={t("teamExtra.reportee.scans.empty.title")}
                    hint={t("teamExtra.reportee.scans.empty.hint")}
                    action={
                      <Button variant="outline" asChild>
                        <Link to="/team/attendance">{t("teamExtra.reportee.openAttendance")}</Link>
                      </Button>
                    }
                  />
                }
                skeletonRows={3}
              >
                <DataGrid
                  columns={scanColumns}
                  rows={scanRows}
                  rowKey={(row) => row.id}
                  pageSize={25}
                />
              </StateBoundary>
              <Notice tone="info">{t("teamExtra.reportee.scans.notice")}</Notice>
            </FactCard>

            {/* --- Where they sit in the organisation --- */}
            <FactCard
              icon={Briefcase}
              title={t("team.reportee.card.placement.title")}
              description={t("team.reportee.card.placement.desc")}
            >
              <FactGrid>
                <Fact label={t("team.reportee.field.code")} value={<span className="num">{member.employee_code}</span>} />
                <Fact label={t("team.reportee.field.designation")} value={dash(member.designation_name)} />
                <Fact label={t("team.reportee.field.department")} value={dash(member.department_name)} />
                <Fact label={t("team.reportee.field.section")} value={dash(member.section_name)} />
                <Fact label={t("team.reportee.field.grade")} value={dash(member.grade_name)} />
                <Fact label={t("team.reportee.field.location")} value={dash(member.location_name)} />
              </FactGrid>
            </FactCard>

            {/* --- Employment: dates and lifecycle, all server columns --- */}
            <FactCard
              icon={CalendarClock}
              title={t("team.reportee.card.employment.title")}
              description={t("team.reportee.card.employment.desc")}
            >
              <FactGrid>
                <Fact
                  label={t("team.reportee.field.status")}
                  value={
                    <StatusChip status={member.employment_status} map={EMPLOYMENT_STATUS_CHIP} />
                  }
                />
                <Fact
                  label={t("team.reportee.field.type")}
                  value={EMPLOYMENT_TYPE_LABELS[member.employment_type]}
                />
                <Fact
                  label={t("team.reportee.field.joined")}
                  value={<span className="num">{fmtCivilDate(member.date_of_join)}</span>}
                />
                <Fact
                  label={t("team.reportee.field.probation")}
                  value={
                    <YesNo
                      value={member.is_on_probation}
                      yes={t("team.reportee.value.onProbation")}
                      no={t("team.reportee.value.notOnProbation")}
                    />
                  }
                />
                <Fact
                  label={t("team.reportee.field.confirmationDue")}
                  value={
                    member.confirmation_due_date === null ? undefined : (
                      <span className="num">{fmtCivilDate(member.confirmation_due_date)}</span>
                    )
                  }
                  hint={t("team.reportee.field.confirmationDueHint")}
                />
                <Fact
                  label={t("team.reportee.field.birthday")}
                  value={dash(member.birthday_display)}
                  hint={t("team.reportee.field.birthdayHint")}
                />
              </FactGrid>
            </FactCard>

            {/* --- Time rules and the gate --- */}
            <FactCard
              icon={ShieldCheck}
              title={t("team.reportee.card.time.title")}
              description={t("team.reportee.card.time.desc")}
            >
              <FactGrid>
                <Fact
                  label={t("team.reportee.field.shift")}
                  // The shift CODE plus a 24-hour window. `display_label` reads
                  // "G — 09:30 AM to 06:30 PM" and a 12-hour clock is banned.
                  value={shift === undefined ? undefined : `${shift.code} · ${shift.name}`}
                />
                <Fact
                  label={t("team.reportee.field.shiftWindow")}
                  value={
                    shift === undefined ? undefined : (
                      <span className="num">
                        {fmtCivilTime(shift.start_time)}–{fmtCivilTime(shift.end_time)}
                      </span>
                    )
                  }
                  hint={
                    shift?.crosses_midnight === true
                      ? t("team.reportee.field.shiftCrossesMidnight")
                      : undefined
                  }
                />
                <Fact
                  label={t("team.reportee.field.shiftWorker")}
                  value={
                    <YesNo
                      value={member.is_shift_worker}
                      yes={t("team.reportee.value.shiftWorker")}
                      no={t("team.reportee.value.notShiftWorker")}
                    />
                  }
                />
                <Fact
                  label={t("team.reportee.field.otEligible")}
                  value={
                    <YesNo
                      value={member.is_ot_eligible}
                      yes={t("team.reportee.value.otEligible")}
                      no={t("team.reportee.value.notOtEligible")}
                    />
                  }
                  hint={t("team.reportee.field.otEligibleHint")}
                />
                <Fact
                  label={t("team.reportee.field.faceEnrolled")}
                  value={
                    <YesNo
                      value={member.is_face_enrolled}
                      yes={t("team.reportee.value.gateReady")}
                      no={t("team.reportee.value.gateNotEnrolled")}
                    />
                  }
                  hint={t("team.reportee.field.faceEnrolledHint")}
                />
              </FactGrid>
            </FactCard>

            {/* --- Work contact only. Personal address and next of kin are not
                    in the allow-list view. --- */}
            <FactCard
              icon={Mail}
              title={t("team.reportee.card.contact.title")}
              description={t("team.reportee.card.contact.desc")}
            >
              <FactGrid>
                <Fact label={t("team.reportee.field.workEmail")} value={dash(member.work_email)} />
                <Fact
                  label={t("team.reportee.field.mobile")}
                  value={<span className="num">{dash(member.mobile)}</span>}
                />
              </FactGrid>
            </FactCard>

            {/* --- The venue's own fields, PII already excluded by the view --- */}
            <FactCard
              icon={ListTree}
              title={t("teamExtra.reportee.custom.title")}
              description={t("teamExtra.reportee.custom.desc")}
            >
              <StateBoundary
                loading={customFields.isPending}
                error={customFields.error}
                onRetry={() => void customFields.refetch()}
                isEmpty={customRows.length === 0}
                empty={
                  <EmptyState
                    icon={ListTree}
                    title={t("teamExtra.reportee.custom.empty.title")}
                    hint={t("teamExtra.reportee.custom.empty.hint")}
                  />
                }
                skeletonRows={2}
              >
                <FactGrid>
                  {customRows.map((row) => (
                    <Fact
                      key={row.id}
                      label={row.field_label}
                      value={customFieldValue(row)}
                      hint={t("teamExtra.reportee.custom.updated", {
                        when: fmtDateTime(row.updated_at),
                      })}
                    />
                  ))}
                </FactGrid>
              </StateBoundary>
              <Notice tone="info">{t("teamExtra.reportee.custom.notice")}</Notice>
            </FactCard>

            <Notice tone="info">{t("team.reportee.notice.allowList")}</Notice>
            <Notice tone="info">{t("teamExtra.reportee.notice.elsewhere")}</Notice>
          </div>
        )}
      </StateBoundary>
    </div>
  );
}
