/**
 * routes.tsx — the router. Owns the whole route tree; nothing outside
 * `src/app/**` declares routes.
 *
 * Layering (outermost first) for authenticated surfaces:
 *   RequireAuth → FirstRunGate → AppShell → RequireCap(route.cap) → page
 * `/kiosk` and the auth screens deliberately render OUTSIDE the shell.
 *
 * Pages come from `src/features/registry.ts`; any route without a registered
 * page falls back to <PageStub> built from the manifest metadata, so every
 * route in the spec is deep-linkable from day one.
 */
import { Suspense, lazy, useMemo, type ComponentType } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import PageStub from "@/shared/ui/PageStub";
import { PAGE_REGISTRY } from "@/features/registry";
import { ROUTES, REDIRECTS, type RouteMeta } from "./route-manifest";
import { AppShell } from "./shell/AppShell";
import { FirstRunGate, RedirectIfAuthed, RequireAuth, RequireCap, RootRedirect } from "./auth/guards";

// Auth + kiosk surfaces are eagerly-split chunks of their own.
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const FirstRun = lazy(() => import("@/pages/FirstRun"));
const Landing = lazy(() => import("@/pages/Landing"));
const NotFound = lazy(() => import("@/pages/NotFound"));
const Kiosk = lazy(() => import("@/features/kiosk/pages/Kiosk.page"));

function RouteFallback() {
  return (
    <div className="container space-y-4 py-8">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    </div>
  );
}

/** Resolve a manifest entry to its element: real page if registered, else stub. */
function useRouteElement(meta: RouteMeta): ComponentType {
  return useMemo(() => {
    const loader = PAGE_REGISTRY[meta.path];
    if (loader) return lazy(loader);
    const Stub = () => (
      <PageStub icon={meta.icon} title={meta.title} subtitle={meta.subtitle} hint={meta.hint} phase={meta.phase} />
    );
    Stub.displayName = `Stub(${meta.path})`;
    return Stub;
  }, [meta]);
}

function ManifestRoute({ meta }: { meta: RouteMeta }) {
  const Element = useRouteElement(meta);
  return (
    <RequireCap cap={meta.cap}>
      <Suspense fallback={<RouteFallback />}>
        <Element />
      </Suspense>
    </RequireCap>
  );
}

export default function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Root: into the app when signed in, to sign-in when not. */}
        <Route path="/" element={<RootRedirect />} />
        <Route path="/welcome" element={<Landing />} />

        {/* Auth — outside the shell. */}
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <Login />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/login/forgot"
          element={
            <RedirectIfAuthed>
              <ForgotPassword />
            </RedirectIfAuthed>
          }
        />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/first-run"
          element={
            <RequireAuth>
              <FirstRun />
            </RequireAuth>
          }
        />

        {/* Kiosk — chrome-less, its own hostname in production. */}
        <Route path="/kiosk" element={<Kiosk />} />

        {/* Legacy + default redirects. */}
        {REDIRECTS.map((r) => (
          <Route key={r.from} path={r.from} element={<Navigate to={r.to} replace />} />
        ))}

        {/* Every authenticated surface, inside the shell. */}
        <Route
          element={
            <RequireAuth>
              <FirstRunGate>
                <AppShell>
                  <Outlet />
                </AppShell>
              </FirstRunGate>
            </RequireAuth>
          }
        >
          {ROUTES.map((meta) => (
            <Route key={meta.path} path={meta.path} element={<ManifestRoute meta={meta} />} />
          ))}
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
