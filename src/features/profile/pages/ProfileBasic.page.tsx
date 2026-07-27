/**
 * E-07 Tab 1 · /me/profile/basic — identity, skills, interests, reporting line,
 * and the self-service edit path for every identity field the server permits.
 *
 * The authority mix is the content of this tab, and it is now ACTED ON rather
 * than merely labelled. Which mechanism each field uses comes from `self-edit.ts`,
 * which mirrors the migrations:
 *
 *  * `about` is the one field on this tab the database lets the employee write
 *    directly — `GRANT UPDATE (about, photo_path, cover_photo_path,
 *    food_preference)` plus `employees_self_edit_guard`'s identical allow-list.
 *  * Everything else in `public.employee_changeable_fields()` raises a change
 *    request. That INCLUDES `blood_group`, `marital_status`,
 *    `marriage_anniversary` and `preferred_name`, which this page previously
 *    marked "You can edit". No column grant covers those four, so an immediate
 *    save would have been refused with 42501; the marker was a promise the
 *    server never made.
 *  * `employee_code`, `work_email` and the reporting line are outside the
 *    whitelist. They stay visible, keep their lock marker, and now say IN PLACE
 *    who does change them — a field that is read-only for an undisclosed reason
 *    is the thing an employee raises a ticket about.
 *
 * `legal_name` has no column of its own, so it stays a composed read-only line
 * above the three name parts that really are editable.
 *
 * `date_of_birth_actual` is whitelisted by the server and still NOT rendered:
 * DR-51 rejects the reference product's shadow "Original DOB", and offering an
 * editor for it would rebuild exactly that.
 *
 * @route /me/profile/basic
 */
import { Award, Heart, IdCard, Network } from "lucide-react";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtCivilDayMonthWeekday } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { FieldGrid, FieldRow, ProfileCard } from "../components/FieldRow";
import {
  EditableFieldRow,
  FieldNote,
  ReadOnlyFieldRow,
} from "../components/EditableFieldRow";
import { PersonChip } from "../components/PersonChip";
import { relationshipLabel } from "../display";
import { ABOUT_MAX_LENGTH } from "../self-edit";
import {
  useHobbies,
  useMyProfile,
  useOrgLabels,
  useReportingLine,
  useSkills,
} from "../hooks/useProfile";
import { useFieldChangeStates } from "../hooks/useSelfEdit";

/** Legal name from its parts — the DB has no single legal-name column. */
function legalName(parts: {
  first_name: string;
  middle_name: string | null;
  last_name: string;
}): string {
  return [parts.first_name, parts.middle_name, parts.last_name]
    .filter((p): p is string => p !== null && p.trim() !== "")
    .join(" ");
}

export default function ProfileBasicPage() {
  const profileQuery = useMyProfile();
  const orgQuery = useOrgLabels();
  const skillsQuery = useSkills();
  const hobbiesQuery = useHobbies();
  const profile = profileQuery.data ?? null;
  const reportingQuery = useReportingLine(
    profile?.reporting_manager_id ?? null,
    profile?.dotted_line_manager_id ?? null,
  );
  // Read once at page level so a failure to check "is a request already waiting?"
  // is reported as a partial error rather than as twelve confident empty fields.
  const changeStates = useFieldChangeStates();
  const partial = orgQuery.error ?? changeStates.error;

  return (
    <ProfileShell
      title={t("profile.tab.basic")}
      subtitle={t("profile.basic.subtitle")}
      profile={profile}
      orgLabels={orgQuery.data ?? null}
      loading={profileQuery.isPending}
      error={profileQuery.error}
      onRetry={() => void profileQuery.refetch()}
      {...(partial != null
        ? {
            partialError: partial,
            partialLabel:
              orgQuery.error != null
                ? t("profile.partial.orgLabels")
                : t("me.edit.partial.requests"),
          }
        : {})}
    >
      {profile ? (
        <>
          <ProfileCard
            icon={IdCard}
            title={t("profile.basic.identity.title")}
            description={t("profile.basic.identity.desc")}
            legend
          >
            <FieldNote>{t("me.edit.note.howItWorks")}</FieldNote>

            <FieldGrid>
              {/* Composed, not stored — the three parts below are the real fields. */}
              <FieldRow
                label={t("profile.field.legalName")}
                value={legalName(profile)}
                authority="maker_checker"
                hint={t("me.edit.field.legalName.parts")}
                wide
              />
              <EditableFieldRow
                column="title"
                label={t("profile.field.salutation")}
                profile={profile}
              />
              <EditableFieldRow
                column="first_name"
                label={t("me.edit.field.firstName")}
                profile={profile}
              />
              <EditableFieldRow
                column="middle_name"
                label={t("me.edit.field.middleName")}
                profile={profile}
              />
              <EditableFieldRow
                column="last_name"
                label={t("me.edit.field.lastName")}
                profile={profile}
              />
              <EditableFieldRow
                column="display_name"
                label={t("profile.field.displayName")}
                profile={profile}
              />
              <EditableFieldRow
                column="preferred_name"
                label={t("profile.field.preferredName")}
                profile={profile}
              />
              <EditableFieldRow
                column="name_in_local_script"
                label={t("me.edit.field.nameInLocalScript")}
                profile={profile}
              />
              <ReadOnlyFieldRow
                label={t("profile.field.employeeCode")}
                value={<span className="font-mono">{profile.employee_code}</span>}
                ownerNoteKey="me.edit.readOnly.employeeCode"
              />
              <ReadOnlyFieldRow
                label={t("profile.field.workEmail")}
                value={dash(profile.work_email)}
                ownerNoteKey="me.edit.readOnly.workEmail"
              />
              <EditableFieldRow
                column="date_of_birth"
                label={t("profile.field.dob")}
                profile={profile}
                // Day + month only on the row (the year is not printed on a
                // profile surface); the editor shows the full date.
                value={fmtCivilDayMonthWeekday(profile.date_of_birth)}
                hint={t("profile.field.dob.hint")}
              />
              <EditableFieldRow
                column="gender"
                label={t("profile.field.gender")}
                profile={profile}
              />
              <EditableFieldRow
                column="blood_group"
                label={t("profile.field.bloodGroup")}
                profile={profile}
              />
              <EditableFieldRow
                column="marital_status"
                label={t("profile.field.maritalStatus")}
                profile={profile}
              />
              <EditableFieldRow
                column="marriage_anniversary"
                label={t("profile.field.marriageAnniversary")}
                profile={profile}
              />
              <EditableFieldRow
                column="nationality"
                label={t("profile.field.nationality")}
                profile={profile}
              />
              <EditableFieldRow
                column="about"
                label={t("me.edit.field.about")}
                profile={profile}
                value={
                  profile.about !== null && profile.about.trim() !== ""
                    ? profile.about
                    : t("profile.about.empty")
                }
                hint={t("me.edit.field.about.hint", { max: ABOUT_MAX_LENGTH })}
                wide
              />
            </FieldGrid>
          </ProfileCard>

          <div className="grid gap-6 lg:grid-cols-2">
            <ProfileCard
              icon={Award}
              title={t("profile.basic.skills.title")}
              description={t("profile.basic.skills.desc")}
            >
              <StateBoundary
                loading={skillsQuery.isPending}
                error={skillsQuery.error}
                onRetry={() => void skillsQuery.refetch()}
                isEmpty={(skillsQuery.data ?? []).length === 0}
                skeletonRows={2}
                empty={
                  <EmptyState
                    icon={Award}
                    title={t("profile.basic.skills.empty.title")}
                    hint={t("profile.basic.skills.empty.hint")}
                  />
                }
              >
                <ul className="flex flex-wrap gap-2">
                  {(skillsQuery.data ?? []).map((skill) => (
                    <li
                      key={skill.id}
                      className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-sm"
                    >
                      <span>{skill.name}</span>
                      {skill.is_verified ? (
                        <span className="text-xs text-success">{t("profile.skill.verified")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </StateBoundary>
            </ProfileCard>

            <ProfileCard
              icon={Heart}
              title={t("profile.basic.hobbies.title")}
              description={t("profile.basic.hobbies.desc")}
            >
              <StateBoundary
                loading={hobbiesQuery.isPending}
                error={hobbiesQuery.error}
                onRetry={() => void hobbiesQuery.refetch()}
                isEmpty={(hobbiesQuery.data ?? []).length === 0}
                skeletonRows={2}
                empty={
                  <EmptyState
                    icon={Heart}
                    title={t("profile.basic.hobbies.empty.title")}
                    hint={t("profile.basic.hobbies.empty.hint")}
                  />
                }
              >
                <ul className="flex flex-wrap gap-2">
                  {(hobbiesQuery.data ?? []).map((hobby) => (
                    <li
                      key={hobby.id}
                      className="rounded-full border bg-muted/50 px-2.5 py-1 text-sm"
                    >
                      {hobby.name}
                    </li>
                  ))}
                </ul>
              </StateBoundary>
            </ProfileCard>
          </div>

          <ProfileCard
            icon={Network}
            title={t("profile.basic.reporting.title")}
            description={t("profile.basic.reporting.desc")}
          >
            <StateBoundary
              loading={reportingQuery.isPending}
              error={reportingQuery.error}
              onRetry={() => void reportingQuery.refetch()}
              skeletonRows={2}
            >
              <FieldGrid>
                <ReadOnlyFieldRow
                  label={t("profile.field.reportingManager")}
                  ownerNoteKey="me.edit.readOnly.manager"
                  value={
                    <PersonChip
                      person={reportingQuery.data?.manager ?? null}
                      unresolved={reportingQuery.data?.managerUnresolved ?? false}
                    />
                  }
                />
                <ReadOnlyFieldRow
                  label={t("profile.field.dottedLineManager")}
                  ownerNoteKey="me.edit.readOnly.manager"
                  value={
                    <PersonChip
                      person={reportingQuery.data?.dottedLineManager ?? null}
                      unresolved={reportingQuery.data?.dottedLineUnresolved ?? false}
                    />
                  }
                />
                <EditableFieldRow
                  column="father_or_spouse_name"
                  label={t("profile.field.fatherOrSpouse")}
                  profile={profile}
                />
                <EditableFieldRow
                  column="father_or_spouse_relation"
                  label={t("me.edit.field.relation")}
                  profile={profile}
                  value={relationshipLabel(profile.father_or_spouse_relation)}
                />
                <EditableFieldRow
                  column="mother_name"
                  label={t("profile.field.motherName")}
                  profile={profile}
                />
              </FieldGrid>
            </StateBoundary>
          </ProfileCard>
        </>
      ) : null}
    </ProfileShell>
  );
}
