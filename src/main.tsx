/**
 * main.tsx — check the configuration, THEN start the app.
 *
 * WHY THE ORDER MATTERS
 * ---------------------
 * This file used to import the app statically. The import chain reached
 * `src/lib/env.ts`, which throws at module scope when `VITE_SUPABASE_URL` or
 * `VITE_SUPABASE_PUBLISHABLE_KEY` is missing — and a throw during module evaluation
 * happens before any React code runs, so `ErrorBoundary` cannot catch it and NOTHING
 * renders. The first Vercel deploy served a correct 892 KB bundle, HTTP 200, and a
 * completely blank `#root`. From the browser that is indistinguishable from a broken
 * build, a bad route, or a CDN fault.
 *
 * So the environment is checked first, with a module that cannot throw
 * (`lib/env-check.ts`), and the app is imported dynamically only once it is known to
 * be configured. A misconfigured deployment now says what is missing and how to fix
 * it, in the place where somebody is actually looking: the page.
 *
 * The diagnostic is built with DOM APIs rather than `innerHTML` — the variable names
 * come from a static list, but building a habit of assembling markup from strings in
 * the one file that runs before every guard in the app is not worth the convenience.
 */
import { missingClientEnv } from "@/lib/env-check";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

function renderConfigError(target: HTMLElement, missing: readonly string[]): void {
  const wrap = document.createElement("div");
  wrap.setAttribute("role", "alert");
  wrap.style.cssText =
    "max-width:44rem;margin:12vh auto;padding:1.5rem;font:16px/1.6 system-ui,sans-serif;color:#121F38";

  const h1 = document.createElement("h1");
  h1.textContent = "This deployment is not configured yet";
  h1.style.cssText = "font-size:1.4rem;margin:0 0 .75rem";
  wrap.append(h1);

  const lead = document.createElement("p");
  lead.textContent =
    missing.length === 1
      ? "One required environment variable was missing when this bundle was built, so the app cannot reach its backend:"
      : `${String(missing.length)} required environment variables were missing when this bundle was built, so the app cannot reach its backend:`;
  lead.style.margin = "0 0 .75rem";
  wrap.append(lead);

  const list = document.createElement("ul");
  list.style.cssText = "margin:0 0 1rem 1.25rem;font-family:ui-monospace,monospace";
  for (const name of missing) {
    const li = document.createElement("li");
    li.textContent = name;
    list.append(li);
  }
  wrap.append(list);

  // THE PART PEOPLE GET WRONG. Vite inlines these at build time, so setting them on
  // the host and reloading changes nothing — the old values (or their absence) are
  // compiled into the JavaScript already being served.
  const note = document.createElement("p");
  note.textContent =
    "Set them in the hosting project's environment settings and then REDEPLOY. These values are compiled into the bundle at build time, so a reload alone will not pick them up.";
  note.style.cssText = "margin:0 0 .75rem";
  wrap.append(note);

  const hint = document.createElement("p");
  hint.textContent = "Their names and expected shapes are documented in .env.example.";
  hint.style.cssText = "margin:0;color:#5b6478;font-size:.9rem";
  wrap.append(hint);

  target.replaceChildren(wrap);
}

const missing = missingClientEnv();
if (missing.length > 0) {
  renderConfigError(rootEl, missing);
  // Still logged: whoever opens the console during a deploy should see it too.
  console.error(`Missing required client env: ${missing.join(", ")}`);
} else {
  void import("./boot").then(({ mount }) => {
    mount(rootEl);
  });
}
