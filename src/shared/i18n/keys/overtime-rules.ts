/**
 * i18n keys owned EXCLUSIVELY by the overtime-rules work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: `OvertimeRulesCard` on /me/comp-off.
 *
 * THE COPY CARRIES THE SHAPE, NEVER THE FIGURES. Every duration and count is interpolated
 * from the policy and shift rows the engine itself reads, so an administrator editing the
 * policy changes this card too. A sentence with "4 hours" baked into it would be correct
 * today and silently wrong afterwards.
 */
export const keysOvertimeRules = {
  "leave.otRules.title": "How overtime and comp-off are worked out",
  "leave.otRules.subtitle":
    "These are the rules actually applied to your days — read from your own shift and attendance policy, not a general description.",

  // ── Overtime ──────────────────────────────────────────────────────────────
  "leave.otRules.ot.heading": "Overtime — on a normal working day",
  "leave.otRules.ot.shiftLine": "Your shift is {name}, {start} to {end} ({hours}).",
  "leave.otRules.ot.noShift":
    "You have no shift assigned, so overtime cannot be calculated for your days. Ask HR to assign one.",
  "leave.otRules.ot.disabled":
    "Overtime is switched off in your attendance policy, so no overtime minutes are recorded.",
  "leave.otRules.ot.step1": "Your shift's paid length",
  "leave.otRules.ot.step2": "Ignored past the shift before overtime starts",
  "leave.otRules.ot.step3": "Smallest amount that counts at all",
  "leave.otRules.ot.step4": "Rounded down to the nearest",
  "leave.otRules.ot.step5": "Most that can count in one day",
  "leave.otRules.ot.roundingValue": "{n} min",
  "leave.otRules.ot.example":
    "So overtime begins once your worked time passes {shift} plus {threshold}. Anything under the minimum is not carried forward — it is not banked for another day.",
  "leave.otRules.ot.grace":
    "Arriving by {minutes} minutes after {start} is not counted late.",

  // ── Comp-off ──────────────────────────────────────────────────────────────
  "leave.otRules.compOff.heading": "Comp-off — for working a weekly off or a holiday",
  "leave.otRules.compOff.intro":
    "Work on a day you were meant to be off and the whole day counts as extra work. What it earns depends only on how long you worked — there is no part-day beyond a half.",
  "leave.otRules.compOff.half": "Half a day once you work at least",
  "leave.otRules.compOff.full": "A full day once you work at least",
  "leave.otRules.compOff.expiry": "A credit expires after",
  "leave.otRules.compOff.expiryValue": "{n} days",
  "leave.otRules.compOff.step1": "1 · You work a weekly off or a holiday.",
  "leave.otRules.compOff.step2":
    "2 · The credit is created for you automatically — you do not have to claim it.",
  "leave.otRules.compOff.step3":
    "3 · It waits for approval before it can be spent, and shows as awaiting approval until then.",
  "leave.otRules.compOff.step4":
    "4 · To take it, apply for comp-off leave like any other leave. Your manager approves it.",
  "leave.otRules.compOff.notOvertime":
    "Comp-off comes from extra work on an off day, never from overtime on a working day. Working late on a weekday earns overtime instead — the two are separate and one is not converted into the other.",

  "leave.otRules.source": "From your attendance policy, {policy}.",
  "leave.otRules.noPolicy":
    "No attendance policy resolves for you, so the system's built-in defaults apply. Ask HR to assign a policy.",
} as const;
