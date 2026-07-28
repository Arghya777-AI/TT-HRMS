/**
 * E-07 Tab 2 · /me/profile/employment — the record HR owns, stated plainly.
 *
 * Every field here is ❌ admin-only. That is not a limitation to hide; it is the
 * information the tab exists to convey, so each row carries the marker and the
 * card header carries the legend.
 *
 * Card 2.2 is the reason this tab was rebuilt. The reference product printed:
 *     Late: None1 · Swipe Attendance: SinglePunch · Attendance: None
 *     First Weekly Off: Sunday  Weeks 1,2,3,4,5
 *     Second Weekly Off: Saturday  Weeks 1,2,3,4,5
 *     Pay Period: PP001 · Shift: G --- 09:30 AM - 06:30 PM
 * Not one of those tells an employee when they are late, when they get a day off,
 * or what period their pay covers. Here each is a sentence built by `display.ts`
 * from the policy row: "Sunday every week + 2nd and 4th Saturday",
 * "You are marked late after 10m of grace…", "July 2026 (26 Jun – 25 Jul)".
 *
 * No number on this tab is computed. Durations are server minute columns through
 * `fmtDuration`; the tenure row is deliberately absent because no view exposes it
 * (see the note in the returned build report) rather than being derived here.
 *
 * @route /me/profile/employment
 */
import { AlarmClock, BadgeCheck, Briefcase, CalendarClock, CreditCard, Landmark } from "lucide-react";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtCivilDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { FieldGrid, FieldRow, ProfileCard, SentenceGrid } from "../components/FieldRow";
import {
  earlyExitSentence,
  employmentStatusLabel,
  employmentTypeLabel,
  extraWorkSentence,
  latePolicySentence,
  monthDaysBasisSentence,
  overtimeSentence,
  payPeriodCutoffSentence,
  payPeriodSentence,
  regularizationSentence,
  shiftRulesSentence,
  shiftWindow,
  singlePunchSentence,
  weeklyOffSentence,
} from "../display";
import {
  useCompany,
  useEmploymentPolicies,
  useMyProfile,
  useOrgLabels,
  useSwipeCards,
} from "../hooks/useProfile";
import type { SwipeCard } from "../api/employment.api";

/**
 * Status vocabulary for access cards. DR-37: the reference product showed
 * "Approved" for a physical card, conflating a workflow state with a card state.
 */
const CARD_STATUS_MAP: Record<string, StatusChipEntry> = {
  requested: { label: t("profile.card.requested"), tone: "warn" },
  approved: { label: t("profile.card.approved"), tone: "info" },
  active: { label: t("profile.card.active"), tone: "success" },
  lost: { label: t("profile.card.lost"), tone: "danger" },
  reported_lost: { label: t("profile.card.reportedLost"), tone: "danger" },
  damaged: { label: t("profile.card.damaged"), tone: "danger" },
  returned: { label: t("profile.card.returned"), tone: "neutral" },
  revoked: { label: t("profile.card.revoked"), tone: "neutral" },
};

export default function ProfileEmploymentPage() {
  const profileQuery = useMyProfile();
  const orgQuery = useOrgLabels();
  const profile = profileQuery.data ?? null;
  const policiesQuery = useEmploymentPolicies(profile);
  const companyQuery = useCompany(profile?.company_id ?? null);
  const cardsQuery = useSwipeCards();

  const policies = policiesQuery.data;
  const isContract = profile?.employment_type === "contract";

  const cardColumns: DataGridColumn<SwipeCard>[] = [
    {
      key: "card_number",
      header: t("profile.card.col.number"),
      render: (row) => <span className="font-mono">{row.card_number}</span>,
    },
    {
      key: "status",
      header: t("profile.card.col.status"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={CARD_STATUS_MAP} />,
    },
    {
      key: "issued_on",
      header: t("profile.card.col.issued"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => fmtCivilDate(row.issued_on),
    },
    {
      key: "valid_from",
      header: t("profile.card.col.validFrom"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.valid_from),
    },
    {
      key: "valid_to",
      header: t("profile.card.col.validTo"),
      width: "9rem",
      // DR-19: NULL is "No expiry", never a 01-Jan-3000 sentinel.
      render: (row) => (row.valid_to === null ? t("profile.card.noExpiry") : fmtCivilDate(row.valid_to)),
    },
    {
      key: "remarks",
      header: t("profile.card.col.remarks"),
      hideBelow: "lg",
      render: (row) => dash(row.remarks),
    },
  ];

  return (
    <ProfileShell
      title={t("profile.tab.employment")}
      subtitle={t("profile.employment.subtitle")}
      profile={profile}
      orgLabels={orgQuery.data ?? null}
      loading={profileQuery.isPending}
      error={profileQuery.error}
      onRetry={() => void profileQuery.refetch()}
      {...(companyQuery.error != null
        ? { partialError: companyQuery.error, partialLabel: t("profile.partial.company") }
        : {})}
    >
      {profile ? (
        <>
          {/* ---------------- Card 2.1 — the employment record ---------------- */}
          <ProfileCard
            icon={Briefcase}
            title={t("profile.employment.record.title")}
            description={t("profile.employment.record.desc")}
            legend
          >
            <FieldGrid>
              <FieldRow
                label={t("profile.field.dateOfJoin")}
                value={fmtCivilDate(profile.date_of_join)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.employmentType")}
                value={employmentTypeLabel(profile.employment_type)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.employmentStatus")}
                value={employmentStatusLabel(profile.employment_status)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.grade")}
                value={dash(orgQuery.data?.grade_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.designation")}
                value={dash(orgQuery.data?.designation_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.department")}
                value={dash(orgQuery.data?.department_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.section")}
                value={dash(orgQuery.data?.section_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.location")}
                value={dash(orgQuery.data?.location_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.legalEntity")}
                value={dash(companyQuery.data?.legal_name)}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.probationMonths")}
                value={t("profile.field.probationMonths.value", { count: profile.probation_months })}
                authority="admin_only"
              />
              <FieldRow
                label={t("profile.field.confirmationDue")}
                value={fmtCivilDate(profile.confirmation_due_date)}
                authority="admin_only"
                hint={
                  profile.confirmed_on !== null
                    ? t("profile.field.confirmedOn", { date: fmtCivilDate(profile.confirmed_on) })
                    : t("profile.field.notConfirmedYet")
                }
              />
              <FieldRow
                label={t("profile.field.noticePeriod")}
                value={t("profile.field.noticePeriod.value", { days: profile.notice_period_days })}
                authority="admin_only"
              />
              {isContract ? (
                <>
                  <FieldRow
                    label={t("profile.field.contractStart")}
                    value={fmtCivilDate(profile.contract_start_date)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.contractEnd")}
                    // DR-18: open-ended validity is NULL → "No end date".
                    value={
                      profile.contract_end_date === null
                        ? t("profile.field.contractEnd.none")
                        : fmtCivilDate(profile.contract_end_date)
                    }
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.workOrder")}
                    value={dash(profile.work_order_number)}
                    authority="admin_only"
                  />
                </>
              ) : null}
            </FieldGrid>
          </ProfileCard>

          {/* -------- Card 2.2 — the attendance rules, in plain language -------- */}
          <StateBoundary
            loading={policiesQuery.isPending}
            error={policiesQuery.error}
            onRetry={() => void policiesQuery.refetch()}
            skeletonRows={4}
          >
            <div className="space-y-6">
              <ProfileCard
                icon={CalendarClock}
                title={t("profile.employment.attendance.title")}
                description={t("profile.employment.attendance.desc")}
              >
                <SentenceGrid>
                  <FieldRow
                    label={t("profile.field.shift")}
                    value={shiftWindow(policies?.shift ?? null)}
                    authority="admin_only"
                    hint={shiftRulesSentence(policies?.shift ?? null)}
                  />
                  <FieldRow
                    label={t("profile.field.weeklyOff")}
                    value={weeklyOffSentence(policies?.weeklyOff ?? null)}
                    authority="admin_only"
                    {...(policies?.weeklyOff?.description != null
                      ? { hint: policies.weeklyOff.description }
                      : {})}
                  />
                  <FieldRow
                    label={t("profile.field.holidayCalendar")}
                    value={
                      policies?.holidayCalendar
                        ? t("profile.field.holidayCalendar.value", {
                            name: policies.holidayCalendar.name,
                            year: policies.holidayCalendar.year,
                          })
                        : t("profile.policy.none")
                    }
                    authority="admin_only"
                    {...(policies?.holidayCalendar
                      ? {
                          hint: t("profile.field.holidayCalendar.optional", {
                            count: policies.holidayCalendar.optional_holiday_quota,
                          }),
                        }
                      : {})}
                  />
                  <FieldRow
                    label={t("profile.field.attendancePolicy")}
                    value={dash(policies?.attendancePolicy?.name)}
                    authority="admin_only"
                    {...(policies?.attendancePolicy?.description != null
                      ? { hint: policies.attendancePolicy.description }
                      : {})}
                  />
                </SentenceGrid>
              </ProfileCard>

              <ProfileCard
                icon={AlarmClock}
                title={t("profile.employment.rules.title")}
                description={t("profile.employment.rules.desc")}
              >
                <SentenceGrid>
                  <FieldRow
                    label={t("profile.field.lateRule")}
                    value={latePolicySentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.earlyRule")}
                    value={earlyExitSentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.singlePunchRule")}
                    value={singlePunchSentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.overtimeRule")}
                    value={overtimeSentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.extraWorkRule")}
                    value={extraWorkSentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.correctionRule")}
                    value={regularizationSentence(policies?.attendancePolicy ?? null)}
                    authority="admin_only"
                    hint={
                      profile.attendance_regularize_from !== null
                        ? t("profile.field.correctionRule.from", {
                            date: fmtCivilDate(profile.attendance_regularize_from),
                          })
                        : undefined
                    }
                  />
                  <FieldRow
                    label={t("profile.field.punchMethods")}
                    value={
                      profile.allow_web_punch
                        ? t("profile.field.punchMethods.webAllowed")
                        : t("profile.field.punchMethods.kioskOnly")
                    }
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.otEligible")}
                    value={
                      profile.is_ot_eligible
                        ? t("profile.field.otEligible.yes")
                        : t("profile.field.otEligible.no")
                    }
                    authority="admin_only"
                  />
                </SentenceGrid>
              </ProfileCard>

              {/* ------------- Pay period: cutoff stated, not implied ------------- */}
              <ProfileCard
                icon={Landmark}
                title={t("profile.employment.payPeriod.title")}
                description={t("profile.employment.payPeriod.desc")}
              >
                <SentenceGrid>
                  <FieldRow
                    label={t("profile.field.payPeriod")}
                    value={payPeriodSentence(policies?.payPeriod ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.payPeriodCutoff")}
                    value={payPeriodCutoffSentence(policies?.payPeriod ?? null)}
                    authority="admin_only"
                    hint={t("profile.field.payPeriodCutoff.hint")}
                  />
                  <FieldRow
                    label={t("profile.field.payDaysBasis")}
                    value={monthDaysBasisSentence(policies?.payPeriod ?? null)}
                    authority="admin_only"
                  />
                  <FieldRow
                    label={t("profile.field.attendanceLock")}
                    value={
                      policies?.payPeriod?.attendance_locked_at != null
                        ? t("profile.field.attendanceLock.locked")
                        : t("profile.field.attendanceLock.open")
                    }
                    authority="admin_only"
                    hint={t("profile.field.attendanceLock.hint")}
                  />
                </SentenceGrid>
              </ProfileCard>
            </div>
          </StateBoundary>

          {/* ---------------- Card 2.3 — access cards ---------------- */}
          <ProfileCard
            icon={CreditCard}
            title={t("profile.employment.cards.title")}
            description={t("profile.employment.cards.desc")}
          >
            <StateBoundary
              loading={cardsQuery.isPending}
              error={cardsQuery.error}
              onRetry={() => void cardsQuery.refetch()}
              skeletonRows={2}
            >
              <DataGrid
                columns={cardColumns}
                rows={cardsQuery.data ?? []}
                rowKey={(row) => row.id}
                pageSize={10}
                emptyState={
                  <EmptyState
                    icon={CreditCard}
                    title={t("profile.employment.cards.empty.title")}
                    hint={t("profile.employment.cards.empty.hint")}
                  />
                }
              />
              <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{t("profile.employment.cards.lostHint")}</span>
              </div>
            </StateBoundary>
          </ProfileCard>

          {/*
            Honest note. The spec's Card 2.1 lists a "computed tenure" field; no
            deployed view exposes one, and deriving "2 years 7 months" from
            date_of_join in the browser is exactly the client-side arithmetic this
            build bans. So the join date is shown and the derived figure is not
            invented.
          */}
          <p className="text-xs text-muted-foreground">
            {t("profile.employment.noDerivedNumbers")}
          </p>
        </>
      ) : null}
    </ProfileShell>
  );
}
