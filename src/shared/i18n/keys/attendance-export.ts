/**
 * attendance-export.ts — the words inside the downloaded workbook.
 *
 * Kept apart from the screen catalogues because they have a different audience and a different
 * lifetime: these strings are read in Excel, months later, by somebody who may never have seen
 * the console. Every duration column says its unit in the header, because a spreadsheet has no
 * tooltip to explain that 480 is minutes.
 */
export const keysAttendanceExport = {
  "attendance.export.title": "Attendance and leave",

  "attendance.export.sheet.about": "About",
  "attendance.export.sheet.summary": "Summary",
  "attendance.export.sheet.balances": "Leave balances",
  "attendance.export.sheet.dayWise": "Day wise",
  "attendance.export.sheet.monthWise": "Month wise",

  "attendance.export.about.report": "Report",
  "attendance.export.about.period": "Period",
  "attendance.export.about.from": "From",
  "attendance.export.about.to": "To",
  "attendance.export.about.people": "Employees",
  "attendance.export.about.generated": "Generated",
  "attendance.export.about.basis": "How to read it",
  "attendance.export.about.basisText":
    "Day counts, paid days, worked minutes and overtime are the server's own figures, the same "
    + "ones the attendance screens show. Over/under compares what was worked against what the "
    + "shift asked for: a holiday, a weekly off and a full day of approved leave ask for "
    + "nothing, and half a day of leave asks for half. Today is still being measured and is "
    + "excluded until it ends at 11:59 pm IST, as are dates that have not happened yet.",
  "attendance.export.about.capped": "Incomplete",
  "attendance.export.about.cappedText":
    "This period held more days than one download can carry, so the day rows below are only "
    + "part of it and the over/under figures have been left blank rather than shown wrong. "
    + "Export a shorter period, or one employee at a time.",

  "attendance.export.col.field": "Field",
  "attendance.export.col.value": "Value",
  "attendance.export.col.code": "Code",
  "attendance.export.col.name": "Employee",
  "attendance.export.col.from": "From",
  "attendance.export.col.to": "To",
  "attendance.export.col.date": "Date",
  "attendance.export.col.day": "Day",
  "attendance.export.col.month": "Month",
  "attendance.export.col.status": "Status",
  "attendance.export.col.shift": "Shift",
  "attendance.export.col.firstIn": "First scan",
  "attendance.export.col.lastOut": "Last scan",
  "attendance.export.col.workingDays": "Working days",
  "attendance.export.col.present": "Present",
  "attendance.export.col.halfDays": "Half days",
  "attendance.export.col.absent": "Absent",
  "attendance.export.col.leaveDays": "On leave",
  "attendance.export.col.weeklyOffs": "Weekly offs",
  "attendance.export.col.holidays": "Holidays",
  "attendance.export.col.paidDays": "Paid days",
  "attendance.export.col.workedMin": "Worked (minutes)",
  "attendance.export.col.workedHm": "Worked",
  "attendance.export.col.shiftMin": "Shift (minutes)",
  "attendance.export.col.otMin": "Overtime (minutes)",
  "attendance.export.col.otApprovedMin": "Approved OT (minutes)",
  "attendance.export.col.lateDays": "Late days",
  "attendance.export.col.lateMin": "Late (minutes)",
  "attendance.export.col.earlyDays": "Early exits",
  "attendance.export.col.earlyMin": "Early (minutes)",
  "attendance.export.col.varianceMin": "Over/under (minutes)",
  "attendance.export.col.extraMin": "Worked extra (minutes)",
  "attendance.export.col.shortMin": "Worked short (minutes)",
  "attendance.export.col.counted": "Days counted",
  "attendance.export.col.processing": "Getting processed",
  "attendance.export.col.future": "Still to come",
  "attendance.export.col.unresolved": "Not processed yet",
  "attendance.export.col.paidFraction": "Paid fraction",
  "attendance.export.col.note": "Note",
  "attendance.export.col.leaveType": "Leave type",
  "attendance.export.col.entitlement": "Entitlement",
  "attendance.export.col.carriedForward": "Carried forward",
  "attendance.export.col.accrued": "Accrued",
  "attendance.export.col.taken": "Taken",
  "attendance.export.col.held": "Held (pending)",
  "attendance.export.col.left": "Left",
  "attendance.export.col.lapsed": "Lapsed",

  "attendance.export.file.everyone": "all-employees",

  /* The button and its menu. */
  "attendance.export.button": "Download Excel",
  "attendance.export.busy": "Preparing… {done} of {total}",
  "attendance.export.menu.week": "This week (day by day)",
  "attendance.export.menu.month": "This month (day by day)",
  "attendance.export.menu.year": "This year (month by month)",
  "attendance.export.menu.scopeOne": "For this employee",
  "attendance.export.menu.scopeAll": "For every employee",
  "attendance.export.menu.hint":
    "Each file holds a summary, leave balances with carry forward, and the period's rows.",
  "attendance.export.failed": "The download could not be prepared: {reason}",

  "attendance.export.note.future": "Still to come",
  "attendance.export.note.unresolved": "Not processed yet",
} as const;
