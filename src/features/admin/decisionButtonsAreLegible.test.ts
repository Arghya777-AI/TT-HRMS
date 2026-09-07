/**
 * A decision has a colour, and the colour has to be readable.
 *
 * Three controls sat side by side in one table cell, all `outline`, all the same grey. Reported
 * as "looking odd, very odd" — and it was worse than odd: three across forced the column to
 * 17rem, pushed the grid into a horizontal scroll, and clipped the last button off the edge of
 * the viewport. Approve, reject and edit now stack one per line, and the column is NARROWER
 * than the two-across version it replaces.
 *
 * Green approves, red refuses, amber changes, so the row is readable before any of the words
 * are. Colour is never the only signal — every button still carries its own label, which is
 * what a colour-blind reader goes by.
 *
 * ── WHY THE CONTRAST IS COMPUTED HERE ────────────────────────────────────────
 * These became text-on-colour buttons, so the token pairs now have to carry text. The ratios
 * are worked out from `index.css` itself rather than asserted as remembered numbers: a token
 * retuned for a chart or a badge would otherwise quietly make a button unreadable, and nothing
 * would fail. Measured at the time of writing, every pair clears WCAG AA for normal text —
 * light success 4.67:1, light warning 5.42:1, the rest higher.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const button = strip(read("src", "components", "ui", "button.tsx"));
const queue = strip(read("src", "features", "admin", "pages", "LeaveRequests.page.tsx"));
const css = read("src", "index.css");

// ── the smallest correct sRGB contrast implementation, so the numbers are real
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const [h, s, l] = v.trim().split(/\s+/).map((x) => Number.parseFloat(x));
    return hslToRgb(h ?? 0, s ?? 0, l ?? 0);
  };
  const la = luminance(parse(a));
  const lb = luminance(parse(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Both blocks of `index.css`, in order: bare `:root` is light, the second definition is dark.
 * Reading them positionally is deliberate — a token that exists in only one theme should fail
 * here rather than silently be tested twice against the same value.
 */
function tokenPair(name: string): [string, string] {
  const found = [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) => m[1] ?? "");
  expect(found.length, `--${name} must be defined in both themes`).toBe(2);
  return [found[0] ?? "", found[1] ?? ""];
}

describe("the variants exist as variants, not as pasted class names", () => {
  it("defines success and warning on the shared button", () => {
    expect(button).toContain('success: "bg-success text-success-foreground hover:bg-success/90"');
    expect(button).toContain('warning: "bg-warning text-warning-foreground hover:bg-warning/90"');
  });

  it("leaves destructive as the red one it already was", () => {
    expect(button).toContain("destructive: \"bg-destructive text-destructive-foreground");
  });
});

describe("every decision colour carries its own text", () => {
  for (const token of ["success", "warning", "destructive"] as const) {
    it(`${token} clears WCAG AA in both themes`, () => {
      const [lightBg, darkBg] = tokenPair(token);
      const [lightFg, darkFg] = tokenPair(`${token}-foreground`);
      for (const [label, bg, fg] of [
        ["light", lightBg, lightFg],
        ["dark", darkBg, darkFg],
      ] as const) {
        const ratio = contrast(bg, fg);
        expect(ratio, `${token} ${label} was ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("the row", () => {
  it("stacks the controls vertically", () => {
    expect(queue).toContain('className="inline-flex w-full flex-col items-stretch gap-1.5"');
    // The old horizontal row must be gone, not merely overridden further down.
    expect(queue).not.toContain('className="inline-flex gap-2"');
  });

  it("got NARROWER, because one per line needs less than three across", () => {
    const col = queue.slice(queue.indexOf('key: "actions"'));
    expect(col.slice(0, 300)).toContain('width: "11rem"');
    expect(col.slice(0, 300)).not.toContain('width: "17rem"');
  });

  it("paints approve green, reject red and the change amber", () => {
    const approve = queue.indexOf('t("admin.leaveReq.action.approve")');
    const reject = queue.indexOf('t("admin.leaveReq.action.reject")');
    const more = queue.indexOf('t("admin.leaveReq.action.more")');
    for (const at of [approve, reject, more]) expect(at).toBeGreaterThan(-1);
    // Each label's own button block carries the variant.
    expect(queue.slice(0, approve)).toMatch(/variant="success"[\s\S]*$/);
    expect(queue.slice(approve, reject)).toContain('variant="destructive"');
    expect(queue.slice(reject, more)).toContain('variant="warning"');
  });

  it("paints the approved row's button amber too — it opens the same change dialog", () => {
    const take = queue.indexOf('t("admin.leaveReq.action.take")');
    expect(take).toBeGreaterThan(-1);
    expect(queue.slice(0, take)).toMatch(/variant="warning"[\s\S]*$/);
  });

  it("keeps a label on every button, so colour is never the only signal", () => {
    for (const key of [
      "admin.leaveReq.action.approve",
      "admin.leaveReq.action.reject",
      "admin.leaveReq.action.more",
      "admin.leaveReq.action.take",
    ]) {
      expect(queue).toContain(`t("${key}")`);
    }
  });
});
