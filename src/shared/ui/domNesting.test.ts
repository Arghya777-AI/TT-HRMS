/**
 * domNesting.test.ts — no block element inside a `<p>`.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE
 *
 * React reports this as a console WARNING, which means it is invisible in CI, invisible
 * in production, and invisible to anybody not watching devtools on the exact screen that
 * has it. Fifteen instances had accumulated across the app and were only found by
 * driving a browser and reading the console.
 *
 * It is not cosmetic. `<p>` may contain only phrasing content, so on meeting a `<div>`
 * the parser SILENTLY CLOSES THE PARAGRAPH. Everything after the offending child stops
 * being inside the paragraph and becomes its sibling — losing the paragraph's layout,
 * spacing and flex context. On the DataGrid card layout that split a row's title from
 * its own body on narrow screens.
 *
 * `StatusChip` and `Badge` both render a `<div>`, and both are the natural thing to put
 * beside a line of text, which is exactly why this keeps happening.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Components known to render a block-level root. */
const BLOCK_COMPONENTS = ["<StatusChip", "<Badge", "<DataGrid", "<KpiTile", "<PunchLocation"];

/**
 * Remove comments before scanning.
 *
 * Written after this test's FIRST run flagged a file that was already fixed: the
 * explanatory comment above the fix contains the literal text `<p>`, the regex matched
 * it, and the StatusChip forty characters below fell inside the match window. A guard
 * that reports a false positive on the very comment explaining the fix would be turned
 * off within a week, so the scan looks at code only.
 */
function stripComments(source: string): string {
  return source
    // Block comments, including the JSX `{/* … */}` form. Replaced with newlines so
    // reported line numbers still point at the right place.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    // Line comments. Not string-aware, which is acceptable here: a `//` inside a
    // string would blank the rest of that line, and blanking can only cause a MISS
    // in a comment, never a false positive in code.
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (_m, code: string) => code);
}

describe("no block-level component inside a <p>", () => {
  it("finds the components at all — a silent zero would pass vacuously", () => {
    const files = tsxFiles(join(ROOT, "src"));
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no <p> wrapping a StatusChip, Badge, DataGrid, KpiTile or PunchLocation", () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(join(ROOT, "src"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      // `<p>` cannot legally nest, so the first `</p>` after an opening tag is its
      // closer. Body capped so a runaway match cannot swallow the whole file.
      const pattern = /<p\b[^>]*>((?:(?!<\/p>).){0,600})/gs;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const body = match[1] ?? "";
        const found = BLOCK_COMPONENTS.filter((c) => body.includes(c));
        if (found.length > 0) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${file.replace(`${ROOT}/`, "")}:${line} contains ${found.join(", ")}`);
        }
      }
    }

    expect(
      offenders,
      `A <p> may only contain phrasing content. The browser closes the paragraph before a block child, so everything after it silently becomes a sibling — use a <div>:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("DataGrid's card title is a div, since a column may render anything", () => {
    /*
      The specific instance that mattered most: a column's `render` is free to return a
      chip or a location block, so the element wrapping it can never be a `<p>`. This
      one defect affected EVERY grid in the product.
    */
    const grid = readFileSync(join(ROOT, "src/shared/ui/DataGrid.tsx"), "utf8");
    expect(grid).not.toMatch(/<p className="font-medium">\{cellContent/);
    expect(grid).toMatch(/<div className="font-medium">\{cellContent/);
  });
});
