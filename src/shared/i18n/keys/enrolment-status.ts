/**
 * i18n keys owned EXCLUSIVELY by the enrolment-status work. One file per author — `t()`
 * is typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Surface: the "who is enrolled, who is not" roster on `/admin/kiosk/enrolment`, its
 * filter row, its status words and its download.
 *
 * THE STATUS WORDS CARRY THE ACTION. "Not enrolled" alone tells an administrator
 * nothing they can do; each of the three reasons names a different next step, and
 * `consent_withdrawn` names the absence of one. The hints are written to be read in a
 * table cell, so they stay short enough not to wrap the row.
 */
export const keysEnrolmentStatus = {
  // ── Section shell ─────────────────────────────────────────────────────────
  "admin.enrolStatus.title": "Enrolment status — everyone",
  "admin.enrolStatus.subtitle":
    "Every enrollable employee, enrolled or not. Filter to the group you want, then download exactly that group.",

  // ── Filters ───────────────────────────────────────────────────────────────
  "admin.enrolStatus.filter.all": "Everyone",
  "admin.enrolStatus.filter.enrolled": "Enrolled",
  "admin.enrolStatus.filter.not_enrolled": "Not enrolled",
  "admin.enrolStatus.filter.no_consent": "Consent not recorded",
  "admin.enrolStatus.filter.consented_not_enrolled": "Consented, no capture",
  "admin.enrolStatus.filter.consent_withdrawn": "Consent withdrawn",
  "admin.enrolStatus.filter.excluded": "Not on attendance",
  "admin.enrolStatus.filter.aria": "Filter the roster by enrolment status",

  // ── The status words ──────────────────────────────────────────────────────
  "admin.enrolStatus.state.enrolled": "Enrolled",
  "admin.enrolStatus.state.no_consent": "Not enrolled — consent not recorded",
  "admin.enrolStatus.state.consented_not_enrolled": "Not enrolled — awaiting capture",
  "admin.enrolStatus.state.consent_withdrawn": "Not enrolled — consent withdrawn",
  "admin.enrolStatus.state.excluded": "Not on attendance",

  "admin.enrolStatus.next.enrolled": "Face is live at the gate.",
  "admin.enrolStatus.next.no_consent":
    "Record consent first — the server refuses a capture without it.",
  "admin.enrolStatus.next.consented_not_enrolled":
    "Consent is on file. Capture five poses, then a second administrator approves.",
  "admin.enrolStatus.next.consent_withdrawn":
    "Nothing to do — this person punches by another method and is never chased.",
  "admin.enrolStatus.next.excluded":
    "Nothing to do — excluded from attendance, so the gate never looks for them.",

  // ── Columns ───────────────────────────────────────────────────────────────
  "admin.enrolStatus.col.employee": "Employee",
  "admin.enrolStatus.col.department": "Department",
  "admin.enrolStatus.col.designation": "Designation",
  "admin.enrolStatus.col.joined": "Joined",
  "admin.enrolStatus.col.status": "Enrolment status",
  "admin.enrolStatus.col.next": "What is needed",
  "admin.enrolStatus.col.consent": "Consent recorded",
  "admin.enrolStatus.col.since": "Enrolled since",
  "admin.enrolStatus.col.email": "Work email",

  // ── Tiles ─────────────────────────────────────────────────────────────────
  "admin.enrolStatus.kpi.total": "Enrollable employees",
  "admin.enrolStatus.kpi.enrolled": "Enrolled",
  "admin.enrolStatus.kpi.notEnrolled": "Not enrolled",
  "admin.enrolStatus.kpi.coverage": "Coverage",
  "admin.enrolStatus.kpi.coverageHint":
    "Enrolled ÷ everyone except withdrawn consents and attendance exclusions",
  "admin.enrolStatus.kpi.notEnrolledHint": "Consent missing, awaiting capture, or withdrawn",
  "admin.enrolStatus.kpi.excluded": "Not on attendance",
  "admin.enrolStatus.kpi.excludedHint": "Excluded from attendance — never a shortfall",

  // ── Download ──────────────────────────────────────────────────────────────
  "admin.enrolStatus.download": "Download this list",
  "admin.enrolStatus.download.excel": "Excel",
  "admin.enrolStatus.download.pdf": "PDF",
  "admin.enrolStatus.download.title": "Face enrolment status",
  "admin.enrolStatus.downloadCount": "{n} row(s) will be written — the filter you can see.",

  // ── Empty ─────────────────────────────────────────────────────────────────
  "admin.enrolStatus.empty.title": "Nobody under this filter",
  "admin.enrolStatus.empty.hint":
    "Every enrollable employee falls under one of the other groups. Switch to Everyone to see the full roster.",
} as const;
