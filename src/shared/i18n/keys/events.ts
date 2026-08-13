/**
 * events.ts — the strings for /admin/org/events, the venue diary.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`,
 * so two people appending to one catalogue silently lose each other's keys.
 *
 * The refusals below restate CHECK constraints from migration 043100 —
 * `ck_events__span`, `ck_events__call_before_start`, `ck_events__guests` — in the
 * same words the server would use. A venue manager should not get one sentence
 * from the form and a different one from the database for the same rule.
 */
export const keysEvents = {
  "events.title": "Event register",
  "events.subtitle": "The venue diary — what is booked, and who is rostered for it.",

  // ── Filters ─────────────────────────────────────────────────────────────────
  "events.filter.window": "Showing",
  "events.filter.window.upcoming": "From today onwards",
  "events.filter.window.past": "Everything, including past bookings",
  "events.filter.status": "Status",
  "events.filter.status.all": "All except cancelled",
  "events.filter.status.cancelled": "Include cancelled",

  // ── The register ────────────────────────────────────────────────────────────
  "events.list.title": "Bookings",
  "events.list.hint":
    "Soonest first — this register is read to find out what is coming, so the next booking is at the top.",
  "events.list.empty.title": "Nothing is booked",
  "events.list.empty.hint":
    "Book one below. Until an event exists, a roster slot cannot be attached to it and the venue's event-driven holiday rules have nothing to fire on.",
  "events.col.code": "Reference",
  "events.col.title": "Event",
  "events.col.client": "Client",
  "events.col.type": "Type",
  "events.col.call": "Call time",
  "events.col.starts": "Starts",
  "events.col.ends": "Ends",
  "events.col.guests": "Guests",
  "events.col.status": "Status",
  "events.guests.expected": "{n} expected",
  "events.guests.actual": "{n} came",
  "events.guests.none": "Not counted yet",

  "events.status.enquiry": "Enquiry",
  "events.status.confirmed": "Confirmed",
  "events.status.completed": "Completed",
  "events.status.cancelled": "Cancelled",

  "events.type.wedding": "Wedding",
  "events.type.reception": "Reception",
  "events.type.corporate": "Corporate",
  "events.type.conference": "Conference",
  "events.type.birthday": "Birthday",
  "events.type.photoshoot": "Photoshoot",
  "events.type.other": "Other",

  // ── Coverage ────────────────────────────────────────────────────────────────
  "events.coverage.title": "Rostered against required",
  "events.coverage.hint":
    "Read from the coverage view, so this figure and the roster planner's cannot drift apart. A department with no stated requirement counts as zero required, not as covered.",
  "events.coverage.empty.title": "No labour requirement has been recorded",
  "events.coverage.empty.hint":
    "An event carries a required headcount per department. Until one is entered, there is nothing to be short of — this shows a shortfall, never invents one.",
  "events.coverage.col.event": "Event",
  "events.coverage.col.dept": "Department",
  "events.coverage.col.required": "Required",
  "events.coverage.col.rostered": "Rostered",
  "events.coverage.col.short": "Short by",
  "events.coverage.covered": "Covered",
  "events.coverage.noDept": "No department named",

  // ── The same table, on /admin/attendance/coverage ───────────────────────────
  "admin.coverage.events.hint":
    "Bookings starting in this week, with what each department needs and what is rostered against it. The shortfall is computed once, in the database, so this screen and the event register cannot disagree.",
  "admin.coverage.events.empty.title": "No booking this week states a requirement",
  "admin.coverage.events.empty.hint":
    "Either nothing is booked in this week, or no required headcount has been recorded against what is. A shortfall is only shown where a requirement exists — it is never inferred from the roster.",

  // ── Booking one ─────────────────────────────────────────────────────────────
  "events.new.title": "Book an event",
  "events.new.hint":
    "The reference is what the venue calls it on the phone. Everything else can be corrected later; the dates are what the roster is built against.",
  "events.new.code": "Reference",
  "events.new.code.hint": "For example EVT-2026-0143. One per company.",
  "events.new.name": "What it is",
  "events.new.client": "Client",
  "events.new.type": "Type",
  "events.new.status": "Status",
  "events.new.location": "Venue",
  "events.new.location.none": "Not decided yet",
  "events.new.startDate": "Starts on",
  "events.new.startTime": "at",
  "events.new.endDate": "Ends on",
  "events.new.endTime": "at",
  "events.new.callTime": "Call time",
  "events.new.callTime.hint":
    "When staff are called in, on the start date. Earlier than when guests arrive — this is what the roster is built against.",
  "events.new.guests": "Guests expected",
  "events.new.guests.hint": "A forecast until the night; leave blank if nobody has said.",
  "events.new.notes": "Notes",
  "events.new.submit": "Book it",
  "events.new.submitting": "Booking…",
  "events.new.done": "The event is booked",
  "events.new.doneDetail":
    "It can now be rostered against, and the venue's event-driven holiday rules apply to its dates.",

  "events.new.blocked.title": "Before this can be booked",
  "events.new.blocked.code": "Give it a reference.",
  "events.new.blocked.name": "Say what the event is.",
  "events.new.blocked.dates": "Give a start date and time, and an end date and time.",
  "events.new.blocked.span": "An event cannot end before it starts.",
  "events.new.blocked.call": "The call time cannot be after the event starts — staff arrive first.",
  "events.new.blocked.guests": "A guest count cannot be negative.",
  "events.new.blocked.company": "No company could be read, so there is nothing to book against.",
} as const;
