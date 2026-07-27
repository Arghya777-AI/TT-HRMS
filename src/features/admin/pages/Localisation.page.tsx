/**
 * A-SET-09 · /admin/settings/localisation — "Languages, formats and the string
 * catalogue" (route manifest), spec-admin §15.8.
 *
 * THERE IS NO `localisation` SETTINGS GROUP, and this screen refuses to fake one.
 * `settings.group_name` carries a CHECK constraint (migration 031 §1) that admits
 * exactly nine values — attendance, payroll, leave, notifications, security, ai,
 * branding, kiosk, system — and `localisation` is not among them. Grepping the
 * deployed migrations for a locale, language, timezone, date-format or currency
 * key returns nothing, and there is no `translations` / `i18n` / string-catalogue
 * table anywhere. So the page is built from what genuinely exists, in three
 * honestly-labelled tiers.
 *
 *  1. FORMATS THE SERVER ENFORCES — real `settings` rows, editable through the
 *     same reason-prompted `SettingRow` as every other settings screen. These are
 *     the rows that decide how a date, a week and a leave year are INTERPRETED by
 *     Postgres: the IST day cutover (which decides which calendar day a 01:30
 *     punch belongs to), the week start, the leave-year start month, and the
 *     notification quiet hours. They are localisation in substance even though
 *     they live in other groups, and the screen says which group each came from
 *     rather than implying a group of its own.
 *  2. CONVENTIONS FIXED IN CODE — the timezone, clock, currency and catalogue are
 *     compile-time constants in `@/lib/datetime` and `@/shared/i18n/en`, not
 *     database rows. They are shown as facts with "not configurable" stated
 *     plainly, because an admin who believes a control exists and finds none has
 *     been misled twice.
 *  3. MISSING — a per-locale string catalogue, additional languages and
 *     admin-editable date/number formats have no backing store at all, so they
 *     get an EmptyState naming the absent table, not a disabled toggle.
 *
 * No count here is a client tally: the catalogue size is `Object.keys` over the
 * compiled dictionary, which is the actual artefact being described, not a
 * server aggregate being approximated.
 *
 * @route /admin/settings/localisation
 */
import { useMemo } from "react";
import { Cog, Globe, Languages } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { IST_TZ } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { en, t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { Notice } from "../components/Notice";
import { SettingRow } from "../components/SettingRow";
import type { Setting } from "../api/system.api";
import { useSettingMutation } from "../hooks/useSettingsConsole";
import { useSettingsByKeys } from "../hooks/useSettingsExtra";

/**
 * The deployed keys that actually govern how this product reads a date, a week
 * and a year. Every one was verified present in migration 046's seed; none is
 * invented, and the screen shows the owning group beside each so nobody thinks a
 * `localisation` group exists.
 */
const FORMAT_KEYS: readonly string[] = [
  "attendance.ist_day_cutover_time",
  "attendance.week_start_dow",
  "leave.year_start_month",
  "notifications.quiet_hours_start",
  "notifications.quiet_hours_end",
  "notifications.digest_hour_ist",
];

/** A convention the code fixes, with the reason it is not a setting. */
interface FixedConvention {
  readonly label: string;
  readonly value: string;
  readonly why: string;
}

export default function LocalisationPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");
  const settings = useSettingsByKeys(FORMAT_KEYS);
  const save = useSettingMutation();

  const rows = useMemo(() => settings.data ?? [], [settings.data]);

  /**
   * The compiled catalogue's size. `en` IS the string catalogue this product
   * ships, so counting its keys describes the real artefact rather than
   * estimating a server-side one.
   */
  const catalogueSize = useMemo(() => Object.keys(en).length, []);

  const conventions = useMemo<readonly FixedConvention[]>(
    () => [
      {
        label: t("admin.localisation.fixed.timezone"),
        value: IST_TZ,
        why: t("admin.localisation.fixed.timezoneWhy"),
      },
      {
        label: t("admin.localisation.fixed.clock"),
        value: t("admin.localisation.fixed.clockValue"),
        why: t("admin.localisation.fixed.clockWhy"),
      },
      {
        label: t("admin.localisation.fixed.currency"),
        value: t("admin.localisation.fixed.currencyValue"),
        why: t("admin.localisation.fixed.currencyWhy"),
      },
      {
        label: t("admin.localisation.fixed.locale"),
        value: t("admin.localisation.fixed.localeValue"),
        why: t("admin.localisation.fixed.localeWhy"),
      },
    ],
    [],
  );

  async function persist(setting: Setting, value: unknown, reason: string): Promise<void> {
    await save.saveAsync({ key: setting.key, value, groupName: setting.group_name }, reason);
    toast.success(t("admin.settings.row.saved", { label: setting.label }));
  }

  function canEdit(setting: Setting): boolean {
    return setting.is_editable_by_admin || isSuper;
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Globe}
        title={t("admin.localisation.title")}
        subtitle={t("admin.localisation.subtitle")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <KpiTile
          label={t("admin.localisation.kpi.locales")}
          value={formatNumber(1)}
          hint={t("admin.localisation.kpi.localesHint")}
        />
        <KpiTile
          label={t("admin.localisation.kpi.strings")}
          value={formatNumber(catalogueSize)}
          hint={t("admin.localisation.kpi.stringsHint")}
        />
        <KpiTile
          label={t("admin.localisation.kpi.timezone")}
          value={IST_TZ}
          hint={t("admin.localisation.kpi.timezoneHint")}
        />
      </div>

      <Notice tone="info" className="mt-4">
        {t("admin.localisation.notice.noGroup")}
      </Notice>

      {/* ── 1. Formats the server enforces ───────────────────────────────── */}
      <section className="mt-6">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.localisation.formats.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("admin.localisation.formats.subtitle")}
        </p>
        <StateBoundary
          loading={settings.isPending}
          error={settings.error}
          onRetry={() => void settings.refetch()}
          isEmpty={settings.isSuccess && rows.length === 0}
          empty={
            <EmptyState
              icon={Cog}
              title={t("admin.localisation.formats.empty.title")}
              hint={t("admin.localisation.formats.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          <div className="rounded-lg border bg-card">
            {rows.map((setting) => (
              <div key={setting.id}>
                <div className="flex items-center gap-2 border-b bg-muted/30 px-4 pt-2">
                  <Badge variant="neutral">
                    {t("admin.localisation.formats.group", { group: setting.group_name })}
                  </Badge>
                </div>
                <SettingRow
                  setting={setting}
                  canEdit={canEdit(setting)}
                  onSave={(value, reason) => persist(setting, value, reason)}
                />
              </div>
            ))}
          </div>
        </StateBoundary>
        {save.userMessage !== null ? (
          <Notice tone="error" className="mt-3">
            {save.userMessage}
          </Notice>
        ) : null}
      </section>

      {/* ── 2. Conventions fixed in code ─────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.localisation.fixed.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("admin.localisation.fixed.subtitle")}
        </p>
        <div className="divide-y rounded-lg border bg-card">
          {conventions.map((row) => (
            <div
              key={row.label}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{row.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{row.why}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="num text-sm">{row.value}</span>
                <Badge variant="neutral">{t("admin.localisation.fixed.notConfigurable")}</Badge>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 3. The string catalogue, which has no backing store ──────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.localisation.catalogue.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("admin.localisation.catalogue.subtitle")}
        </p>
        <EmptyState
          icon={Languages}
          title={t("admin.localisation.catalogue.empty.title")}
          hint={t("admin.localisation.catalogue.empty.hint")}
        />
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.localisation.footnote")}</p>
    </div>
  );
}
