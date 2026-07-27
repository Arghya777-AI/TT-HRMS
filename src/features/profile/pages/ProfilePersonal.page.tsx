/**
 * E-07.4 · /me/profile/personal — the personal fields ON the employee record,
 * plus contacts, addresses, dependents, qualifications and identity documents.
 *
 * TWO KINDS OF DATA LIVE ON THIS TAB AND THEY HAVE DIFFERENT EDIT PATHS, so they
 * are in different cards and each says which:
 *
 *  1. COLUMNS ON `employees` — personal email, mobile, religion, category,
 *     differently-abled, uniform size, transport, food preference. Every one is
 *     inside `public.employee_changeable_fields()`, so the employee can propose a
 *     change here, and `food_preference` is one of the four the column-level
 *     `GRANT UPDATE` lets them write outright.
 *  2. THE SATELLITE TABLES — `employee_contacts`, `employee_addresses`,
 *     `employee_dependents`, `employee_qualifications`,
 *     `employee_identity_documents`. NONE of these is in that whitelist, so the
 *     change-request path this file uses does not reach them: `apply_change_request`
 *     needs an `entity_id` and rewrites one column of one EXISTING row, and it
 *     raises outright for a new one ("creating a new % row via change request is
 *     not supported; HR records it directly"). They are a separate editor, not a
 *     variation on this one — `employee_addresses__self_all` /
 *     `employee_contacts__self_all` are `FOR ALL` with `SELECT, INSERT, UPDATE`
 *     granted, so the real path for them is direct row CRUD with its own rules
 *     (exactly one priority-1 contact, nominee shares totalling 100 per scheme).
 *     Those cards are therefore left exactly as they were rather than given a
 *     button this file cannot honour or a note that would misdescribe who owns
 *     them.
 *
 * One fetch behind the satellite cards (`usePersonalRecords` is deliberately a
 * single cache entry), so the emergency contact and the address can never show
 * different vintages of the record.
 *
 * Identity documents show `number_last4` ONLY — the full numbers live on
 * statutory tables this view never returns. Nominee facts (share, scheme) are
 * printed as stored; the PF nominee drives the statutory forms.
 *
 * @route /me/profile/personal
 */
import { HeartHandshake, IdCard, MapPin, Phone, UserRound, Users } from "lucide-react";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtCivilDate } from "@/lib/datetime";
import { dash, formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { FieldGrid, FieldRow, ProfileCard } from "../components/FieldRow";
import { EditableFieldRow, FieldNote } from "../components/EditableFieldRow";
import { useMyProfile, useOrgLabels, usePersonalRecords } from "../hooks/useProfile";
import { useFieldChangeStates } from "../hooks/useSelfEdit";
import type { Address, Contact, Dependent } from "../api/personal.api";

function addressKindLabel(kind: Address["address_kind"]): string {
  switch (kind) {
    case "permanent":
      return t("profile.personal.address.permanent");
    case "correspondence":
      return t("profile.personal.address.correspondence");
    case "emergency":
      return t("profile.personal.address.emergency");
    default:
      return t("profile.personal.address.previous");
  }
}

function contactKindLabel(kind: Contact["contact_kind"]): string {
  switch (kind) {
    case "mobile":
      return t("profile.personal.contact.mobile");
    case "alternate_mobile":
      return t("profile.personal.contact.alternateMobile");
    case "emergency":
      return t("profile.personal.contact.emergency");
    case "whatsapp":
      return t("profile.personal.contact.whatsapp");
    case "residence":
      return t("profile.personal.contact.residence");
    case "office":
      return t("profile.personal.contact.office");
    default:
      return t("profile.personal.contact.extension");
  }
}

function oneLine(address: Address): string {
  return [address.line1, address.line2, address.landmark, address.city, address.state, address.pincode]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(", ");
}

function dependentLine(d: Dependent): string {
  const bits = [d.relationship];
  if (d.date_of_birth !== null) bits.push(fmtCivilDate(d.date_of_birth));
  if (d.is_nominee && d.nominee_scheme !== null) {
    bits.push(
      t("profile.personal.dependents.nominee", {
        scheme: d.nominee_scheme.toUpperCase(),
        share: formatDays(d.nominee_share_pct),
      }),
    );
  }
  return bits.join(" · ");
}

export default function ProfilePersonalPage() {
  const profile = useMyProfile();
  const orgLabels = useOrgLabels();
  const records = usePersonalRecords();
  // One read for the whole tab: a failure to check "is a request already waiting?"
  // is a partial error, never a silent "nothing waiting" on every field.
  const changeStates = useFieldChangeStates();
  const me = profile.data ?? null;
  const partial = records.error ?? changeStates.error;

  return (
    <ProfileShell
      title={t("profile.personal.title")}
      subtitle={t("profile.personal.subtitle")}
      profile={profile.data}
      orgLabels={orgLabels.data}
      loading={profile.isPending}
      error={profile.error}
      onRetry={() => void profile.refetch()}
      {...(partial != null
        ? {
            partialError: partial,
            partialLabel:
              records.error != null
                ? t("profile.personal.partial")
                : t("me.edit.partial.requests"),
          }
        : {})}
    >
      {me !== null ? (
        <ProfileCard
          icon={UserRound}
          title={t("me.edit.card.own.title")}
          description={t("me.edit.card.own.desc")}
          legend
        >
          <FieldNote>{t("me.edit.note.howItWorks")}</FieldNote>
          <FieldNote>{t("me.edit.card.own.scope")}</FieldNote>
          <FieldGrid>
            <EditableFieldRow
              column="personal_email"
              label={t("me.edit.field.personalEmail")}
              profile={me}
              hint={t("me.edit.field.personalEmail.hint")}
            />
            <EditableFieldRow
              column="mobile"
              label={t("me.edit.field.mobile")}
              profile={me}
              value={me.mobile === null ? dash(null) : <span className="num">{me.mobile}</span>}
              hint={t("me.edit.field.mobile.hint")}
            />
            <EditableFieldRow
              column="religion"
              label={t("me.edit.field.religion")}
              profile={me}
            />
            <EditableFieldRow
              column="category"
              label={t("me.edit.field.category")}
              profile={me}
              hint={t("me.edit.field.category.hint")}
            />
            <EditableFieldRow
              column="is_differently_abled"
              label={t("me.edit.field.differentlyAbled")}
              profile={me}
            />
            <EditableFieldRow
              column="disability_type"
              label={t("me.edit.field.disabilityType")}
              profile={me}
              hint={t("me.edit.field.disabilityType.hint")}
            />
            <EditableFieldRow
              column="mode_of_transport"
              label={t("me.edit.field.modeOfTransport")}
              profile={me}
              hint={t("me.edit.field.modeOfTransport.hint")}
            />
            <EditableFieldRow
              column="uniform_size"
              label={t("me.edit.field.uniformSize")}
              profile={me}
              hint={t("me.edit.field.uniformSize.hint")}
            />
            <EditableFieldRow
              column="food_preference"
              label={t("me.edit.field.foodPreference")}
              profile={me}
              hint={t("me.edit.field.foodPreference.hint")}
            />
          </FieldGrid>
        </ProfileCard>
      ) : null}

      <StateBoundary
        loading={records.isPending}
        error={records.error}
        onRetry={() => void records.refetch()}
        skeletonRows={4}
      >
        {/* Emergency first — it is the card that matters at a venue. */}
        <ProfileCard
          icon={Phone}
          title={t("profile.personal.contacts.title")}
          description={t("profile.personal.contacts.hint")}
        >
          {(records.data?.contacts ?? []).length === 0 ? (
            <EmptyState
              icon={Phone}
              title={t("profile.personal.contacts.empty")}
              hint={t("profile.personal.changeHint")}
            />
          ) : (
            <FieldGrid>
              {(records.data?.contacts ?? []).map((c) => (
                <FieldRow
                  key={c.id}
                  label={contactKindLabel(c.contact_kind)}
                  value={
                    <span className="num">
                      {c.value}
                      {c.contact_name !== null ? (
                        <span className="ml-2 text-muted-foreground">
                          {c.contact_name}
                          {c.relationship !== null ? ` (${c.relationship})` : ""}
                        </span>
                      ) : null}
                    </span>
                  }
                  authority="maker_checker"
                  {...(c.is_primary ? { hint: t("profile.personal.contacts.primary") } : {})}
                />
              ))}
            </FieldGrid>
          )}
        </ProfileCard>

        <ProfileCard
          icon={MapPin}
          title={t("profile.personal.addresses.title")}
          description={t("profile.personal.addresses.hint")}
        >
          {(records.data?.addresses ?? []).length === 0 ? (
            <EmptyState
              icon={MapPin}
              title={t("profile.personal.addresses.empty")}
              hint={t("profile.personal.changeHint")}
            />
          ) : (
            <FieldGrid>
              {(records.data?.addresses ?? [])
                .filter((a) => a.is_current)
                .map((a) => (
                  <FieldRow
                    key={a.id}
                    label={addressKindLabel(a.address_kind)}
                    value={oneLine(a)}
                    authority="maker_checker"
                    wide
                  />
                ))}
            </FieldGrid>
          )}
        </ProfileCard>

        <ProfileCard
          icon={Users}
          title={t("profile.personal.dependents.title")}
          description={t("profile.personal.dependents.hint")}
        >
          {(records.data?.dependents ?? []).length === 0 ? (
            <EmptyState
              icon={Users}
              title={t("profile.personal.dependents.empty")}
              hint={t("profile.personal.changeHint")}
            />
          ) : (
            <FieldGrid>
              {(records.data?.dependents ?? []).map((d) => (
                <FieldRow
                  key={d.id}
                  label={d.full_name}
                  value={dependentLine(d)}
                  authority="maker_checker"
                />
              ))}
            </FieldGrid>
          )}
        </ProfileCard>

        <ProfileCard
          icon={HeartHandshake}
          title={t("profile.personal.qualifications.title")}
          description={t("profile.personal.qualifications.hint")}
        >
          {(records.data?.qualifications ?? []).length === 0 ? (
            <EmptyState
              icon={HeartHandshake}
              title={t("profile.personal.qualifications.empty")}
              hint={t("profile.personal.changeHint")}
            />
          ) : (
            <FieldGrid>
              {(records.data?.qualifications ?? []).map((q) => (
                <FieldRow
                  key={q.id}
                  label={dash(q.degree_or_course)}
                  value={[q.institution, q.end_year !== null ? String(q.end_year) : null]
                    .filter((x): x is string => x !== null && x !== "")
                    .join(" · ")}
                  authority="maker_checker"
                  {...(q.is_highest ? { hint: t("profile.personal.qualifications.highest") } : {})}
                />
              ))}
            </FieldGrid>
          )}
        </ProfileCard>

        <ProfileCard
          icon={IdCard}
          title={t("profile.personal.identity.title")}
          description={t("profile.personal.identity.hint")}
        >
          {(records.data?.identityDocuments ?? []).length === 0 ? (
            <EmptyState
              icon={IdCard}
              title={t("profile.personal.identity.empty")}
              hint={t("profile.personal.identity.emptyHint")}
            />
          ) : (
            <FieldGrid>
              {(records.data?.identityDocuments ?? [])
                .filter((docRow) => docRow.is_current)
                .map((docRow) => (
                  <FieldRow
                    key={docRow.id}
                    label={docRow.document_kind.replace(/_/g, " ")}
                    value={
                      <span className="num">
                        ••••{dash(docRow.number_last4)}
                        {docRow.expiry_date !== null ? (
                          <span className="ml-2 text-muted-foreground">
                            {t("profile.personal.identity.expires", {
                              date: fmtCivilDate(docRow.expiry_date),
                            })}
                          </span>
                        ) : null}
                      </span>
                    }
                    authority="admin_only"
                  />
                ))}
            </FieldGrid>
          )}
        </ProfileCard>
      </StateBoundary>
    </ProfileShell>
  );
}
