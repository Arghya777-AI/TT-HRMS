/**
 * /admin/org/locations — sites (spec-admin §4).
 *
 * The geofence is the field with teeth: it flags web and mobile punches, and it
 * deliberately does NOT apply to the kiosk, because the kiosk is the fence. The
 * time zone is rendered as a derived value — `locations.timezone` is locked to
 * Asia/Kolkata by the schema and offering it as a choice would be a lie.
 *
 * @route /admin/org/locations
 */
import { MapPin } from "lucide-react";
import type { DataGridColumn } from "@/shared/ui/DataGrid";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Location, OrgListFilters } from "../api/org.api";
import {
  useDefaultCompanyId,
  useOrgList,
  useRefOptions,
  type RefOption,
} from "../hooks/useMasters";
import { MasterScreen } from "../components/MasterScreen";
import { refOptions, type FieldGroup } from "../masters/fields";
import { BASE_CREATE_DEFAULTS, identityGroup } from "../masters/common";

function useLocationRows(filters: OrgListFilters) {
  return useOrgList("locations", filters);
}

function nameOf(options: readonly RefOption[] | undefined, id: string | null): string {
  if (id === null) return dash(null);
  return options?.find((option) => option.id === id)?.name ?? dash(null);
}

export default function LocationsPage() {
  const companyId = useDefaultCompanyId();
  const calendars = useRefOptions("holidayCalendars");

  const groups: FieldGroup[] = [
    identityGroup(),
    {
      title: t("admin.org.loc.group.place"),
      fields: [
        { name: "city", label: t("admin.org.loc.field.city"), kind: "text", maxLength: 80 },
        { name: "state", label: t("admin.org.loc.field.state"), kind: "text", maxLength: 80 },
        {
          name: "pincode",
          label: t("admin.org.loc.field.pincode"),
          kind: "text",
          maxLength: 6,
          pattern: { re: /^\d{6}$/, messageKey: "admin.master.err.pattern.pincode" },
        },
        {
          name: "timezone",
          label: t("admin.org.loc.field.timezone"),
          kind: "text",
          help: t("admin.org.loc.help.timezone"),
          derived: true,
        },
        {
          name: "lat",
          label: t("admin.org.loc.field.lat"),
          kind: "decimal",
          help: t("admin.org.loc.help.latlng"),
          min: -90,
          max: 90,
        },
        {
          name: "lng",
          label: t("admin.org.loc.field.lng"),
          kind: "decimal",
          help: t("admin.org.loc.help.latlng"),
          min: -180,
          max: 180,
        },
      ],
    },
    {
      title: t("admin.org.loc.group.rules"),
      fields: [
        {
          name: "geofence_radius_m",
          label: t("admin.org.loc.field.radius"),
          kind: "number",
          help: t("admin.org.loc.help.radius"),
          min: 0,
          max: 20000,
        },
        {
          name: "default_holiday_calendar_id",
          label: t("admin.org.loc.field.calendar"),
          kind: "select",
          help: t("admin.org.loc.help.calendar"),
          options: refOptions(calendars.data),
        },
        {
          name: "is_primary",
          label: t("admin.org.loc.field.isPrimary"),
          kind: "checkbox",
          help: t("admin.org.loc.help.isPrimary"),
        },
      ],
    },
  ];

  const columns: DataGridColumn<Location>[] = [
    {
      key: "city",
      header: t("admin.org.loc.col.city"),
      hideBelow: "md",
      render: (row) => dash(row.city),
    },
    {
      key: "geofence_radius_m",
      header: t("admin.org.loc.col.geofence"),
      width: "9rem",
      align: "right",
      render: (row) =>
        row.geofence_radius_m === null || row.lat === null || row.lng === null
          ? t("admin.org.loc.noGeofence")
          : t("admin.org.loc.metres", { n: row.geofence_radius_m }),
    },
    {
      key: "default_holiday_calendar_id",
      header: t("admin.org.loc.col.calendar"),
      hideBelow: "lg",
      render: (row) => nameOf(calendars.data, row.default_holiday_calendar_id),
    },
    {
      key: "is_primary",
      header: t("admin.org.loc.field.isPrimary"),
      width: "7rem",
      hideBelow: "lg",
      render: (row) => (row.is_primary ? t("admin.master.yes") : t("admin.master.no")),
    },
  ];

  return (
    <MasterScreen<Location>
      icon={MapPin}
      title={t("admin.org.loc.title")}
      subtitle={t("admin.org.loc.subtitle")}
      entityLabel={t("admin.org.loc.entity")}
      entity="locations"
      useRows={useLocationRows}
      partialError={calendars.error ?? undefined}
      partialLabel={t("admin.org.loc.col.calendar")}
      columns={columns}
      groups={groups}
      createDefaults={{ ...BASE_CREATE_DEFAULTS, geofence_radius_m: "250" }}
      needsCompanyId
      companyId={companyId}
      retire="archive"
      derivedDisplay={() => ({ timezone: "Asia/Kolkata" })}
    />
  );
}
