/**
 * i18n keys owned EXCLUSIVELY by the home-calendar work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: `MyMonthCalendar` on the employee home screen.
 *
 * THE STATUS WORDS ARE THE ACCESSIBLE CARRIER of a state the grid also shows as a
 * colour and a letter. They are therefore full words, not abbreviations — the cell has
 * the abbreviation already.
 */
export const keysHomeCalendar = {
  "home.cal.title": "My month",
  "home.cal.previous": "Previous month",
  "home.cal.next": "Next month",
  "home.cal.noRecord": "No attendance record for this day yet.",
  "home.cal.tapHint": "Tap any day to see your shift, punches and hours.",
  "home.cal.overtimeTotal": "{hours} of overtime this month — it can be claimed as comp-off.",
  "home.cal.openAttendance": "Full attendance",

  "home.cal.field.status": "Status",
  "home.cal.field.shift": "Shift",
  "home.cal.field.inOut": "In → Out",
  "home.cal.field.worked": "Worked",
  "home.cal.field.late": "Late by",
  "home.cal.field.overtime": "Overtime",
  "home.cal.field.leaveType": "Leave type",
  "home.cal.field.holiday": "Holiday",

  "home.cal.status.present": "Present",
  "home.cal.status.wfh": "Worked from home",
  "home.cal.status.onDuty": "On duty",
  "home.cal.status.halfDay": "Half day",
  "home.cal.status.absent": "Absent",
  "home.cal.status.onLeave": "On leave",
  "home.cal.status.onLeaveHalf": "On leave — half day",
  "home.cal.status.compOff": "Comp-off availed",
  "home.cal.status.weeklyOff": "Weekly off",
  "home.cal.status.holiday": "Holiday",
  "home.cal.status.weeklyOffWorked": "Worked on a weekly off",
  "home.cal.status.holidayWorked": "Worked on a holiday",
  "home.cal.status.pending": "Not yet settled",

  /*
    WHO RECORDED THE DAY — a second colour code, answering a different question from
    the status words above. Those say what the day was; these say where it came from.

    Phrased from the employee's side ("you", "your request") because this calendar is
    only ever read by the person whose month it is. "Set by HR" names the actor rather
    than the mechanism: `manual_override_status` is not a sentence anybody wants to
    read about their own pay.
  */
  "home.cal.by.legend": "Recorded by",
  "home.cal.by.self": "Your own punches",
  "home.cal.by.corrected": "Corrected on your request",
  "home.cal.by.hrOverride": "Set by HR",
  "home.cal.field.recordedBy": "Recorded by",
  "home.cal.field.overrideReason": "HR's reason",
} as const;
