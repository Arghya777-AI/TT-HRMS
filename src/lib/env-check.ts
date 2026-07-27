/**
 * env-check.ts — is the browser bundle actually configured?
 *
 * WHY THIS IS A SEPARATE MODULE FROM `env.ts`
 * -----------------------------------------
 * `env.ts` builds its `env` object at module scope and THROWS from `required()`
 * when a variable is missing. That is the right behaviour for a consumer — code
 * downstream should never see an empty Supabase URL — but it means the throw happens
 * during module evaluation, before any React code runs.
 *
 * The consequence, observed on the first Vercel deploy: `main.tsx` statically
 * imported the app, the import chain reached `env.ts`, `required()` threw, and the
 * page rendered an entirely blank `#root`. `ErrorBoundary` could not help — a React
 * error boundary catches errors thrown while RENDERING, and nothing had begun to
 * render. So a deployment missing two environment variables was indistinguishable,
 * from the browser, from a broken build, a bad route or a CDN failure.
 *
 * This module therefore reads `import.meta.env` DIRECTLY and never throws, so
 * `main.tsx` can ask "am I configured?" before importing anything that assumes it is.
 * It deliberately has no imports at all: anything it pulled in could itself throw at
 * module scope and put us back where we started.
 *
 * KEEP THIS LIST IN STEP WITH `env.ts`. `clientEnvContract.test.ts` asserts that it
 * is, by parsing both files — a variable added to one and not the other would restore
 * exactly the blank page this exists to prevent.
 */

/** The variables the bundle cannot run without. Names only — never values. */
export const REQUIRED_CLIENT_ENV = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
] as const;

/**
 * Which required variables are absent or blank. Empty array = configured.
 *
 * Vite INLINES `import.meta.env.VITE_*` at build time, so a variable that was not
 * present when `vite build` ran is not "unset at runtime" — it is a literal
 * `undefined` compiled into the bundle. Setting it on the host afterwards changes
 * nothing until the app is rebuilt, which is the single most confusing thing about
 * deploying a Vite app and is why the message below says so out loud.
 */
export function missingClientEnv(): readonly string[] {
  const values: Record<(typeof REQUIRED_CLIENT_ENV)[number], string | undefined> = {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
  return REQUIRED_CLIENT_ENV.filter((name) => {
    const value = values[name];
    return value === undefined || value.trim() === "";
  });
}
