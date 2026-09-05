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
import { lazyWithRecovery } from "./lazyWithRecovery";
import { ROUTES, REDIRECTS, type RouteMeta } from "./route-manifest";
import { AppShell } from "./shell/AppShell";
import { SectionNav } from "./shell/SectionNav";
import { hasSectionNav } from "./shell/sectionNavModel";
import { FirstRunGate, RedirectIfAuthed, RequireAuth, RequireCap, RootRedirect } from "./auth/guards";

// Auth + kiosk surfaces are eagerly-split chunks of their own.
const Login = lazy(() => import("@/pages/Login"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
const FirstRun = lazy(() => import("@/pages/FirstRun"));
const Landing = lazy(() => import("@/pages/Landing"));
const NotFound = lazy(() => import("@/pages/NotFound"));

function RouteFallback() {
  return (
    <div className="container space-y-4 py-8">
      <Skeleton className="h-9 w-64" />
      {/* `max-w-96`, not `w-96`: a fixed 384px bar is wider than a 320px phone, so every
          page overflowed sideways for as long as its chunk was in flight. */}
      <Skeleton className="h-4 w-full max-w-96" />
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
    /*
      A deploy renames every chunk, so a tab opened before it holds a module graph naming
      files this deployment no longer serves. `lazyWithRecovery` reloads once on that failure
      rather than leaving somebody on a dead page they cannot fix.
    */
    if (loader) return lazyWithRecovery(loader);
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
      {/*
        THE SECTION STRIP IS MOUNTED ONCE, HERE, not on ~60 individual pages.

        This is the only place that already holds `meta` for every screen, so the
        strip can be derived from `meta.domain` with no path parsing and no per-page
        edit. Mounting it inside each page would have meant sixty near-identical
        changes and sixty chances to miss one — which is precisely the failure mode
        the strip exists to fix.

        It renders INSIDE `RequireCap`, so somebody refused a screen sees the refusal
        rather than a section strip framing an error. `SectionNav` returns null for
        any domain without a strip, so this costs nothing on the other sections.
      */}
      <SectionNavForRoute domain={meta.domain} />
      <Suspense fallback={<RouteFallback />}>
        <Element />
      </Suspense>
    </RequireCap>
  );
}

/**
 * The strip, padded to line up with the page container beneath it.
 *
 * Every page renders its own `container py-6`, so an unpadded strip would sit flush
 * against the viewport edge while the page content was inset — the tabs would not
 * line up with the heading they belong to.
 */
function SectionNavForRoute({ domain }: { domain: string }) {
  if (!hasSectionNav(domain)) return null;
  return (
    <div className="container pt-6">
      <SectionNav domain={domain} />
    </div>
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

        {/*
          /kiosk IS NO LONGER A ROUTE OF THIS APP.

          The gate terminal is a separate installed application with its own entry
          (`kiosk/index.html`), its own manifest and its own service worker, and Vercel
          now serves /kiosk from that build rather than from this shell. Leaving a route
          here would mean two different apps answering the same URL depending on whether
          the visitor arrived by link or by client-side navigation — and the one that won
          would be this one, which is the bug that made the new terminal unreachable.
        */}

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
