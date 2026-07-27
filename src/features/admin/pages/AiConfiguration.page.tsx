/**
 * §15.6 · /admin/settings/ai — AI Configuration. Model, scope, budget and
 * guardrails, as they are ACTUALLY enforced by the deployed `ai-agent` function.
 *
 * The single most useful thing this screen can do is tell an administrator WHERE
 * each control lives, because the three homes behave differently:
 *
 *   1. `public.settings`, group `ai` — read by the function on every request:
 *      `ai.monthly_budget_inr` (a missing or non-positive budget is a CLOSED
 *      switch — the assistant refuses rather than spending), `ai.employee_scope_enabled`
 *      (the self-tier gate, default false), `ai.context_views_only` and
 *      `ai.provider`. Editable here, reason-prompted, and super-admin-only where
 *      `is_editable_by_admin` is false.
 *   2. `public.role_capabilities` — who may ask at all: `ai.ask.self`,
 *      `ai.ask.team`, `ai.ask.all`, and `ai.budget.override` (which carries
 *      `requires_step_up`). Seeded and read-only from any client; the matrix is
 *      shown because "AI enabled for managers" means precisely `ai.ask.team`.
 *   3. A FUNCTION SECRET — the model. `ai-agent` resolves
 *      `ANTHROPIC_MODEL || DEFAULT_MODEL`, so no row holds it and no client write
 *      can change it. Printing a hard-coded model name here would be a guess, so
 *      the screen reads the model the LEDGER RECORDS on the most recent call and
 *      says plainly that changing it is a Function-secret deployment, not a save.
 *
 * TWO THINGS THIS SCREEN REFUSES TO IMPLY:
 *   * The two `ai_agent_*` feature flags are DECLARED INTENT, not enforcement:
 *     nothing in `ai-agent` reads `feature_flags`. They are listed with that said
 *     out loud, next to the setting that does the enforcing.
 *   * Monthly INR spend is not shown as a number. `ai_usage_ledger.total_cost_inr`
 *     is `numeric(14,4)` and there is no `v_ai_usage_*` aggregate; adding floating
 *     currency in a browser over one page of rows is how a rounding defect becomes
 *     an invoice dispute. Call COUNTS are server-counted and shown instead.
 *
 * @route /admin/settings/ai
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { BarChart3, Bot, Cog, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtDateTime, fmtCivilMonth } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { t, type MessageKey } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { AppRole, Setting } from "../api/system.api";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SettingRow } from "../components/SettingRow";
import {
  AI_CAPABILITIES,
  AI_FLAG_KEYS,
  AI_SETTINGS_GROUP,
  MODEL_CATALOGUE,
  type AiUsageRow,
} from "../api/ai-config.api";
import {
  useFeatureFlagMutation,
  useFeatureFlags,
  useSettingMutation,
  useSettingsGroup,
} from "../hooks/useSettingsConsole";
import { useRoleCapabilities } from "../hooks/useSettingsExtra";
import {
  currentBillingMonth,
  useAiConversationCounts,
  useAiModelInForce,
  useAiModelUsage,
  useAiRecentUsage,
} from "../hooks/useAiConfig";

/** The scope tiers, and the context view each one is confined to (migration 032). */
const SCOPE_ROWS: readonly {
  readonly tier: string;
  readonly labelKey: MessageKey;
  readonly capability: string;
  readonly view: string;
  readonly noteKey: MessageKey;
}[] = [
  {
    tier: "self",
    labelKey: "admin.aicfg.scope.self",
    capability: "ai.ask.self",
    view: "v_ai_context_employee_self",
    noteKey: "admin.aicfg.scope.selfNote",
  },
  {
    tier: "team",
    labelKey: "admin.aicfg.scope.team",
    capability: "ai.ask.team",
    view: "v_ai_context_team",
    noteKey: "admin.aicfg.scope.teamNote",
  },
  {
    tier: "org",
    labelKey: "admin.aicfg.scope.org",
    capability: "ai.ask.all",
    view: "v_ai_context_org",
    noteKey: "admin.aicfg.scope.orgNote",
  },
];

/** The redaction rules the function applies before anything reaches the model. */
const REDACTION_ROWS: readonly { readonly id: string; readonly whatKey: MessageKey }[] = [
  { id: "aadhaar", whatKey: "admin.aicfg.redact.aadhaar" },
  { id: "pan", whatKey: "admin.aicfg.redact.pan" },
  { id: "bank", whatKey: "admin.aicfg.redact.bank" },
  { id: "biometric", whatKey: "admin.aicfg.redact.biometric" },
  { id: "views", whatKey: "admin.aicfg.redact.views" },
];

const FLAG_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  on: { label: t("admin.aicfg.flag.on"), tone: "info" },
  off: { label: t("admin.aicfg.flag.off"), tone: "neutral" },
  killed: { label: t("admin.aicfg.flag.killed"), tone: "danger" },
};

const ROLE_LABEL: Readonly<Record<AppRole, MessageKey>> = {
  employee: "admin.aicfg.role.employee",
  manager: "admin.aicfg.role.manager",
  admin: "admin.aicfg.role.admin",
  super_admin: "admin.aicfg.role.superAdmin",
};

const ROLE_ORDER: readonly AppRole[] = ["employee", "manager", "admin", "super_admin"];

/** `settings.value` is jsonb; read the budget without coercing across kinds. */
function budgetInr(settings: readonly Setting[]): number | null {
  const row = settings.find((setting) => setting.key === "ai.monthly_budget_inr");
  if (row === undefined) return null;
  if (typeof row.value === "number") return row.value;
  if (typeof row.value === "string" && row.value.trim() !== "") {
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanSetting(settings: readonly Setting[], key: string): boolean | null {
  const row = settings.find((setting) => setting.key === key);
  if (row === undefined) return null;
  return typeof row.value === "boolean" ? row.value : null;
}

export default function AiConfigurationPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");
  const month = currentBillingMonth();

  const settings = useSettingsGroup(AI_SETTINGS_GROUP);
  const save = useSettingMutation();
  const flags = useFeatureFlags();
  const flagToggle = useFeatureFlagMutation();
  const capabilities = useRoleCapabilities();

  const modelUsage = useAiModelUsage(month);
  const modelInForce = useAiModelInForce();
  const conversations = useAiConversationCounts(month);
  const recent = useAiRecentUsage(10);

  const settingRows = useMemo(() => settings.data ?? [], [settings.data]);
  const aiFlags = useMemo(
    () => (flags.data ?? []).filter((flag) => AI_FLAG_KEYS.includes(flag.key as "ai_agent_admin_scope")),
    [flags.data],
  );
  const aiCaps = useMemo(
    () => (capabilities.data ?? []).filter((row) => AI_CAPABILITIES.includes(row.capability as "ai.ask.self")),
    [capabilities.data],
  );

  const budget = budgetInr(settingRows);
  const employeeScopeOn = booleanSetting(settingRows, "ai.employee_scope_enabled");
  const contextViewsOnly = booleanSetting(settingRows, "ai.context_views_only");
  const observedModel = modelInForce.data?.model ?? null;

  async function persist(setting: Setting, value: unknown, reason: string): Promise<void> {
    await save.saveAsync({ key: setting.key, value, groupName: AI_SETTINGS_GROUP }, reason);
    toast.success(t("admin.settings.row.saved", { label: setting.label }));
  }

  function canEdit(setting: Setting): boolean {
    return setting.is_editable_by_admin || isSuper;
  }

  /** Which roles hold which `ai.*` capability — from the deployed matrix. */
  function holdsCap(role: AppRole, capability: string): boolean {
    return aiCaps.some((row) => row.role === role && row.capability === capability);
  }

  function capNeedsStepUp(capability: string): boolean {
    return aiCaps.some((row) => row.capability === capability && row.requires_step_up);
  }

  const usageColumns: DataGridColumn<AiUsageRow>[] = useMemo(
    () => [
      {
        key: "occurred_at",
        header: t("admin.aicfg.usage.col.when"),
        width: "13rem",
        sortable: true,
        render: (row) => <span className="num text-sm">{fmtDateTime(row.occurred_at)}</span>,
      },
      {
        key: "model",
        header: t("admin.aicfg.usage.col.model"),
        width: "12rem",
        render: (row) => <code className="text-xs">{dash(row.model)}</code>,
      },
      {
        key: "feature",
        header: t("admin.aicfg.usage.col.feature"),
        width: "9rem",
        hideBelow: "md",
        render: (row) => (row.feature === null ? dash(null) : <StatusChip status={row.feature} />),
      },
      {
        key: "input_tokens",
        header: t("admin.aicfg.usage.col.inputTokens"),
        align: "right",
        width: "8rem",
        hideBelow: "sm",
        render: (row) => <span className="num">{formatNumber(row.input_tokens)}</span>,
      },
      {
        key: "output_tokens",
        header: t("admin.aicfg.usage.col.outputTokens"),
        align: "right",
        width: "8rem",
        hideBelow: "sm",
        render: (row) => <span className="num">{formatNumber(row.output_tokens)}</span>,
      },
      {
        key: "cache_read_tokens",
        header: t("admin.aicfg.usage.col.cacheTokens"),
        align: "right",
        width: "8rem",
        hideBelow: "lg",
        render: (row) => <span className="num">{formatNumber(row.cache_read_tokens)}</span>,
      },
      {
        key: "total_cost_inr",
        header: t("admin.aicfg.usage.col.cost"),
        align: "right",
        width: "9rem",
        // The row's OWN stored figure, rendered — never a running total.
        render: (row) => (
          <span className="num">{formatINR(row.total_cost_inr, { paise: true })}</span>
        ),
      },
      {
        key: "billing_month",
        header: t("admin.aicfg.usage.col.month"),
        width: "9rem",
        hideBelow: "lg",
        render: (row) => (
          <span className="num">
            {row.billing_month === null ? dash(null) : fmtCivilMonth(row.billing_month)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Sparkles}
        title={t("admin.aicfg.title")}
        subtitle={t("admin.aicfg.subtitle", { month: fmtCivilMonth(month) })}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/analytics/ai">
              <BarChart3 className="mr-2 size-4" aria-hidden />
              {t("admin.aicfg.toUsage")}
            </Link>
          </Button>
        }
      />

      <div className="space-y-2">
        <Notice tone="info">{t("admin.aicfg.intro")}</Notice>
        {!isSuper ? (
          <Notice tone="warning">
            <span className="flex flex-wrap items-center gap-1.5">
              <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
              {t("admin.aicfg.superOnlyHint")}
            </span>
          </Notice>
        ) : null}
      </div>

      {/* ── Where the agent stands right now ───────────────────────────────── */}
      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label={t("admin.aicfg.kpi.budget")}
          value={budget === null ? dash(null) : formatINR(budget)}
          tone={budget !== null && budget > 0 ? "success" : "danger"}
          hint={
            budget !== null && budget > 0
              ? t("admin.aicfg.kpi.budgetHint")
              : t("admin.aicfg.kpi.budgetClosed")
          }
        />
        <KpiTile
          label={t("admin.aicfg.kpi.calls")}
          value={formatNumber(modelUsage.data?.total ?? null)}
          hint={t("admin.aicfg.kpi.callsHint")}
          to="/admin/analytics/ai"
        />
        <KpiTile
          label={t("admin.aicfg.kpi.conversations")}
          value={formatNumber(conversations.data?.total ?? null)}
          hint={t("admin.aicfg.kpi.conversationsHint", {
            self: formatNumber(conversations.data?.self ?? 0),
            team: formatNumber(conversations.data?.team ?? 0),
            org: formatNumber(conversations.data?.org ?? 0),
          })}
        />
        <KpiTile
          label={t("admin.aicfg.kpi.employeeScope")}
          value={
            employeeScopeOn === null
              ? dash(null)
              : employeeScopeOn
                ? t("admin.aicfg.on")
                : t("admin.aicfg.off")
          }
          tone={employeeScopeOn === true ? "info" : "neutral"}
          hint={t("admin.aicfg.kpi.employeeScopeHint")}
        />
      </section>

      {/* ── 1. The settings the function reads ─────────────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aicfg.settings.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.settings.hint")}</p>

        <div className="mt-3">
          <StateBoundary
            loading={settings.isLoading}
            error={settings.error ?? undefined}
            onRetry={() => void settings.refetch()}
            isEmpty={settings.isSuccess && settingRows.length === 0}
            empty={
              <EmptyState
                icon={Cog}
                title={t("admin.aicfg.settings.empty.title")}
                hint={t("admin.aicfg.settings.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            <div className="rounded-lg border bg-card">
              {settingRows.map((setting) => (
                <SettingRow
                  key={setting.id}
                  setting={setting}
                  canEdit={canEdit(setting)}
                  onSave={(value, reason) => persist(setting, value, reason)}
                />
              ))}
            </div>
          </StateBoundary>
          {save.userMessage !== null ? (
            <Notice tone="error" className="mt-3">
              {save.userMessage}
            </Notice>
          ) : null}
        </div>

        <Notice tone="info" className="mt-3">
          {t("admin.aicfg.settings.budgetNote")}
        </Notice>
      </section>

      {/* ── 2. The model ───────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aicfg.model.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.model.hint")}</p>

        <div className="mt-3 rounded-lg border bg-card p-4">
          <StateBoundary
            loading={modelInForce.isLoading}
            error={modelInForce.error ?? undefined}
            onRetry={() => void modelInForce.refetch()}
            isEmpty={modelInForce.isSuccess && modelInForce.data === null}
            empty={
              <EmptyState
                icon={Bot}
                title={t("admin.aicfg.model.noCalls.title")}
                hint={t("admin.aicfg.model.noCalls.hint")}
              />
            }
            skeletonRows={2}
          >
            <p className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="text-muted-foreground">{t("admin.aicfg.model.inForce")}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-medium">
                {dash(observedModel)}
              </code>
              {modelInForce.data?.occurredAt != null ? (
                <span className="num text-xs text-muted-foreground">
                  {t("admin.aicfg.model.lastCall", {
                    when: fmtDateTime(modelInForce.data.occurredAt),
                  })}
                </span>
              ) : null}
              {observedModel !== null &&
              !MODEL_CATALOGUE.some((entry) => entry.model === observedModel) ? (
                <Badge variant="warning">{t("admin.aicfg.model.unpriced")}</Badge>
              ) : null}
            </p>
          </StateBoundary>

          <div className="mt-4 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[14rem]">{t("admin.aicfg.model.col.model")}</TableHead>
                  <TableHead className="text-right">{t("admin.aicfg.model.col.input")}</TableHead>
                  <TableHead className="text-right">{t("admin.aicfg.model.col.output")}</TableHead>
                  <TableHead className="text-right">{t("admin.aicfg.model.col.calls")}</TableHead>
                  <TableHead>{t("admin.aicfg.model.col.notes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {MODEL_CATALOGUE.map((entry) => {
                  const calls =
                    modelUsage.data?.perModel.find((row) => row.model === entry.model)?.calls ?? null;
                  return (
                    <TableRow key={entry.model}>
                      <TableCell className="align-top">
                        <code className="text-xs">{entry.model}</code>
                      </TableCell>
                      <TableCell className="num align-top text-right">
                        {t("admin.aicfg.model.usdPerM", { usd: entry.inputUsdPerMTok })}
                      </TableCell>
                      <TableCell className="num align-top text-right">
                        {t("admin.aicfg.model.usdPerM", { usd: entry.outputUsdPerMTok })}
                      </TableCell>
                      <TableCell className="num align-top text-right">
                        {formatNumber(calls)}
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {entry.isFunctionDefault === true ? (
                            <Badge variant="neutral">{t("admin.aicfg.model.fallback")}</Badge>
                          ) : null}
                          {entry.model === observedModel ? (
                            <Badge variant="success">{t("admin.aicfg.model.observed")}</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <Notice tone="warning" className="mt-3">
            {t("admin.aicfg.model.secretNote")}
          </Notice>
          <Notice tone="info" className="mt-2">
            {t("admin.aicfg.model.perPersonaGap")}
          </Notice>
        </div>
      </section>

      {/* ── 3. Scope and per-role enablement ───────────────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aicfg.scope.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.scope.hint")}</p>

        <div className="mt-3 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[10rem]">{t("admin.aicfg.scope.col.tier")}</TableHead>
                <TableHead className="w-[13rem]">{t("admin.aicfg.scope.col.capability")}</TableHead>
                <TableHead className="w-[16rem]">{t("admin.aicfg.scope.col.view")}</TableHead>
                <TableHead>{t("admin.aicfg.scope.col.note")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SCOPE_ROWS.map((row) => (
                <TableRow key={row.tier}>
                  <TableCell className="align-top font-medium">{t(row.labelKey)}</TableCell>
                  <TableCell className="align-top">
                    <code className="text-xs">{row.capability}</code>
                  </TableCell>
                  <TableCell className="align-top">
                    <code className="num break-words text-xs">{row.view}</code>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(row.noteKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <h3 className="mt-6 text-sm font-medium">{t("admin.aicfg.matrix.heading")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.matrix.hint")}</p>
        <div className="mt-2">
          <StateBoundary
            loading={capabilities.isLoading}
            error={capabilities.error ?? undefined}
            onRetry={() => void capabilities.refetch()}
            isEmpty={capabilities.isSuccess && aiCaps.length === 0}
            empty={
              <EmptyState
                icon={ShieldAlert}
                title={t("admin.aicfg.matrix.empty.title")}
                hint={t("admin.aicfg.matrix.empty.hint")}
              />
            }
            skeletonRows={3}
          >
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[14rem]">
                      {t("admin.aicfg.matrix.col.capability")}
                    </TableHead>
                    {ROLE_ORDER.map((role) => (
                      <TableHead key={role} className="text-center">
                        {t(ROLE_LABEL[role])}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {AI_CAPABILITIES.map((capability) => (
                    <TableRow key={capability}>
                      <TableCell className="align-top">
                        <span className="flex flex-col gap-1">
                          <code className="text-xs">{capability}</code>
                          {capNeedsStepUp(capability) ? (
                            <Badge variant="warning">{t("admin.aicfg.matrix.stepUp")}</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      {ROLE_ORDER.map((role) => (
                        <TableCell key={role} className="text-center align-top">
                          {holdsCap(role, capability) ? (
                            <Badge variant="success">{t("admin.aicfg.matrix.granted")}</Badge>
                          ) : (
                            <span className="text-muted-foreground">{dash(null)}</span>
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </StateBoundary>
        </div>

        <h3 className="mt-6 text-sm font-medium">{t("admin.aicfg.flags.heading")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.flags.hint")}</p>
        <div className="mt-2">
          <StateBoundary
            loading={flags.isLoading}
            error={flags.error ?? undefined}
            onRetry={() => void flags.refetch()}
            isEmpty={flags.isSuccess && aiFlags.length === 0}
            empty={
              <EmptyState
                icon={Cog}
                title={t("admin.aicfg.flags.empty.title")}
                hint={t("admin.aicfg.flags.empty.hint")}
              />
            }
            skeletonRows={2}
          >
            <div className="rounded-lg border bg-card">
              {aiFlags.map((flag) => (
                <div
                  key={flag.id}
                  className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{flag.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{flag.key}</p>
                    {flag.description !== null ? (
                      <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
                        {flag.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusChip
                      status={flag.kill_switch ? "killed" : flag.is_enabled ? "on" : "off"}
                      map={FLAG_CHIP}
                    />
                    {isSuper ? (
                      <ReasonActionButton
                        label={
                          flag.is_enabled
                            ? t("admin.aicfg.flags.disable")
                            : t("admin.aicfg.flags.enable")
                        }
                        minLength={flagToggle.minReasonLength}
                        title={t("admin.aicfg.flags.reason.title", { name: flag.name })}
                        description={t("admin.aicfg.flags.reason.description")}
                        onConfirm={async (reason) => {
                          await flagToggle.saveAsync(
                            { id: flag.id, patch: { is_enabled: !flag.is_enabled } },
                            reason,
                          );
                          toast.success(t("admin.aicfg.flags.saved", { name: flag.name }));
                        }}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("admin.console.superOnly")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </StateBoundary>
          <Notice tone="warning" className="mt-3">
            {t("admin.aicfg.flags.notEnforced")}
          </Notice>
        </div>
      </section>

      {/* ── 4. Guardrails: redaction + what the model never sees ───────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aicfg.guard.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.guard.hint")}</p>
        <ul className="mt-3 space-y-2">
          {REDACTION_ROWS.map((row) => (
            <li key={row.id} className="flex items-start gap-2 rounded-md border bg-card px-3 py-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
              <span className="text-sm">{t(row.whatKey)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          {contextViewsOnly === true
            ? t("admin.aicfg.guard.viewsOnly")
            : t("admin.aicfg.guard.viewsOnlyOff")}
        </p>
        <Notice tone="info" className="mt-3">
          {t("admin.aicfg.guard.retentionGap")}
        </Notice>
      </section>

      {/* ── 5. The ledger: what the agent actually did ─────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aicfg.usage.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aicfg.usage.hint")}</p>
        <div className="mt-3">
          <StateBoundary
            loading={recent.isLoading}
            error={recent.error ?? undefined}
            onRetry={() => void recent.refetch()}
            isEmpty={recent.isSuccess && (recent.data?.length ?? 0) === 0}
            empty={
              <EmptyState
                icon={Bot}
                title={t("admin.aicfg.usage.empty.title")}
                hint={t("admin.aicfg.usage.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            <DataGrid
              columns={usageColumns}
              rows={recent.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
            />
          </StateBoundary>
        </div>
        <Notice tone="info" className="mt-3">
          {t("admin.aicfg.usage.noSumNote")}
        </Notice>
      </section>
    </div>
  );
}
