/**
 * SignInActivitySection.tsx — the whole employee-facing sign-in audit surface, as
 * one section so `/me/activity` and any later host cannot drift apart.
 *
 * The order of the section is the argument it makes:
 *   1. ONE sentence saying what is recorded and why. A location and device trail a
 *      person does not understand is worse than none, so this is first and is not
 *      collapsible.
 *   2. What is NOT recorded, stated as plainly. Today only the passkey, kiosk and
 *      account-setup paths write here — an email-and-password sign-in is handled
 *      inside the sign-in service and never reaches `sessions_audit`. Without that
 *      sentence a nearly empty list reads as "nobody has ever signed in as me",
 *      which is the opposite of the truth.
 *   3. The session in THIS browser, read from the sign-in service (`auth.users`
 *      via AuthProvider), which is the one sign-in fact always available.
 *   4. Four server counts over the whole record — never `rows.length`.
 *   5. The trail itself, filterable over what was loaded, with the scope stated.
 *
 * Every number is a `count=exact` read (`useMySignInSummary`); every instant goes
 * through `fmtDateTime`, which is IST-only.
 */
import { useMemo, useState } from "react";
import { KeyRound, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KpiTile } from "@/shared/ui/KpiTile";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { SIGNIN_TRAIL_LIMIT } from "../api/signin-activity.api";
import { useMySessionRenewals, useMySignInSummary, useMySignInTrail } from "../hooks/useSignInActivity";
import {
  buildSignInTrail,
  filterSignInTrail,
  readDevice,
  signInMethodLabel,
  type SignInTrailFilter,
} from "./analysis";
import { SignInTrail } from "./SignInTrail";

/** `navigator` is read once and defensively: this must not throw off the browser. */
function currentUserAgent(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  return typeof ua === "string" && ua !== "" ? ua : null;
}

const FILTERS: readonly { readonly id: SignInTrailFilter; readonly label: string }[] = [
  { id: "activity", label: t("signIn.filter.activity") },
  { id: "signIns", label: t("signIn.filter.signIns") },
  { id: "failures", label: t("signIn.filter.failures") },
  { id: "security", label: t("signIn.filter.security") },
  { id: "renewals", label: t("signIn.filter.renewals") },
];

/** GoTrue timestamps are not ours to trust blindly — `fmtDateTime` throws on junk. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/**
 * The session this browser is holding right now.
 *
 * Read from the GoTrue user, NOT from `sessions_audit`: a password sign-in writes
 * no audit row, so this panel is the only place the employee can see their current
 * sign-in at all. It says where the fact comes from for exactly that reason.
 */
function CurrentSessionPanel() {
  const auth = useAuth();
  const user = auth.user;
  const ua = currentUserAgent();
  const device = readDevice({ device_id: null, user_agent: ua, auth_method: null });
  const reported = user?.last_sign_in_at;
  const lastSignInAt =
    typeof reported === "string" && ISO_INSTANT.test(reported) ? reported : null;

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
        <MonitorSmartphone className="size-4 text-primary" aria-hidden />
        {t("signIn.session.title")}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("signIn.session.hint")}</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t("signIn.session.account")}</dt>
          <dd className="mt-0.5 break-all text-sm">{dash(user?.email ?? null)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("signIn.session.since")}</dt>
          <dd className="num mt-0.5 text-sm">
            {lastSignInAt === null ? (
              <span className="text-muted-foreground">{t("signIn.session.sinceUnknown")}</span>
            ) : (
              fmtDateTime(lastSignInAt)
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("signIn.session.device")}</dt>
          <dd className="mt-0.5 text-sm">{device.label}</dd>
        </div>
      </dl>
    </section>
  );
}

export function SignInActivitySection() {
  const [filter, setFilter] = useState<SignInTrailFilter>("activity");
  const trail = useMySignInTrail();
  const renewals = useMySessionRenewals(filter === "renewals");
  const summary = useMySignInSummary();

  /**
   * `trail.data` is used directly (not `?? []`) so the memo below has a STABLE
   * dependency: a fresh `[]` on every render would re-analyse the trail on every
   * render, which is also what the exhaustive-deps rule is warning about.
   *
   * "First time ever" is only true if the loaded rows ARE the whole record. The
   * read is capped at `SIGNIN_TRAIL_LIMIT`, so a full page means there is more
   * behind it and the novelty notes are withheld (`buildSignInTrail` decides).
   */
  const loaded = trail.data;
  const historyComplete = trail.isSuccess && (loaded?.length ?? 0) < SIGNIN_TRAIL_LIMIT;
  const truncated = trail.isSuccess && (loaded?.length ?? 0) >= SIGNIN_TRAIL_LIMIT;
  const ua = currentUserAgent();

  const analysed = useMemo(
    () => buildSignInTrail(loaded ?? [], { historyComplete, currentUserAgent: ua }),
    [loaded, historyComplete, ua],
  );

  const renewalRows = useMemo(
    () =>
      buildSignInTrail(renewals.data ?? [], {
        // A renewals-only page is by definition not the whole record.
        historyComplete: false,
        currentUserAgent: ua,
      }),
    [renewals.data, ua],
  );

  const rows = filter === "renewals" ? renewalRows : filterSignInTrail(analysed, filter);
  const counts = summary.data ?? null;
  const activeQuery = filter === "renewals" ? renewals : trail;

  return (
    <div className="space-y-4">
      <Notice tone="info">{t("signIn.recorded")}</Notice>
      <Notice tone="warning">{t("signIn.recorded.notWritten")}</Notice>

      <CurrentSessionPanel />

      {/* The four numbers, each counted by Postgres over my own rows. */}
      <StateBoundary
        loading={summary.isPending}
        error={summary.error}
        onRetry={() => void summary.refetch()}
        skeletonRows={1}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label={t("signIn.kpi.signIns")}
            value={formatNumber(counts?.signIns ?? 0)}
            explainer={{ formula: t("signIn.kpi.signInsFormula"), numbers: t("signIn.kpi.numbers") }}
          />
          <KpiTile
            label={t("signIn.kpi.failures")}
            value={formatNumber(counts?.failures ?? 0)}
            tone={(counts?.failures ?? 0) > 0 ? "warn" : "neutral"}
            explainer={{
              formula: t("signIn.kpi.failuresFormula"),
              numbers: t("signIn.kpi.numbers"),
            }}
          />
          <KpiTile
            label={t("signIn.kpi.security")}
            value={formatNumber(counts?.securityChanges ?? 0)}
            explainer={{
              formula: t("signIn.kpi.securityFormula"),
              numbers: t("signIn.kpi.numbers"),
            }}
          />
          <KpiTile
            label={t("signIn.kpi.total")}
            value={formatNumber(counts?.total ?? 0)}
            explainer={{ formula: t("signIn.kpi.totalFormula"), numbers: t("signIn.kpi.numbers") }}
          />
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {counts === null || counts.lastSuccessAt === null
            ? t("signIn.lastSuccessNone")
            : t("signIn.lastSuccess", {
                when: fmtDateTime(counts.lastSuccessAt),
                method: signInMethodLabel(counts.lastSuccessMethod),
              })}
        </p>
      </StateBoundary>

      {/* Filters over the LOADED rows — the scope line says so in as many words. */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("signIn.filter.label")}>
          {FILTERS.map((option) => {
            const active = option.id === filter;
            return (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                className={cn(active && "shadow-sm")}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {filter === "renewals"
            ? t("signIn.renewals.hint")
            : t("signIn.filter.scope", { n: formatNumber(analysed.length) })}
        </p>
      </div>

      {/* Only once the trail HAS loaded: "there is more history" is a claim about a
          finished read, and showing it mid-flight would slander a complete record. */}
      {!truncated || filter === "renewals" || counts === null ? null : (
        <Notice tone="warning">
          {t("signIn.truncated", {
            limit: formatNumber(SIGNIN_TRAIL_LIMIT),
            total: formatNumber(counts.total),
          })}
        </Notice>
      )}

      <StateBoundary
        loading={activeQuery.isPending}
        error={activeQuery.error}
        onRetry={() => void activeQuery.refetch()}
        isEmpty={rows.length === 0}
        skeletonRows={5}
        empty={
          analysed.length === 0 && filter === "activity" ? (
            <EmptyState
              icon={KeyRound}
              title={t("signIn.empty.title")}
              hint={t("signIn.empty.hint")}
            />
          ) : (
            <EmptyState
              icon={ShieldCheck}
              title={t("signIn.emptyFiltered.title")}
              hint={filter === "renewals" ? t("signIn.renewals.hint") : t("signIn.emptyFiltered.hint")}
              action={
                filter === "activity" ? null : (
                  <Button variant="outline" size="sm" onClick={() => setFilter("activity")}>
                    {t("signIn.filter.activity")}
                  </Button>
                )
              }
            />
          )
        }
      >
        <SignInTrail rows={rows} />
      </StateBoundary>

      <div className="space-y-1.5 text-xs text-muted-foreground">
        {/* `webauthn-login` writes `passkey_used` AND `login_success` for one
            ceremony, so the trail shows two rows a second apart. Said out loud
            here rather than de-duplicated: hiding a recorded row to make the list
            tidier is the one thing an audit surface must not do. */}
        <p>{t("signIn.recorded.passkeyPair")}</p>
        <p>{t("signIn.recorded.face")}</p>
        <p>{t("signIn.recorded.notYours")}</p>
      </div>
    </div>
  );
}
