/*
  Nothing is deducted from a day any more. Worked = first scan to last scan.

  ── THE VENUE'S DECISION, ASKED FOR TWICE ────────────────────────────────────
  "Don't deduct anything." Staff here are on site across the whole span — a housekeeper who
  scans past the gate camera at 13:04 and again at 13:58 has not left the property, and the
  venue does not want that hour taken off her day. Nor does it want an hour ASSUMED from
  somebody who never scanned a lunch at all.

  Two mechanisms were doing it, and both are switched off here at the POLICY, not in the
  engine, so this is a setting the venue can change back without a deploy:

    · `auto_deduct_break` -> false. This was subtracting the shift's `unpaid_break_minutes`
      whenever no break was recorded — a flat 60 minutes on GRD. It fired on 56 days this
      month, including Chikkiramma (09:05-17:31, two scans, one hour gone) and Rupak Singh
      (07:00-18:52, two scans, one hour gone).

    · `min_break_minutes_to_count` -> 1440. A gap must now be a full day long to count, which
      no gap inside a single day can be. That switches off the alternate-interior-gap rule
      that took Ambresh's 54 minutes and Shivasharana's 57.

  ── WHAT THIS COSTS, STATED PLAINLY ──────────────────────────────────────────
  Roughly 232 hours of paid time across September as it stands, and it removes the only
  protection against a long mid-day absence. The engine's own note records the case: an
  employee whose scans ran 07:36, 07:38, 14:18, 22:12, 22:15 is credited the whole 11h48m
  under this setting, because nothing distinguishes six hours away from six hours working.

  That is the trade the venue has chosen, and it is reversible: set `auto_deduct_break` back
  to true and `min_break_minutes_to_count` back to 15 and the next recompute restores the old
  figures exactly. Nothing here is destructive — no punch, no day and no ledger row is
  rewritten by this migration itself.

  An explicitly recorded break_start/break_end pair is also no longer deducted, and that is
  deliberate rather than an oversight: "don't deduct anything" would be a strange rule to
  apply to everyone except the people honest enough to mark their lunch.
*/

/*
  `audit.log_changes` refuses an UPDATE on this table without a reason, which is right: a
  policy row decides everybody's pay. The sentence is the one an auditor will read next to
  the before-and-after.
*/
SELECT set_config(
  'app.reason',
  'Venue decision: pay the whole span. Break deduction switched off — the assumed lunch (auto_deduct_break) and the interior-gap rule (min_break_minutes_to_count).',
  true);

UPDATE public.attendance_policies
   SET auto_deduct_break          = false,
       min_break_minutes_to_count = 1440
 WHERE auto_deduct_break IS DISTINCT FROM false
    OR min_break_minutes_to_count IS DISTINCT FROM 1440;

COMMENT ON COLUMN public.attendance_policies.auto_deduct_break IS
  'Subtract the shift''s unpaid_break_minutes when no break was recorded. FALSE at this venue: '
  'the day is paid across its whole span. Set true to restore an assumed lunch.';

COMMENT ON COLUMN public.attendance_policies.min_break_minutes_to_count IS
  'Shortest gap that counts as an unpaid break. 1440 at this venue — a full day — which no gap '
  'within one day can reach, so nothing is deducted. Set to 15 to restore the old behaviour.';
