/**
 * specContract.test.ts — the browser's answer schema and the server's validator must
 * agree about what a chart series is.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Show my attendance trend over the last three months" put this on screen, in red, to an
 * employee:
 *
 *   [ { "code": "invalid_type", "expected": "string", "received": "undefined",
 *       "path": [ "spec", "blocks", 1, "series", 0, "colour" ], "message": "Required" },
 *     { … "path": [ "spec", "blocks", 1, "series", 0, "format" ] … } ]
 *
 * Three separate things had to be true for that to happen, and each is now guarded here:
 *
 *   1. THE CLIENT REQUIRED `colour` AND `format` on every series (`seriesSchema`), while
 *      the SERVER's `validateSpec` walked a series' POINTS and never looked at the series'
 *      own fields. So an incomplete series passed the server and failed in the browser —
 *      the strictest check was the one furthest from the model.
 *   2. The wire schema does declare both required, but that grammar is applied only for
 *      Opus (`isOpus`) and the deployed model is claude-sonnet-5, so nothing enforced it.
 *      A contract that only binds on a model you are not running is not a contract.
 *   3. The client rendered `error.message`, and a `ZodError`'s message IS the serialised
 *      issue list.
 *
 * WHAT IT DOES NOT DO is re-declare the field list. It reads both sides' source, so
 * renaming a series field in one place fails this test until the other follows — which is
 * the coupling that was missing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seriesSchema } from "./api/aiAgent.api";

const FN = readFileSync(join(process.cwd(), "supabase/functions/ai-agent/index.ts"), "utf8");
const HOOK = readFileSync(join(process.cwd(), "src/features/ai/hooks/useAskAgent.ts"), "utf8");

/** Field names the browser insists on for a series. */
const clientRequired = Object.entries(seriesSchema.shape)
  .filter(([, schema]) => !schema.isOptional())
  .map(([key]) => key)
  .sort();

describe("the client's series contract", () => {
  it("requires name, colour, format and points", () => {
    expect(clientRequired).toEqual(["colour", "format", "name", "points"]);
  });
});

describe("the server fills every field the client requires", () => {
  // The coercion pass that runs before validation.
  const coerce = FN.slice(
    FN.indexOf("function coerceSpecNotation"),
    FN.indexOf("function validateSpec"),
  );

  it("is present", () => {
    expect(coerce.length).toBeGreaterThan(200);
  });

  it("fills a missing colour with a palette token", () => {
    expect(coerce).toContain("sr.colour");
    expect(coerce).toContain("PALETTE_TOKENS");
  });

  it("fills a missing format", () => {
    expect(coerce).toContain("sr.format");
  });

  it("fills a missing name", () => {
    expect(coerce).toContain("sr.name");
  });
});

describe("the server also REFUSES a series it could not fill", () => {
  /*
    Coercion is the happy path; this is the backstop. Without it, a case the coercion does
    not cover would sail through the server again and land in the browser as a red box —
    which is exactly the failure being fixed. With it, the answer degrades to the
    server-rendered fallback instead.
  */
  const validate = FN.slice(FN.indexOf("function validateSpec"));
  const seriesLoop = validate.slice(validate.indexOf("of arr<{ name: string; colour: string"));

  it("checks the series' colour, not only its points", () => {
    expect(seriesLoop.slice(0, 2_500)).toMatch(/series\[\$\{si\}\]\.colour/);
  });

  it("checks the series' format", () => {
    expect(seriesLoop.slice(0, 2_500)).toMatch(/series\[\$\{si\}\]\.format/);
  });
});

describe("no validation dump ever reaches the reader", () => {
  it("does not render error.message straight into the turn", () => {
    // The exact line that printed the zod issue list on screen.
    expect(HOOK).not.toContain("error instanceof Error ? error.message : String(error)");
  });

  it("routes failures through a translator", () => {
    expect(HOOK).toContain("explainAskError(error)");
  });

  it("handles a ZodError explicitly, and logs it rather than showing it", () => {
    expect(HOOK).toContain("error instanceof ZodError");
    expect(HOOK).toContain("console.error");
    expect(HOOK).toContain("ai.error.shape");
  });
});

describe("a chart must have something to plot", () => {
  /*
    Filling a series' missing colour and format made an EMPTY series valid, and the result
    was three cards under real headings — "Attendance percentage by month", "Present days by
    month" — each containing the words "Nothing to show for this part of the answer". A card
    that promises a chart and delivers a shrug is worse than no card, because the reader
    cannot tell whether they have no data or the product is broken.

    So an empty chart is a validation failure: the model gets a repair round, and if it
    still cannot fill the chart the answer degrades to the fallback's table of the
    underlying figures. Verified live — the third of three chart questions came back
    `fallback` with a table rather than an empty chart.
  */
  const validate = FN.slice(FN.indexOf("function validateSpec"));

  it("names the series-driven chart types", () => {
    expect(validate).toContain('["line_chart", "bar_chart", "area", "donut", "calendar_heatmap"]');
  });

  it("counts points that actually have a value", () => {
    expect(validate).toMatch(/filter\(\(pt\) => pt\.y !== null\)/);
  });

  it("fails the block rather than rendering an empty one", () => {
    const rule = validate.slice(validate.indexOf('["line_chart", "bar_chart"'));
    expect(rule.slice(0, 900)).toMatch(/needs at least one point with a value/);
  });

  it("does not impose the rule on value-driven blocks", () => {
    const rule = validate.slice(validate.indexOf('["line_chart", "bar_chart"'), validate.indexOf('["line_chart", "bar_chart"') + 700);
    // These carry their data in `values`, not `series`.
    expect(rule).not.toContain("kpi_row");
    expect(rule).not.toContain("progress_bars");
    expect(rule).not.toContain("gauge_row");
  });
});
