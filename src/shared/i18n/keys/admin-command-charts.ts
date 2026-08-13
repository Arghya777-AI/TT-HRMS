/**
 * i18n keys for the two pictures on the Command Centre (`/admin`).
 *
 * Kept in their own module rather than appended to the `admin.cc.*` block in
 * `en.ts` for the reason the other key modules exist: that file is edited by every
 * feature at once, and a screen's new strings should arrive as a file, not as a
 * diff in the middle of eleven thousand lines.
 *
 * The ring's caption reads with the figure inside the ring, not on its own —
 * "14" above, "in, of 42 on the board" beneath — which is why it starts
 * lower-case and carries no number of its own.
 */
export const keysAdminCommandCharts = {
  "admin.cc.ops.ring.title": "People in right now, against everyone on today's board",
  "admin.cc.ops.ring.caption": "in, of {total} on the board",
  "admin.cc.ops.ring.drill": "Open the live board, everyone who is in",

  "admin.cc.alerts.mix.title": "Open exceptions by severity",
  /* One key per severity rather than one with a `{severity}` placeholder: the chip
     labels are capitalised ("For information"), and "Open the For information
     alerts" is not a sentence a screen reader should have to say. */
  "admin.cc.alerts.mix.drill.critical": "Open the critical alerts",
  "admin.cc.alerts.mix.drill.warning": "Open the warning alerts",
  "admin.cc.alerts.mix.drill.info": "Open the alerts logged for information",
} as const;
