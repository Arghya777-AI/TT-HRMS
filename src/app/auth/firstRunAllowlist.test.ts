/**
 * The first-run gate's allowlist, and the one thing it must never get wrong again.
 *
 * The gate held `/me/documents` — a screen that LISTS documents and cannot upload one,
 * which even printed "self-upload is not switched on yet". The screen with the form is
 * `/me/profile/documents`, and the gate redirected it straight back to /first-run. A new
 * joiner was therefore told to upload their documents and then prevented from reaching
 * the only place they could; the sole way out was to sign out.
 *
 * This test exists because that failure is invisible in code review — both strings look
 * like a documents route — and it only shows up as a new employee stuck in a loop on
 * their first day.
 */
import { describe, expect, it } from "vitest";
import { FIRST_RUN_ALLOWED } from "./guards";
import { REDIRECTS } from "@/app/route-manifest";
import { PAGE_REGISTRY } from "@/features/registry";

/** The route whose page actually renders an upload form. */
const UPLOAD_ROUTE = "/me/profile/documents";

describe("first-run allowlist", () => {
  it("lets the joiner reach the wizard itself", () => {
    expect(FIRST_RUN_ALLOWED).toContain("/first-run");
  });

  it("lets the joiner reach the screen that can actually upload", () => {
    expect(FIRST_RUN_ALLOWED).toContain(UPLOAD_ROUTE);
  });

  it("keeps the upload route real — it is a registered page, not a redirect", () => {
    expect(Object.keys(PAGE_REGISTRY)).toContain(UPLOAD_ROUTE);
    expect(REDIRECTS.map((r) => r.from)).not.toContain(UPLOAD_ROUTE);
  });

  it("allows every listed path to resolve to a page or a redirect", () => {
    const registered = new Set(Object.keys(PAGE_REGISTRY));
    const redirected = new Set(REDIRECTS.map((r) => r.from));
    for (const path of FIRST_RUN_ALLOWED) {
      // `/first-run` is mounted outside the capability tree, so exempt it by name.
      if (path === "/first-run") continue;
      expect(
        registered.has(path) || redirected.has(path),
        `${path} is on the first-run allowlist but resolves to nothing`,
      ).toBe(true);
    }
  });

  it("stays small — every extra path is a screen a half-onboarded user can reach", () => {
    expect(FIRST_RUN_ALLOWED.length).toBeLessThanOrEqual(4);
  });
});
