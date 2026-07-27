/**
 * E-18 · /me/settings — the landing for the settings tabs, with the state of
 * each one already on it.
 *
 * NOT A REDIRECT, AND NOT A MENU OF TWO LINKS. Every card states what the server
 * currently holds for that area, so the employee can see whether anything needs
 * attention before opening anything:
 *
 *  * Notifications — how many preference rows exist against my profile and how
 *    many are switched on. Two `count=exact` reads (`fetchSettingsSummaryCounts`),
 *    so this card and `/me/settings/notifications` cannot disagree. Zero rows is
 *    a real state and is described as "every notice follows the company default",
 *    not as "notifications are off".
 *  * Security — active passkeys (`webauthn_credentials WHERE revoked_at IS NULL`,
 *    counted server-side), whether a verified authenticator factor exists (from
 *    GoTrue's own `listFactors`), the newest `sessions_audit` row for my profile,
 *    and the face/consent state from `v_my_biometric_status`. A missing consent
 *    row is shown as "no consent recorded" rather than "not enrolled" — the view
 *    selects FROM the consent table, so absence of consent hides the template
 *    state too.
 *  * My activity — the four counts behind `/me/activity`.
 *  * Notification centre — the unread count, from the notifications domain's own
 *    `useUnreadCount` (a server count), so the card and the top-bar badge agree.
 *
 * Every hook here already existed for the two tabs (`useMeSettings.ts`) or is a
 * count added for this screen (`useMyActivity.ts`); nothing re-reads a table that
 * another settings screen already owns.
 *
 * The footnote is there because the obvious two "settings" a person looks for —
 * language and theme — are NOT account settings in this build: the catalogue is
 * English-only, and the theme toggle in the top bar is per-device. Saying so is
 * cheaper than a dead toggle.
 *
 * @route /me/settings
 */
import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bell, Cog, Fingerprint, Inbox, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useUnreadCount } from "@/features/notifications/hooks/useNotifications";
import {
  useMfaFactors,
  useMyBiometricStatus,
  useMySessionEvents,
} from "../hooks/useMeSettings";
import { useMyActivityCounts, useMySettingsCounts } from "../hooks/useMyActivity";

interface SettingsCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  to: string;
  action: string;
  children: ReactNode;
}

/**
 * One area of settings: what it is, what the server currently says about it, and
 * the way in. The facts live above the button on purpose — a card that is only a
 * link teaches nothing.
 */
function SettingsCard({ icon: Icon, title, description, to, action, children }: SettingsCardProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-4">
        <div className="space-y-1.5 text-sm">{children}</div>
        <div>
          <Button asChild size="sm" variant="outline">
            <Link to={to}>{action}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

export default function SettingsIndexPage() {
  const counts = useMySettingsCounts();
  const activity = useMyActivityCounts();
  const factors = useMfaFactors();
  const sessions = useMySessionEvents();
  const biometrics = useMyBiometricStatus();
  const unread = useUnreadCount();

  const summary = counts.data ?? null;
  const activityCounts = activity.data ?? null;
  const verifiedFactor = (factors.data ?? []).some(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );
  const lastSignIn = (sessions.data ?? [])[0] ?? null;
  const face = biometrics.data ?? null;

  return (
    <div className="container py-6">
      <PageHeader icon={Cog} title={t("meSettingsHome.title")} subtitle={t("meSettingsHome.subtitle")} />

      <Notice tone="info" className="mb-4">
        {t("meSettingsHome.notice")}
      </Notice>

      <StateBoundary
        loading={counts.isPending}
        error={counts.error}
        onRetry={() => void counts.refetch()}
        partialError={
          activity.error ?? factors.error ?? sessions.error ?? biometrics.error ?? unread.error
        }
        partialLabel={t("meSettingsHome.partial")}
        skeletonRows={3}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <SettingsCard
            icon={Bell}
            title={t("meSettingsHome.notif.title")}
            description={t("meSettingsHome.notif.hint")}
            to="/me/settings/notifications"
            action={t("meSettingsHome.notif.action")}
          >
            {summary === null || summary.preferences === 0 ? (
              <>
                <p className="font-medium text-foreground">{t("meSettingsHome.notif.none")}</p>
                <Line>{t("meSettingsHome.notif.noneHint")}</Line>
              </>
            ) : (
              <p className="num font-display text-xl font-semibold leading-none">
                {t("meSettingsHome.notif.enabled", {
                  enabled: formatNumber(summary.preferencesEnabled),
                  total: formatNumber(summary.preferences),
                })}
              </p>
            )}
          </SettingsCard>

          <SettingsCard
            icon={Fingerprint}
            title={t("meSettingsHome.security.title")}
            description={t("meSettingsHome.security.hint")}
            to="/me/settings/security"
            action={t("meSettingsHome.security.action")}
          >
            <p className="font-medium text-foreground">
              {summary === null || summary.activePasskeys === 0
                ? t("meSettingsHome.security.noPasskeys")
                : t("meSettingsHome.security.passkeys", {
                    count: formatNumber(summary.activePasskeys),
                  })}
            </p>
            <Line>
              {verifiedFactor
                ? t("meSettingsHome.security.mfaOn")
                : t("meSettingsHome.security.mfaOff")}
            </Line>
            <Line>
              {lastSignIn === null
                ? t("meSettingsHome.security.noSignIn")
                : t("meSettingsHome.security.lastSignIn", {
                    when: fmtDateTime(lastSignIn.recorded_at),
                  })}
            </Line>
            <Line>
              {face === null
                ? t("meSettingsHome.security.faceNoConsent")
                : face.face_template_active
                  ? t("meSettingsHome.security.faceActive")
                  : t("meSettingsHome.security.faceInactive")}
            </Line>
          </SettingsCard>

          <SettingsCard
            icon={ShieldCheck}
            title={t("meSettingsHome.activity.title")}
            description={t("meSettingsHome.activity.hint")}
            to="/me/activity"
            action={t("meSettingsHome.activity.action")}
          >
            <Line>
              {activityCounts === null
                ? t("meActivity.kpi.hint")
                : t("meSettingsHome.activity.counts", {
                    changes: formatNumber(activityCounts.changeRequests),
                    events: formatNumber(activityCounts.lifecycleEvents),
                    reads: formatNumber(activityCounts.dataAccesses),
                    signIns: formatNumber(activityCounts.signInEvents),
                  })}
            </Line>
          </SettingsCard>

          <SettingsCard
            icon={Inbox}
            title={t("meSettingsHome.notifications.title")}
            description={t("meSettingsHome.notifications.hint")}
            to="/me/notifications"
            action={t("meSettingsHome.notifications.action")}
          >
            <p className="num font-display text-xl font-semibold leading-none">
              {unread.data === undefined || unread.data === 0
                ? t("meSettingsHome.notifications.allRead")
                : t("meSettingsHome.notifications.unread", { count: formatNumber(unread.data) })}
            </p>
          </SettingsCard>

          <SettingsCard
            icon={UserRound}
            title={t("meSettingsHome.profile.title")}
            description={t("meSettingsHome.profile.hint")}
            to="/me/profile/basic"
            action={t("meSettingsHome.profile.action")}
          >
            <Line>{t("meSettingsHome.profile.hint")}</Line>
          </SettingsCard>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">{t("meSettingsHome.footnote")}</p>
      </StateBoundary>
    </div>
  );
}
