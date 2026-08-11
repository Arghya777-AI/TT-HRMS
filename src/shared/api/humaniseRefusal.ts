/**
 * humaniseRefusal — turn a database refusal into a sentence for the person reading it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Reported, of an employee-facing screen: "Your department needs someone named to
 * cover for you … then show constructive error or not allow to submit form to
 * avoid this type of error across website".
 *
 * Both halves are being done. The forms now list what is missing BEFORE submit
 * (see `SubmitBlockers`), and this handles the other half: what an employee sees
 * when the server refuses anyway. Because it will — a rule can be added to the
 * database tomorrow, two people can race for the same dates, and a screen built
 * next year will not know about either. The last line of defence has to read like
 * a sentence rather than a schema.
 *
 * Showing the raw message was already an improvement on "The change could not be
 * saved" — it is at least true. But the truth it tells is:
 *
 *     handover_to_employee_id is mandatory for operational departments
 *
 * which names a COLUMN. An employee cannot act on a column name; they can act on
 * "pick a colleague to cover for you".
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not invent, soften or generalise. Every pattern below maps ONE known
 * server sentence to the same fact in plain words, keeping the numbers the server
 * supplied — a rewrite that dropped "at most 3" would be worse than the original.
 * Anything unrecognised is passed through untouched, so a new rule shows its own
 * words rather than a vague apology, and the gap is visible.
 *
 * The rules themselves stay in the database. This is translation, never policy.
 */

/** One known refusal and the sentence a person can act on. */
interface Rewrite {
  readonly match: RegExp;
  readonly say: (m: RegExpMatchArray) => string;
}

/*
  Ordered, and the order matters only where two patterns could both match: the
  more specific one is written first. Numbers and names come from the capture
  groups, never from this file.
*/
const REWRITES: readonly Rewrite[] = [
  {
    // The one that was reported.
    match: /handover_to_employee_id is mandatory/i,
    say: () =>
      "Your department needs a named colleague to cover for you while you are away. Choose one under “Who is covering for you”.",
  },
  {
    match: /address_during_leave is required for leave longer than (\d+) days/i,
    say: (m) =>
      `Leave longer than ${m[1] ?? "7"} days needs an address where you can be reached. Add one under “Where you will be”.`,
  },
  {
    match: /leave request overlaps existing request (\S+)/i,
    say: (m) =>
      `You already have leave booked over these dates — request ${m[1] ?? ""}. Withdraw that one first, or pick different dates.`.trim(),
  },
  {
    /*
      The server's own sentence already ends with what to do about it; the only
      change is dropping the leading "insufficient X balance:" so the useful half
      comes first.
    */
    match: /insufficient (.+?) balance: need ([\d.]+) paid day\(s\), ([\d.]+) available/i,
    say: (m) =>
      `You have ${m[3] ?? "0"} day(s) of ${m[1] ?? "that leave"} left and this needs ${m[2] ?? ""}. Reduce the days, or take the difference as unpaid leave.`,
  },
  {
    match: /insufficient comp-off balance: short ([\d.]+) day/i,
    say: (m) => `You are ${m[1] ?? ""} day(s) short of comp-off for this request.`,
  },
  {
    match: /request is ([\d.]+) day\(s\); leave type \S+ allows at most ([\d.]+) per request/i,
    say: (m) =>
      `This request is ${m[1] ?? ""} day(s) and the most you may take in one go is ${m[2] ?? ""}.`,
  },
  {
    match: /request is ([\d.]+) consecutive day\(s\); leave type \S+ allows at most ([\d.]+)/i,
    say: (m) =>
      `This request is ${m[1] ?? ""} day(s) in a row and the most allowed at a stretch is ${m[2] ?? ""}.`,
  },
  {
    match: /request is ([\d.]+) day\(s\); leave type \S+ requires at least ([\d.]+)/i,
    say: (m) =>
      `A request has to be at least ${m[2] ?? ""} day(s), and the dates you chose come to ${m[1] ?? "0"}. Weekly offs and holidays inside the range do not count.`,
  },
  {
    match: /leave type \S+ does not allow half days/i,
    say: () => "This kind of leave has to be taken in whole days.",
  },
  {
    match: /leave type (\S+) may be backdated at most (\d+) day/i,
    say: (m) => `This kind of leave can only be backdated ${m[2] ?? ""} day(s).`,
  },
  {
    match: /you cannot decide (your own|a change to your own)/i,
    say: () => "You cannot decide your own request — it has to go to somebody else.",
  },
  {
    match: /is append-only/i,
    say: () =>
      "This record cannot be changed once written. Add a correcting entry instead of editing this one.",
  },
  {
    match: /days must be a whole or half day/i,
    say: () => "Days go in steps of half a day — 0.5, 1, 1.5, and so on.",
  },
];

/**
 * The sentence to show, or the original when nothing matches.
 *
 * Trailing whitespace is trimmed and nothing else is touched: a server message
 * this file does not recognise is still the best answer available, and hiding it
 * behind something generic is the behaviour being fixed, not repeated.
 */
export function humaniseRefusal(serverMessage: string): string {
  const message = serverMessage.trim();
  if (message === "") return message;
  for (const rewrite of REWRITES) {
    const found = message.match(rewrite.match);
    if (found !== null) return rewrite.say(found);
  }
  return message;
}

/** Exported for the test only — the count is what proves the table is wired. */
export const REFUSAL_REWRITE_COUNT = REWRITES.length;
