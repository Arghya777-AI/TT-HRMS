/**
 * E-07.5 · /me/profile/custom — the venue-specific fields (uniform size,
 * transport route, meal preference, blood group and whatever HR defines next),
 * and now the place the employee CHANGES the ones that are theirs to change.
 *
 * The authority per field is not a UI decision. `useCustomFields` joins the
 * definitions with this employee's values and `authorityOf(def)` reads the
 * definition's own two booleans:
 *
 *   is_employee_editable = false                   → read-only, padlock
 *   is_employee_editable + requires_approval=false → direct write, tick
 *   is_employee_editable + requires_approval=true  → change request, shield
 *
 * So HR flipping `requires_approval` on `employee_custom_field_defs` moves a
 * field between the two write paths with no code change, and a field HR added
 * this morning appears here with the right control this afternoon.
 *
 * Change requests are read from the SAME `qk.profile.changeRequests` cache entry
 * the History tab uses, so "waiting on HR" here and the row on Tab 8 are one
 * fact. That read is treated as SECONDARY: if it fails, the fields still render
 * behind an honest partial banner rather than the whole tab going red.
 *
 * @route /me/profile/custom
 */
import { Shirt } from "lucide-react";
import { toast } from "sonner";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { ProfileCard } from "../components/FieldRow";
import { CustomFieldEditor } from "../components/CustomFieldEditor";
import { useCustomFields, useMyProfile, useOrgLabels } from "../hooks/useProfile";
import {
  noCustomFieldRequests,
  useCustomFieldRequestStates,
} from "../hooks/useCustomFieldEdit";
import type { CustomFieldRow } from "../api/custom-fields.api";

/**
 * `employee_custom_field_defs.section` is admin free text (NOT NULL DEFAULT
 * 'additional'), so there is no key to look up — humanising it is the only
 * honest option, and printing `logistics` verbatim as a card title is the bare
 * internal code this build does not ship (DR-10).
 */
function sectionLabel(section: string): string {
  const words = section.replace(/[_-]+/g, " ").trim();
  if (words === "") return section;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function ProfileCustomPage() {
  const profile = useMyProfile();
  const orgLabels = useOrgLabels();
  const fields = useCustomFields(profile.data);
  const requests = useCustomFieldRequestStates();

  const rows = fields.data ?? [];
  // Definition order is HR's order — `sort_order` on the def, already applied
  // by the join. Group by the def's section, preserving that order.
  const sections = new Map<string, CustomFieldRow[]>();
  for (const row of rows) {
    const key = row.def.section;
    const list = sections.get(key) ?? [];
    list.push(row);
    sections.set(key, list);
  }
  const sectionEntries = [...sections.entries()];

  return (
    <ProfileShell
      title={t("profile.custom.title")}
      subtitle={t("profile.customEdit.subtitle")}
      profile={profile.data}
      orgLabels={orgLabels.data}
      loading={profile.isPending}
      error={profile.error}
      onRetry={() => void profile.refetch()}
      {...(requests.error !== null ? { partialError: requests.error } : {})}
      partialLabel={t("profile.customEdit.pending.title")}
    >
      <StateBoundary
        loading={fields.isPending}
        error={fields.error}
        onRetry={() => void fields.refetch()}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            icon={Shirt}
            title={t("profile.custom.empty.title")}
            hint={t("profile.custom.empty.hint")}
          />
        }
        skeletonRows={3}
      >
        {sectionEntries.map(([section, list], index) => (
          <ProfileCard
            key={section}
            icon={Shirt}
            title={sectionLabel(section)}
            description={t("profile.customEdit.card.hint")}
            legend={index === 0}
          >
            <div className="divide-y">
              {list.map((row) => (
                <CustomFieldEditor
                  key={row.def.id}
                  row={row}
                  requests={requests.byCode.get(row.def.code) ?? noCustomFieldRequests()}
                  requestsPending={requests.isPending}
                  onSaved={(label) => toast.success(t("profile.customEdit.saved", { label }))}
                  onRequested={(label) =>
                    toast.success(t("profile.customEdit.requested", { label }))
                  }
                />
              ))}
            </div>
          </ProfileCard>
        ))}
      </StateBoundary>
    </ProfileShell>
  );
}
