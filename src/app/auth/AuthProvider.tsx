/**
 * AuthProvider — the single source of session, identity, roles and capabilities
 * for the whole app. Nothing else may call `supabase.auth` for session state.
 *
 * Design notes:
 *  - Capabilities are UX ONLY (see shared/auth/capabilities.ts). RLS is the
 *    security boundary; a hidden nav item is a convenience, not a control.
 *  - The shell must render before the backend exists. Every backend read here
 *    degrades to a safe default (no roles / no employee row) instead of
 *    throwing, so `/me` is usable against an empty database.
 *  - `employee` is the small identity projection the shell needs (name, code,
 *    photo, first-run flags). Full profile reads belong to feature APIs.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { capsForRoles, type Capability } from "@/shared/auth/capabilities";

export interface EmployeeIdentity {
  employeeId: string | null;
  employeeCode: string | null;
  displayName: string | null;
  photoPath: string | null;
  /** Forces the /first-run wizard (spec-employee E-01.3). */
  mustChangePassword: boolean;
  /** NULL until the employee has confirmed their details once. */
  profileConfirmedAt: string | null;
}

export interface AuthState {
  session: Session | null;
  user: User | null;
  employee: EmployeeIdentity | null;
  roles: readonly string[];
  caps: ReadonlySet<Capability>;
  /** True until the initial session + identity resolution settles. */
  isLoading: boolean;
  /**
   * True only when the profile row was actually READ. Distinguishes "profile
   * says not confirmed" from "we could not read the profile" — FirstRunGate
   * must not trap a user on the second case.
   */
  identityResolved: boolean;
  can: (cap: Capability) => boolean;
  signOut: () => Promise<void>;
  /** Re-read identity/roles (after first-run completion, role grant, etc.). */
  refresh: () => Promise<void>;
}

const EMPTY_CAPS: ReadonlySet<Capability> = new Set<Capability>();

const AuthContext = createContext<AuthState | null>(null);

/**
 * Shape of the identity we try to read; every field optional/defensive.
 *
 * NOTE the column is `full_name`, not `display_name` — `profiles` (migration
 * 004) has no `display_name`. Asking for one made PostgREST return 42703, and
 * because this read is failure-tolerant the error surfaced as "no profile":
 * `profile_confirmed_at` read as NULL, which sent every signed-in user
 * into the forced first-run wizard. A silently-wrong column name is worse than
 * a crash, so the field list here must match the migration exactly.
 */
interface ProfileRow {
  id?: string | null;
  full_name?: string | null;
  must_change_password?: boolean | null;
  profile_confirmed_at?: string | null;
}

interface EmployeeRow {
  id?: string | null;
  employee_code?: string | null;
  display_name?: string | null;
  photo_path?: string | null;
}

async function loadIdentity(userId: string): Promise<{
  employee: EmployeeIdentity;
  roles: string[];
  isManager: boolean;
  profileResolved: boolean;
}> {
  // Each read is independent and failure-tolerant: a missing table (backend not
  // yet migrated) must not break the shell.
  const [profileRes, employeeRes, rolesRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, must_change_password, profile_confirmed_at")
      .eq("id", userId)
      .maybeSingle(),
    // v_my_employee, NOT the employees table. `authenticated` holds only a
    // column-scoped grant on `employees`, and Postgres requires SELECT on any
    // column named in a WHERE clause too — so filtering the base table by
    // `profile_id` returns 42501 "permission denied". The view is also the
    // sanctioned read path (data model §4.6) and already scopes to self.
    supabase
      .from("v_my_employee")
      .select("id, employee_code, display_name, photo_path")
      .maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", userId).is("revoked_at", null),
  ]);

  const profile = (profileRes.data ?? null) as ProfileRow | null;
  const employeeRow = (employeeRes.data ?? null) as EmployeeRow | null;
  const roleRows = (rolesRes.data ?? []) as Array<{ role?: string | null }>;

  const roles = roleRows
    .map((r) => r.role)
    .filter((r): r is string => typeof r === "string" && r.length > 0);

  // Manager is DERIVED from reporting lines, never granted (spec-manager
  // D-02-01). Probe through the manager allow-list view: it returns the caller
  // plus everyone in their scope, so more than one row means they lead someone.
  // Same reason as above — the base table is column-scoped and cannot be
  // filtered on reporting_manager_id by `authenticated`.
  let isManager = false;
  const employeeId = employeeRow?.id ?? null;
  if (employeeId) {
    const team = await supabase
      .from("v_team_employee_basic")
      .select("employee_code", { head: true, count: "exact" });
    isManager = (team.count ?? 0) > 1;
  }

  return {
    employee: {
      employeeId,
      employeeCode: employeeRow?.employee_code ?? null,
      displayName: employeeRow?.display_name ?? profile?.full_name ?? null,
      photoPath: employeeRow?.photo_path ?? null,
      mustChangePassword: profile?.must_change_password === true,
      profileConfirmedAt: profile?.profile_confirmed_at ?? null,
    },
    roles,
    isManager,
    profileResolved: profileRes.error === null && profile !== null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [employee, setEmployee] = useState<EmployeeIdentity | null>(null);
  const [roles, setRoles] = useState<readonly string[]>([]);
  const [caps, setCaps] = useState<ReadonlySet<Capability>>(EMPTY_CAPS);
  const [isLoading, setIsLoading] = useState(true);
  const [identityResolved, setIdentityResolved] = useState(false);

  const applyIdentity = useCallback(async (nextSession: Session | null) => {
    if (!nextSession?.user) {
      setEmployee(null);
      setRoles([]);
      setCaps(EMPTY_CAPS);
      setIdentityResolved(false);
      return;
    }
    try {
      const { employee: emp, roles: r, isManager, profileResolved } = await loadIdentity(
        nextSession.user.id,
      );
      setEmployee(emp);
      setRoles(r);
      setCaps(capsForRoles(r, { isManager }));
      setIdentityResolved(profileResolved);
    } catch {
      // Backend unreachable / not migrated: authenticated users still get the
      // employee baseline so the shell renders.
      setEmployee(null);
      setRoles([]);
      setCaps(capsForRoles([]));
      setIdentityResolved(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSession(data.session);
      await applyIdentity(data.session);
      if (!cancelled) setIsLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      void applyIdentity(nextSession);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [applyIdentity]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    await applyIdentity(data.session);
  }, [applyIdentity]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setEmployee(null);
    setRoles([]);
    setCaps(EMPTY_CAPS);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      employee,
      roles,
      caps,
      isLoading,
      identityResolved,
      can: (cap: Capability) => caps.has(cap),
      signOut,
      refresh,
    }),
    [session, employee, roles, caps, isLoading, identityResolved, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Convenience hook for conditional UI. Never a security check. */
export function useCan(cap: Capability): boolean {
  return useAuth().can(cap);
}
