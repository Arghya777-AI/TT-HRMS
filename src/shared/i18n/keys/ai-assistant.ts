/**
 * i18n keys owned EXCLUSIVELY by the Regal Lab AI Assistant (`features/ai/*`).
 *
 * Two themes run through this copy and both are deliberate.
 *
 * IT NAMES ITS LIMITS. The assistant reads the signed-in person's own records and nothing
 * else — that is enforced in SQL inside `ai-agent`, not by asking the model nicely — and
 * the screen says so, because a reader who does not know the scope cannot judge the answer.
 *
 * IT DOES NOT PROMISE CERTAINTY. "Checked against your records" rather than "here is the
 * answer": every figure is traceable to a tool result and the block shows which, so the
 * copy points at that provenance instead of asserting authority.
 */
export const keysAiAssistant = {
  // ── Page ──────────────────────────────────────────────────────────────────
  "ai.title": "Regal Lab AI Assistant",
  "ai.subtitle":
    "Ask about your own attendance, leave and pay. Every answer is built from your records, shows which data it used, and can be downloaded as Excel or PDF.",
  "ai.placeholder": "Ask about your attendance, leave or pay…",
  "ai.send": "Ask",
  "ai.newThread": "New thread",

  // ── Waiting ───────────────────────────────────────────────────────────────
  /**
   * Names the stage rather than spinning silently. An answer takes 15–25 seconds because
   * the function may run several tool round-trips first; a reader who thinks it has hung
   * asks again and spends the tokens twice.
   */
  "ai.thinking": "Reading your records and building the answer — this takes a few seconds.",

  // ── Empty ─────────────────────────────────────────────────────────────────
  "ai.empty.title": "Ask a question about your own record",
  "ai.empty.hint":
    "It can only see your attendance, leave, comp-off and pay — never a colleague's. Try one of the questions below, or type your own.",

  // ── Modes ─────────────────────────────────────────────────────────────────
  "ai.mode.panel": "Quick",
  "ai.mode.analyst": "Detailed",
  "ai.mode.hint":
    "Quick answers one question. Detailed spends longer and looks at more of your history — useful for trends and comparisons.",

  // ── Blocks ────────────────────────────────────────────────────────────────
  "ai.block.empty": "Nothing to show for this part of the answer.",
  /**
   * A block type this build cannot draw. Shown rather than dropped: the function can add
   * a block type without a frontend deploy, and silently discarding one would give a
   * reader less than the answer contained with no sign that anything was missing.
   */
  "ai.block.unsupported":
    "This answer included a “{type}” panel that this screen cannot draw yet. Nothing was lost — ask for it as a table and it will export.",
  "ai.masked": "masked",

  // ── Provenance ────────────────────────────────────────────────────────────
  "ai.citation.tool": "From {tool}",
  "ai.citation.rows": "{rows} rows",
  "ai.citation.truncated": "capped — the answer may not cover the whole period",

  // ── Export ────────────────────────────────────────────────────────────────
  "ai.export.excel": "Excel",
  "ai.export.pdf": "PDF",
  "ai.export.title": "Assistant answer",

  // ── Footnotes ─────────────────────────────────────────────────────────────
  /** Cost is shown, not hidden: it is the company's money and an admin can see the ledger. */
  "ai.scopeNote":
    "Answers cover your own records only, as at {today} (IST). Figures come from the same tables the rest of the app reads — if a number here disagrees with a screen, trust the screen and tell HR.",
} as const;
