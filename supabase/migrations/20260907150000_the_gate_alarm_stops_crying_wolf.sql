/*
  THE GATE ALARM STOPS CRYING WOLF.

  `public.notifications` holds 58,762 rows. 57,803 of them — 98.4% — are KIOSK_OFFLINE.
  Everything else the venue has ever been told, across six weeks, is the remaining 959.

  The consequence is measurable and was the real complaint: Suraj Kumar had 17,890 unread
  in-app notifications, Vinod Maurya 8,997, Preethi Machani 8,250. Nobody reads a feed like
  that, so nothing in it gets read — including the things that matter.

  ── THE CAUSE IS NOT THE ALERT, IT IS THE DEVICE LIST ───────────────────────────────────────
  Eighteen kiosk devices are registered and every one of them is marked active. Their names
  say what they are: "test", "test2", "Test 2", "Pai", "Ranjeeth Phone", "Arghya", "Suraj",
  "Sunil phone", "Phone 2", "Ipad tt", "Ranjeeth test tablet", and three unnamed gate devices
  that have NEVER checked in once. Exactly one device has ever done a day's work:
  GATE-6AW6G8, "Official tt gate Red", with 1,586 punches.

  `cron-integrity` correctly reports every active device that has gone silent, once per device
  per IST hour, to every administrator. Seventeen dead registrations × 24 hours × six admins
  is the flood. The alert was never wrong; it was answering a question about a device list
  nobody had tidied.

  So this retires the dead registrations rather than muting the alarm. KIOSK_OFFLINE stays
  fully armed for the gate that is actually in service — which is the point: after this, an
  alert about GATE-6AW6G8 means the venue's real gate is down, and somebody will see it.

  ── WHAT IS NOT DONE HERE ───────────────────────────────────────────────────────────────────
  No device is deleted. `is_active = false` is reversible, keeps every row for audit, and is
  what the kiosk console itself toggles. A device that has taken even one punch is LEFT ACTIVE
  — several of those are staff phones acting as gates, and deactivating one at handover could
  stop somebody punching tomorrow morning. Only the eleven that have never produced a single
  punch are retired.

  `system_health` is untouched: `cron-integrity` pushes a health row separately from the
  notification, so /admin/kiosk keeps reporting every device's true state either way. This
  changes who gets told at 3am, not what is known.
*/

/* `audit.log_changes()` wants a reason for these, and is right to. */
SELECT set_config('app.reason',
                  'Handover: retiring kiosk registrations that have never taken a punch', false);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Retire the dead registrations.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
UPDATE public.kiosk_devices k
   SET is_active = false
 WHERE k.is_active
   AND NOT EXISTS (
     SELECT 1 FROM public.attendance_punches p WHERE p.kiosk_device_id = k.id
   );

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. Clear the backlog.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
/*
  Deleted, not marked read. These are six weeks of "a tablet that was never plugged in is
  still not plugged in", addressed to people who have already stopped looking; marking them
  read would leave 57,803 rows for every future query to page past. The table has no delete
  trigger and nothing references it.

  The dedupe keys go with them. That is deliberate and harmless: a key is
  `kiosk_offline:<device>:<date>T<hour>`, so an hour already past can never be re-inserted,
  and the devices that produced them are retired above.
*/
DELETE FROM public.notifications WHERE event_code = 'KIOSK_OFFLINE';
