/**
 * A-SET-10 · /admin/settings/security — "Session policy, MFA and password rules"
 * (route manifest), spec-admin §15.9.
 *
 * §15.9 asks for a lot that the DEPLOYED schema simply does not expose to a
 * browser, so this screen is split in two on purpose: what is honestly readable,
 * and a named list of what is not. Nothing here is inferred from a plausible
 * default.
 *
 * READABLE:
 *  * `settings` rows in `group_name = 'security'` — the numbers the server
 *    actually reads (idle timeout, password floor, reveal-reason floor, lockout
 *    threshold, signed-URL TTLs, MFA-required flag, export retention). Seven of
 *    the eight carry `is_editable_by_admin = false`, so an admin sees the truth
 *    and no control; `SettingRow` says which and why.
 *  * `sessions_audit` — append-only, admin-readable, written by the edge
 *    functions with the service role. Every posture figure on this page is a
 *    `count=exact` HEAD over it or over `profiles`, never a client tally.
 *  * `profiles` — `is_active` (what the lockout projection in
 *    `sessions_audit_apply_event()` flips at the failed-login threshold),
 *    `must_change_password`, `last_login_at`.
 *  * `webauthn_credentials` — who can sign in without a password. The projection
 *    deliberately omits `credential_id` and `public_key`.
 *
 * NOT READABLE, and therefore not shown as a number:
 *  * `auth.users` and `auth.mfa_factors` are not exposed to a client, so "which
 *    admins have actually enrolled a TOTP factor" cannot be counted here — only
 *    the caller's own factors are visible (`supabase.auth.mfa.listFactors`).
 *    `security.mfa_required_for_admins` is an intent flag, not proof.
 *  * There is no session inventory table, so concurrent-session limits and
 *    remote sign-out have nothing to list; `session_revoked` events are the only
 *    trace.
 *  * No password-history, IP-allowlist, or rate-limit tables are readable
 *    (`app.rate_limit_buckets` is service_role only), and no four-eyes ledger
 *    exists — so §15.9's "every security change = four-eyes + notify all super
 *    admins" is not enforceable from here.
 *
 * Step-up: `settings.security.write` carries `requires_step_up = true` in
 * `role_capabilities`, so the editing controls stay locked until the
 * authenticator code is confirmed through `useStepUp`. Be clear-eyed about what
 * that buys: `settings__admin_write` has no aal2 predicate, so this is the
 * client keeping the product's promise, not the database enforcing it.
 *
 * @route /admin/settings/security
 */
import { useMemo, useState } from "react";
import { KeyRound, Lock, ShieldCheck, Unlock } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { useStepUp } from "@/shared/auth/StepUpDialog";
import { useAuth } from "@/app/auth/AuthProvider";
import { addIstDays, fmtCivilDate, fmtDateTime, istRangeInstantBounds, nowIstDate } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SettingRow } from "../components/SettingRow";
import type { Setting } from "../api/system.api";
import type { Passkey } from "../api/settings-extra.api";
import { useSettingMutation, useSettingsGroup } from "../hooks/useSettingsConsole";
import {
  capRequiresStepUp,
  usePasskeyCount,
  usePasskeys,
  useProfileDirectory,
  useProfilePostureCount,
  useRoleCapabilities,
  useSessionEventCount,
} from "../hooks/useSettingsExtra";

const SECURITY_GROUP = "security";
/** The posture window: 30 IST days ending today. */
const POSTURE_DAYS = 30;

function countFace(q: { data: number | undefined; error: Error | null; isPending: boolean }): string {
  if (q.isPending) return t("app.loading");
  if (q.error !== null) return dash(null);
  return dash(q.data ?? null, formatNumber);
}

export default function SecuritySettingsPage() {
  const { can } = useAuth();
  const isSuper = can("admin.super");

  const window = useMemo(() => {
    const to = nowIstDate();
    const from = addIstDays(to, -(POSTURE_DAYS - 1));
    return { from, to, fromInstant: istRangeInstantBounds(from, to).fromInstant };
  }, []);

  const settings = useSettingsGroup(SECURITY_GROUP);
  const save = useSettingMutation();
  const capabilities = useRoleCapabilities();
  const stepUp = useStepUp();
  const [unlocked, setUnlocked] = useState(false);
  const [stepUpDeclined, setStepUpDeclined] = useState(false);

  const failedLogins = useSessionEventCount("login_failed", window.fromInstant);
  const mfaChallenges = useSessionEventCount("mfa_challenge", window.fromInstant);
  const passkeyUses = useSessionEventCount("passkey_used", window.fromInstant);
  const revocations = useSessionEventCount("session_revoked", window.fromInstant);
  const passwordChanges = useSessionEventCount("password_changed", window.fromInstant);

  const lockedAccounts = useProfilePostureCount("locked");
  const mustChange = useProfilePostureCount("must_change_password");
  const neverSignedIn = useProfilePostureCount("never_logged_in");
  const activePasskeys = usePasskeyCount(true);

  const passkeys = usePasskeys();
  const profiles = useProfileDirectory();

  const needsStepUp = capRequiresStepUp(capabilities.data, "settings.security.write");
  const rows = settings.data ?? [];

  const profileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of profiles.data ?? []) map.set(p.id, p.full_name);
    return map;
  }, [profiles.data]);

  async function unlock(): Promise<void> {
    if (!needsStepUp) {
      setUnlocked(true);
      return;
    }
    const upgraded = await stepUp.ensureAal2();
    setUnlocked(upgraded);
    setStepUpDeclined(!upgraded);
  }

  function canEdit(setting: Setting): boolean {
    if (!isSuper && !setting.is_editable_by_admin) return false;
    return unlocked;
  }

  async function persist(setting: Setting, value: unknown, reason: string): Promise<void> {
    await save.saveAsync({ key: setting.key, value, groupName: SECURITY_GROUP }, reason);
    toast.success(t("admin.settings.row.saved", { label: setting.label }));
  }

  const passkeyColumns: DataGridColumn<Passkey>[] = [
    {
      key: "profile_id",
      header: t("admin.security.passkeys.col.holder"),
      width: "15rem",
      render: (row) => (
        <span className="text-sm">
          {profileNames.get(row.profile_id) ?? t("admin.security.passkeys.unknownHolder")}
        </span>
      ),
    },
    {
      key: "device_label",
      header: t("admin.security.passkeys.col.device"),
      render: (row) => dash(row.device_label),
    },
    {
      key: "purpose",
      header: t("admin.security.passkeys.col.purpose"),
      width: "9rem",
      render: (row) => <span className="font-mono text-xs">{row.purpose}</span>,
    },
    {
      key: "transports",
      header: t("admin.security.passkeys.col.transports"),
      hideBelow: "lg",
      render: (row) =>
        row.transports === null || row.transports.length === 0
          ? dash(null)
          : row.transports.join(", "),
    },
    {
      key: "backup_eligible",
      header: t("admin.security.passkeys.col.backup"),
      align: "center",
      width: "9rem",
      hideBelow: "md",
      render: (row) =>
        row.backup_eligible ? (
          <Badge variant="info">{t("admin.security.passkeys.synced")}</Badge>
        ) : (
          <Badge variant="neutral">{t("admin.security.passkeys.deviceBound")}</Badge>
        ),
    },
    {
      key: "last_used_at",
      header: t("admin.security.passkeys.col.lastUsed"),
      align: "right",
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.last_used_at ?? "",
      render: (row) => (
        <span className="num">{dash(row.last_used_at, (v) => fmtDateTime(v))}</span>
      ),
    },
    {
      key: "revoked_at",
      header: t("admin.security.passkeys.col.state"),
      width: "10rem",
      render: (row) =>
        row.revoked_at === null ? (
          <Badge variant="success">{t("admin.security.passkeys.active")}</Badge>
        ) : (
          <Badge variant="neutral">
            {t("admin.security.passkeys.revokedOn", { when: fmtDateTime(row.revoked_at) })}
          </Badge>
        ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.security.title")}
        subtitle={t("admin.security.subtitle")}
      />

      <p className="mb-3 text-sm text-muted-foreground">
        {t("admin.security.window", {
          from: fmtCivilDate(window.from),
          to: fmtCivilDate(window.to),
        })}
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label={t("admin.security.kpi.failed")}
          value={countFace(failedLogins)}
          hint={t("admin.security.kpi.failedHint")}
          tone={failedLogins.data !== undefined && failedLogins.data > 0 ? "warn" : "neutral"}
        />
        <KpiTile
          label={t("admin.security.kpi.mfa")}
          value={countFace(mfaChallenges)}
          hint={t("admin.security.kpi.mfaHint")}
        />
        <KpiTile
          label={t("admin.security.kpi.passkeyUses")}
          value={countFace(passkeyUses)}
          hint={t("admin.security.kpi.passkeyUsesHint")}
        />
        <KpiTile
          label={t("admin.security.kpi.revocations")}
          value={countFace(revocations)}
          hint={t("admin.security.kpi.revocationsHint")}
        />
        <KpiTile
          label={t("admin.security.kpi.locked")}
          value={countFace(lockedAccounts)}
          hint={t("admin.security.kpi.lockedHint")}
          tone={lockedAccounts.data !== undefined && lockedAccounts.data > 0 ? "danger" : "neutral"}
        />
        <KpiTile
          label={t("admin.security.kpi.mustChange")}
          value={countFace(mustChange)}
          hint={t("admin.security.kpi.mustChangeHint")}
        />
        <KpiTile
          label={t("admin.security.kpi.neverSignedIn")}
          value={countFace(neverSignedIn)}
          hint={t("admin.security.kpi.neverSignedInHint")}
        />
        <KpiTile
          label={t("admin.security.kpi.passkeys")}
          value={countFace(activePasskeys)}
          hint={t("admin.security.kpi.passkeysHint")}
        />
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {t("admin.security.passwordChanges", { n: countFace(passwordChanges) })}
      </p>

      {/* ── Policy rows ──────────────────────────────────────────────────── */}
      <section className="mt-6 rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="font-display text-base font-semibold">
            {t("admin.security.policy.title")}
          </h2>
          {unlocked ? (
            <Badge variant="success">
              <Unlock className="mr-1 h-3 w-3" aria-hidden />
              {t("admin.security.policy.unlocked")}
            </Badge>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void unlock()}>
              <Lock className="mr-2 h-4 w-4" aria-hidden />
              {t("admin.security.policy.unlock")}
            </Button>
          )}
        </div>

        <div className="px-4 py-3">
          <Notice tone="info">{t("admin.security.policy.stepUpNote")}</Notice>
          {stepUpDeclined && !unlocked ? (
            <Notice tone="warning" className="mt-3">
              {t("admin.security.policy.stepUpDeclined")}
            </Notice>
          ) : null}
          {save.userMessage !== null ? (
            <Notice tone="error" className="mt-3">
              {save.userMessage}
            </Notice>
          ) : null}
        </div>

        <StateBoundary
          loading={settings.isLoading}
          error={settings.error ?? undefined}
          onRetry={() => void settings.refetch()}
          isEmpty={settings.isSuccess && rows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={t("admin.security.policy.empty.title")}
              hint={t("admin.security.policy.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          <div>
            {rows.map((setting) => (
              <SettingRow
                key={setting.id}
                setting={setting}
                canEdit={canEdit(setting)}
                onSave={(value, reason) => persist(setting, value, reason)}
              />
            ))}
          </div>
        </StateBoundary>
      </section>

      {/* ── Passkeys ─────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.security.passkeys.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {t("admin.security.passkeys.subtitle")}
        </p>
        <StateBoundary
          loading={passkeys.isPending}
          error={passkeys.error}
          onRetry={() => void passkeys.refetch()}
          isEmpty={passkeys.isSuccess && (passkeys.data?.length ?? 0) === 0}
          partialError={profiles.error}
          partialLabel={t("admin.security.passkeys.partialNames")}
          empty={
            <EmptyState
              icon={KeyRound}
              title={t("admin.security.passkeys.empty.title")}
              hint={t("admin.security.passkeys.empty.hint")}
            />
          }
          skeletonRows={3}
        >
          <DataGrid
            columns={passkeyColumns}
            rows={passkeys.data ?? []}
            rowKey={(row) => row.id}
            pageSize={25}
          />
        </StateBoundary>
      </section>

      {/* ── What this screen cannot tell you ─────────────────────────────── */}
      <section className="mt-8 rounded-lg border bg-card">
        <h2 className="border-b px-4 py-3 font-display text-base font-semibold">
          {t("admin.security.gaps.title")}
        </h2>
        <ul className="list-disc space-y-2 px-8 py-4 text-sm text-muted-foreground">
          <li>{t("admin.security.gaps.mfaEnrolment")}</li>
          <li>{t("admin.security.gaps.sessions")}</li>
          <li>{t("admin.security.gaps.passwordHistory")}</li>
          <li>{t("admin.security.gaps.ipAllowlist")}</li>
          <li>{t("admin.security.gaps.fourEyes")}</li>
          <li>{t("admin.security.gaps.rateLimits")}</li>
        </ul>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.security.footnote")}</p>
      {stepUp.dialog}
    </div>
  );
}
