/**
 * ProfileShell.tsx — the header + tab strip + seven-state wrapper every E-07 tab
 * shares.
 *
 * One `PageHeader` per page is the contract (§4), so the shell owns it and the
 * tabs pass a subtitle. The identity band under it is the one place the employee's
 * name, code, designation and photo appear, and it reads from THE profile row —
 * the same `qk.profile.me()` entry every tab uses.
 *
 * `profile_completeness_pct` is a SERVER column (`employees.profile_completeness_pct`,
 * CHECK 0–100). It is rendered, never computed: the 12-item weighting lives in the
 * database, so the bar here and any admin report agree by construction.
 */
import type { ReactNode } from "react";
import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { formatPercent } from "@/lib/format";
import { fmtCivilDayMonthWeekday } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useMyPhoto } from "../hooks/useMyPhoto";
import { ProfileTabs } from "./ProfileTabs";
import type { MyEmployeeProfile } from "../api/profile.api";
import type { OrgLabels } from "../api/profile.api";
import { employmentStatusLabel, employmentTypeLabel } from "../display";

export interface ProfileShellProps {
  /** Tab title, e.g. "Basic info". */
  title: string;
  subtitle: string;
  profile: MyEmployeeProfile | null | undefined;
  orgLabels: OrgLabels | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** A secondary read that failed while the profile row succeeded. */
  partialError?: unknown;
  partialLabel?: string;
  children: ReactNode;
}

/**
 * `profile === null` after a successful read is the kiosk-only case: the account
 * is signed in but no employee row is visible to it. `StateBoundary` renders the
 * no-permission block for a `not_found`/`no_permission` error, so the shell
 * converts that null into exactly that state rather than showing empty cards.
 */
export function ProfileShell({
  title,
  subtitle,
  profile,
  orgLabels,
  loading,
  error,
  onRetry,
  partialError,
  partialLabel,
  children,
}: ProfileShellProps) {
  const photo = useMyPhoto();
  const noEmployeeRow = !loading && error == null && profile === null;

  return (
    <div>
      <PageHeader icon={UserRound} title={title} subtitle={subtitle} />
      <ProfileTabs />

      {noEmployeeRow ? (
        <StateBoundary
          isEmpty
          empty={
            <div className="rounded-lg border bg-card px-6 py-12 text-center">
              <h2 className="font-display text-lg font-semibold">
                {t("profile.noRecord.title")}
              </h2>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
                {t("profile.noRecord.hint")}
              </p>
            </div>
          }
        >
          {null}
        </StateBoundary>
      ) : (
        <StateBoundary
          loading={loading}
          error={error}
          onRetry={onRetry}
          skeletonRows={4}
          {...(partialError != null ? { partialError } : {})}
          {...(partialLabel !== undefined ? { partialLabel } : {})}
        >
          {profile ? (
            <div className="space-y-6">
              <IdentityBand profile={profile} orgLabels={orgLabels ?? null} photo={photo.data ?? null} />
              {children}
            </div>
          ) : null}
        </StateBoundary>
      )}
    </div>
  );
}

/**
 * The identity band. `date_of_birth` is rendered day+month only via
 * `fmtCivilDayMonthWeekday` — the year is never shown on a peer-visible surface
 * (spec-employee §P4), and the reference product's `25-Sep-2000` on the
 * Employment tab is precisely the leak being closed.
 */
/** Initials for the fallback: first letters of the first two words. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0] ?? "").join("");
  return letters === "" ? "?" : letters.toUpperCase();
}

function IdentityBand({
  profile,
  orgLabels,
  photo,
}: {
  profile: MyEmployeeProfile;
  orgLabels: OrgLabels | null;
  photo: { url: string } | null | undefined;
}) {
  const facts: Array<{ label: string; value: string }> = [
    { label: t("profile.identity.code"), value: profile.employee_code },
    {
      label: t("profile.identity.designation"),
      value: orgLabels?.designation_name ?? t("common.empty"),
    },
    {
      label: t("profile.identity.department"),
      value: orgLabels?.department_name ?? t("common.empty"),
    },
    {
      label: t("profile.identity.status"),
      value: `${employmentStatusLabel(profile.employment_status)} · ${employmentTypeLabel(profile.employment_type)}`,
    },
    {
      label: t("profile.identity.birthday"),
      value: fmtCivilDayMonthWeekday(profile.date_of_birth),
    },
  ];

  return (
    <section className="rounded-lg border bg-card p-4" aria-label={t("profile.identity.label")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/*
          THE PHOTOGRAPH, on the one screen whose header comment already promised it:
          "the one place the employee's name, code, designation and photo appear". The
          photo was the one item on that list that never rendered — no `AvatarImage`
          existed anywhere in the app — so somebody could upload their picture, see it
          verified, and never lay eyes on it again.

          Initials remain the fallback. An avatar is decoration: nothing on this screen
          should fail because a face could not be fetched.
        */}
        <Avatar className="h-16 w-16 shrink-0">
          {photo?.url !== undefined && photo.url !== null ? (
            <AvatarImage src={photo.url} alt={profile.display_name} />
          ) : null}
          <AvatarFallback className="text-lg">{initialsOf(profile.display_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          {/* Natural case, no CSS uppercase — DR-14. */}
          <h2 className="truncate font-display text-lg font-semibold">{profile.display_name}</h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {profile.work_email ?? t("common.empty")}
          </p>
        </div>
        <Completeness pct={profile.profile_completeness_pct} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{fact.label}</dt>
            <dd className="mt-0.5 truncate text-sm">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 border-t pt-3 text-sm">
        <span className="text-xs text-muted-foreground">{t("profile.identity.about")}</span>
        <br />
        {profile.about !== null && profile.about.trim() !== "" ? (
          profile.about
        ) : (
          // DR-04: an action, not "About is Not Available".
          <span className="text-muted-foreground">{t("profile.about.empty")}</span>
        )}
      </p>
    </section>
  );
}

/**
 * The completeness bar. `formatPercent(..., { clamp: true })` is belt-and-braces
 * over a column the DB already bounds — the 1,700.00% defect (DR-28) was a
 * percentage rendered without either guard.
 */
function Completeness({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className="min-w-40">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t("profile.completeness.label")}</span>
        <span className="num text-sm font-medium">{formatPercent(pct, { clamp: true })}</span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("profile.completeness.label")}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {clamped < 80 ? (
        <p className="mt-1 text-xs text-muted-foreground">{t("profile.completeness.hint")}</p>
      ) : null}
    </div>
  );
}
