/**
 * guards.tsx — route gates. All four are UX/navigation concerns; the security
 * boundary is RLS in Postgres (spec-architecture D-05).
 */
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { t } from "@/shared/i18n/en";
import type { Capability } from "@/shared/auth/capabilities";
import { useAuth } from "./AuthProvider";

function SessionSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <p className="text-sm text-muted-foreground">{t("guard.checkingSession")}</p>
    </div>
  );
}

/** Requires a signed-in session; preserves the attempted URL for post-login return. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <SessionSpinner />;
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/**
 * Blocks every /me|/team|/admin route until the forced first-run flow is done
 * (spec-employee E-01.3: must_change_password OR profile_confirmed_at IS NULL).
 */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const { employee, identityResolved, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <SessionSpinner />;

  // Fail OPEN, deliberately. This gate is a nudge, not a security control — the
  // security boundary is RLS. If the identity read failed (network, a renamed
  // column, RLS returning nothing), `profileConfirmedAt` is indistinguishable
  // from "genuinely not confirmed", and gating on that locks the user out of
  // the whole app with no way forward. A real joiner still gets the wizard
  // because their profile resolves and genuinely says so.
  if (!identityResolved) return <>{children}</>;

  // No employee row yet (HR hasn't linked the record): don't trap the user in a
  // wizard whose second step has nothing to confirm.
  if (employee && (employee.mustChangePassword || employee.profileConfirmedAt === null)) {
    if (location.pathname !== "/first-run") return <Navigate to="/first-run" replace />;
  }
  return <>{children}</>;
}

/** Capability gate for a route subtree. Renders an honest refusal, not a 404. */
export function RequireCap({ cap, children }: { cap: Capability; children: ReactNode }) {
  const { caps, isLoading } = useAuth();

  if (isLoading) return <SessionSpinner />;
  if (!caps.has(cap)) {
    return (
      <div className="container py-10">
        <EmptyState
          icon={ShieldAlert}
          title={t("guard.noAccess.title")}
          hint={t("guard.noAccess.hint")}
          action={
            <Button asChild variant="outline">
              <a href="/me">{t("guard.backHome")}</a>
            </Button>
          }
        />
      </div>
    );
  }
  return <>{children}</>;
}

/** Keeps signed-in users off /login and friends. */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { session, isLoading } = useAuth();
  if (isLoading) return <SessionSpinner />;
  if (session) return <Navigate to="/me" replace />;
  return <>{children}</>;
}

/** Root `/` behaviour: into the app when authed, to login when not. */
export function RootRedirect() {
  const { session, isLoading } = useAuth();
  if (isLoading) return <SessionSpinner />;
  return <Navigate to={session ? "/me" : "/login"} replace />;
}
