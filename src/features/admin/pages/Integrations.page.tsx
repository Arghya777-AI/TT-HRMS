/**
 * A-SET-04 · /admin/settings/integrations — "Email, storage and device bridges"
 * (route manifest), spec-admin §15.4.
 *
 * This is the one screen in this group with a real, populated backing table:
 * `public.integrations` (migration 046 §3) ships six rows — Resend, Anthropic,
 * MSG91, the ZKTeco device bridge, RazorpayX and Tally — each carrying its own
 * health projection (`health_status`, `last_success_at`, `last_failure_at`,
 * `failure_count`) written by the edge functions that call out.
 *
 * WHY SHOWING `config` IS NOT A DISCLOSURE. `integrations.config` holds secret
 * NAMES, never secret values: the seeded shape is
 * `{"api_key_secret": "RESEND_API_KEY"}`, and the value behind that name is a
 * Supabase Function secret that lives outside the database entirely. Rendering
 * `RESEND_API_KEY` names a location, not a credential — and `secretNamesOf`
 * exists so this screen never reaches into the jsonb itself and never
 * accidentally prints a field that turns out to hold a token.
 *
 * WRITES ARE THE ENABLE FLAG AND NOTHING ELSE. `integrations__super_admin_write`
 * is the only write policy, so the toggle is super-admin only and says so for an
 * admin rather than letting them meet a 42501. The reason prompt is a product
 * requirement rather than a database one (`integrations` is not in
 * `audit.reason_required_tables`): a silently disabled email provider is how
 * payslip notices stop arriving without anyone noticing for a month.
 *
 * NOT AVAILABLE, and therefore not offered: there is no client path to rotate a
 * credential, send a test call, or view a delivery log. Rotation happens in
 * Function secrets, and no `integration_calls` / delivery-log table is deployed —
 * `last_success_at` and `failure_count` are the whole audit surface a browser has.
 *
 * @route /admin/settings/integrations
 */
import { useMemo } from "react";
import { Cog, Plug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { secretNamesOf, type Integration } from "../api/settings-extra.api";
import { useIntegrationMutation, useIntegrations } from "../hooks/useSettingsExtra";

/** `integrations.health_status` — 'ok' | 'degraded' | 'down' | 'unknown'. */
const HEALTH_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  ok: { label: t("admin.integrations.health.ok"), tone: "success" },
  degraded: { label: t("admin.integrations.health.degraded"), tone: "warn" },
  down: { label: t("admin.integrations.health.down"), tone: "danger" },
  unknown: { label: t("admin.integrations.health.unknown"), tone: "neutral" },
};

/** `integrations.kind` — the deployed CHECK list, in sentence form (D-10). */
const KIND_LABEL = new Map<string, string>([
  ["email", t("admin.integrations.kind.email")],
  ["sms", t("admin.integrations.kind.sms")],
  ["ai", t("admin.integrations.kind.ai")],
  ["biometric_device", t("admin.integrations.kind.biometricDevice")],
  ["banking", t("admin.integrations.kind.banking")],
  ["accounting", t("admin.integrations.kind.accounting")],
  ["calendar", t("admin.integrations.kind.calendar")],
  ["storage", t("admin.integrations.kind.storage")],
]);

export default function IntegrationsPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");
  const integrations = useIntegrations();
  const toggle = useIntegrationMutation();

  const rows = useMemo(() => integrations.data ?? [], [integrations.data]);

  /**
   * Both tiles are sums of the EXACT rows rendered below — the whole table is on
   * screen (the read is capped at 100 and six rows ship), so these are honest
   * counts of what the admin can see, not an approximation of a server aggregate.
   */
  const enabledCount = useMemo(() => rows.filter((r) => r.is_enabled).length, [rows]);
  const failingCount = useMemo(
    () => rows.filter((r) => r.health_status === "down" || r.health_status === "degraded").length,
    [rows],
  );

  async function setEnabled(row: Integration, next: boolean, reason: string): Promise<void> {
    await toggle.saveAsync({ id: row.id, isEnabled: next }, reason);
    toast.success(
      next
        ? t("admin.integrations.enabled", { name: row.name })
        : t("admin.integrations.disabled", { name: row.name }),
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Plug}
        title={t("admin.integrations.title")}
        subtitle={t("admin.integrations.subtitle")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiTile
          label={t("admin.integrations.kpi.configured")}
          value={formatNumber(rows.length)}
          hint={t("admin.integrations.kpi.configuredHint")}
        />
        <KpiTile
          label={t("admin.integrations.kpi.enabled")}
          value={formatNumber(enabledCount)}
          hint={t("admin.integrations.kpi.enabledHint")}
        />
        <KpiTile
          label={t("admin.integrations.kpi.failing")}
          value={formatNumber(failingCount)}
          hint={t("admin.integrations.kpi.failingHint")}
          tone={failingCount > 0 ? "warn" : "neutral"}
        />
      </div>

      <Notice tone="info" className="mt-4">
        {t("admin.integrations.notice.secretNames")}
      </Notice>

      {!isSuper ? (
        <Notice tone="info" className="mt-3">
          {t("admin.integrations.notice.superOnly")}
        </Notice>
      ) : null}

      {toggle.userMessage !== null ? (
        <Notice tone="error" className="mt-3">
          {toggle.userMessage}
        </Notice>
      ) : null}

      <section className="mt-6">
        <StateBoundary
          loading={integrations.isPending}
          error={integrations.error}
          onRetry={() => void integrations.refetch()}
          isEmpty={integrations.isSuccess && rows.length === 0}
          empty={
            <EmptyState
              icon={Cog}
              title={t("admin.integrations.empty.title")}
              hint={t("admin.integrations.empty.hint")}
            />
          }
          skeletonRows={4}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {rows.map((row) => {
              const secrets = secretNamesOf(row.config);
              return (
                <article key={row.id} className="flex flex-col rounded-lg border bg-card">
                  <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
                    <div className="min-w-0">
                      <h3 className="font-display text-base font-semibold">{row.name}</h3>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">{row.code}</span>
                        <span>{KIND_LABEL.get(row.kind) ?? dash(null)}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusChip status={row.health_status} map={HEALTH_CHIP} />
                      <Badge variant={row.is_enabled ? "success" : "neutral"}>
                        {row.is_enabled
                          ? t("admin.integrations.state.on")
                          : t("admin.integrations.state.off")}
                      </Badge>
                    </div>
                  </header>

                  <dl className="grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.lastSuccess")}
                      </dt>
                      <dd className="num">
                        {row.last_success_at === null
                          ? dash(null)
                          : fmtDateTime(row.last_success_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.lastFailure")}
                      </dt>
                      <dd className="num">
                        {row.last_failure_at === null
                          ? dash(null)
                          : fmtDateTime(row.last_failure_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.failures")}
                      </dt>
                      <dd className="num">{formatNumber(row.failure_count)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.rateLimit")}
                      </dt>
                      <dd className="num">
                        {row.rate_limit_per_min === null
                          ? dash(null)
                          : t("admin.integrations.field.perMinute", {
                              n: formatNumber(row.rate_limit_per_min),
                            })}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.baseUrl")}
                      </dt>
                      <dd className="break-all font-mono text-xs">{dash(row.base_url)}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">
                        {t("admin.integrations.field.secretNames")}
                      </dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {secrets.length === 0 && row.webhook_secret_name === null ? (
                          <span className="text-xs text-muted-foreground">
                            {t("admin.integrations.field.noSecrets")}
                          </span>
                        ) : (
                          <>
                            {secrets.map((name) => (
                              <Badge key={name} variant="outline">
                                <span className="font-mono text-xs">{name}</span>
                              </Badge>
                            ))}
                            {row.webhook_secret_name !== null ? (
                              <Badge variant="outline">
                                <span className="font-mono text-xs">
                                  {row.webhook_secret_name}
                                </span>
                              </Badge>
                            ) : null}
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>

                  <footer className="mt-auto flex items-center justify-between gap-2 border-t px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {t("admin.integrations.field.updated", { when: fmtDateTime(row.updated_at) })}
                    </span>
                    <ReasonActionButton
                      label={
                        row.is_enabled
                          ? t("admin.integrations.action.disable")
                          : t("admin.integrations.action.enable")
                      }
                      variant={row.is_enabled ? "destructive" : "default"}
                      minLength={toggle.minReasonLength}
                      disabled={!isSuper}
                      disabledHint={t("admin.integrations.notice.superOnly")}
                      title={
                        row.is_enabled
                          ? t("admin.integrations.disable.title", { name: row.name })
                          : t("admin.integrations.enable.title", { name: row.name })
                      }
                      description={
                        row.is_enabled
                          ? t("admin.integrations.disable.description", { name: row.name })
                          : t("admin.integrations.enable.description", { name: row.name })
                      }
                      onConfirm={(reason) => setEnabled(row, !row.is_enabled, reason)}
                    />
                  </footer>
                </article>
              );
            })}
          </div>
        </StateBoundary>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.integrations.footnote")}</p>
    </div>
  );
}
