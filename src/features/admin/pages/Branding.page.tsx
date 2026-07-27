/**
 * A-SET-01 · /admin/settings/branding — the palette, display name and asset paths
 * every PDF, email and kiosk skin reads (spec-admin §15.1).
 *
 * `public.settings` rows in `group_name = 'branding'` ARE the brand. Nothing here
 * writes a hex into a component: the documents read these rows, which is the
 * whole point of §15.1's "single source, no hard-coded hex".
 *
 * Every save carries a reason — `settings` is in `audit.reason_required_tables`
 * and `updateSetting` raises the client floor to the fuller D-21 sentence, so a
 * colour change is traceable to a person and a why.
 *
 * The contrast checker reports the WCAG ratio of each brand colour against white
 * and against the ink used for body text. It does NOT block the save: the seeded
 * brand primary (#CE8F6F) is 2.2:1 on white and is a legitimate FILL — refusing
 * it would make the screen unusable against the client's own palette. The verdict
 * says which colours may carry body text, which is the decision that matters.
 *
 * @route /admin/settings/branding
 */
import { useMemo } from "react";
import { Cog, Palette } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { Setting } from "../api/system.api";
import { useSettingMutation, useSettingsGroup } from "../hooks/useSettingsConsole";
import { SettingRow } from "../components/SettingRow";
import { isHexSetting, settingDisplay } from "../setting-value";
import { contrastOf, parseHex } from "../contrast";

const BRANDING_GROUP = "branding";
/** The two backgrounds body text actually sits on in this product. */
const ON_WHITE = "#FFFFFF";
const ON_INK = "#121F38";

export default function BrandingPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");
  const settings = useSettingsGroup(BRANDING_GROUP);
  const save = useSettingMutation();

  const rows = useMemo(() => settings.data ?? [], [settings.data]);
  const colours = useMemo(
    () => rows.filter((s) => isHexSetting(s) && parseHex(settingDisplay(s)) !== null),
    [rows],
  );
  const others = useMemo(() => rows.filter((s) => !isHexSetting(s)), [rows]);

  async function persist(setting: Setting, value: unknown, reason: string): Promise<void> {
    await save.saveAsync({ key: setting.key, value, groupName: BRANDING_GROUP }, reason);
    toast.success(t("admin.settings.row.saved", { label: setting.label }));
  }

  function canEdit(setting: Setting): boolean {
    return setting.is_editable_by_admin || isSuper;
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Palette}
        title={t("admin.settings.branding.title")}
        subtitle={t("admin.settings.branding.subtitle")}
      />

      <StateBoundary
        loading={settings.isLoading}
        error={settings.error ?? undefined}
        onRetry={() => void settings.refetch()}
        isEmpty={settings.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Cog}
            title={t("admin.settings.group.empty.title")}
            hint={t("admin.settings.group.empty.hint")}
          />
        }
        skeletonRows={4}
      >
        <section className="mb-6 rounded-lg border bg-card">
          <h2 className="border-b px-4 py-3 font-display text-base font-semibold">
            {t("admin.settings.branding.palette")}
          </h2>
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {colours.map((setting) => {
              const hex = settingDisplay(setting);
              const onWhite = contrastOf(hex, ON_WHITE);
              const onInk = contrastOf(hex, ON_INK);
              return (
                <div key={setting.id} className="rounded-md border p-3">
                  <div
                    className="mb-2 h-14 w-full rounded"
                    style={{ backgroundColor: hex }}
                    aria-hidden
                  />
                  <p className="text-sm font-medium">{setting.label}</p>
                  <p className="num font-mono text-xs text-muted-foreground">{hex}</p>
                  <dl className="mt-2 space-y-1 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {t("admin.settings.branding.contrastOnWhite")}
                      </dt>
                      <dd>
                        <ContrastBadge
                          ratio={onWhite?.ratio ?? null}
                          passesAA={onWhite?.passesAA ?? false}
                          passesAALarge={onWhite?.passesAALarge ?? false}
                        />
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {t("admin.settings.branding.contrastOnInk")}
                      </dt>
                      <dd>
                        <ContrastBadge
                          ratio={onInk?.ratio ?? null}
                          passesAA={onInk?.passesAA ?? false}
                          passesAALarge={onInk?.passesAALarge ?? false}
                        />
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            {t("admin.settings.branding.contrastNote")}
          </p>
        </section>

        <section className="mb-6 rounded-lg border bg-card">
          <h2 className="border-b px-4 py-3 font-display text-base font-semibold">
            {t("admin.settings.branding.preview")}
          </h2>
          <div className="p-4">
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-5"
              style={{ backgroundColor: brandColour(rows, "branding.primary_hex") ?? undefined }}
            >
              <span className="font-display text-lg font-semibold text-white">
                {brandText(rows, "branding.display_name")}
              </span>
              <span
                className="rounded-md px-4 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: brandColour(rows, "branding.plum_hex") ?? undefined }}
              >
                {t("admin.settings.branding.previewButton")}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("admin.settings.branding.previewHint")}
            </p>
          </div>
        </section>

        <section className="rounded-lg border bg-card">
          <h2 className="border-b px-4 py-3 font-display text-base font-semibold">
            {t("admin.settings.col.setting")}
          </h2>
          {[...colours, ...others].map((setting) => (
            <SettingRow
              key={setting.id}
              setting={setting}
              canEdit={canEdit(setting)}
              onSave={(value, reason) => persist(setting, value, reason)}
            />
          ))}
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            {t("admin.settings.branding.assetsNote")}
          </p>
        </section>
      </StateBoundary>
    </div>
  );
}

function brandColour(rows: readonly Setting[], key: string): string | null {
  const row = rows.find((s) => s.key === key);
  if (row === undefined) return null;
  const hex = settingDisplay(row);
  return parseHex(hex) === null ? null : hex;
}

function brandText(rows: readonly Setting[], key: string): string {
  const row = rows.find((s) => s.key === key);
  return row === undefined ? t("app.name") : settingDisplay(row);
}

function ContrastBadge({
  ratio,
  passesAA,
  passesAALarge,
}: {
  ratio: number | null;
  passesAA: boolean;
  passesAALarge: boolean;
}) {
  if (ratio === null) return <span className="text-muted-foreground">{t("common.empty")}</span>;
  if (passesAA) {
    return (
      <Badge variant="success">{t("admin.settings.branding.contrast.pass", { ratio })}</Badge>
    );
  }
  if (passesAALarge) {
    return (
      <Badge variant="warning">{t("admin.settings.branding.contrast.large", { ratio })}</Badge>
    );
  }
  return <Badge variant="danger">{t("admin.settings.branding.contrast.fail", { ratio })}</Badge>;
}
