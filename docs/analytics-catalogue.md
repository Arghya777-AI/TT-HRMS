# HR & admin analytics — the metric catalogue

Every measure below is grounded in a column or view that **exists today**. Nothing here
is aspirational: where the data cannot answer a question an HR head would reasonably
ask, that is recorded as a gap rather than quietly approximated. An analytics screen
that invents a number is worse than one that admits a blank, because the invented one
gets used in a decision.

Organised by the question, not by the table — a dashboard is a set of answers.

---

## 0. The two rules everything obeys

**Every measure is filter-aware.** `AnalyticsFilters` (period + department + location +
employee + capture source) narrows every query. A tile, a bar and a table row all carry
the current filters into whatever they open, via `withFilters()`. A number that does not
respond to the filter bar is a bug, not a shortcut.

**Every measure is traceable.** For each one below, the source column is named. A
displayed number must be attributable to a column or to an aggregation over named
columns — this is the repo's existing DR-28/DR-29 discipline ("a tile must be the
cardinality of exactly the row set its drill-through opens").

---

## 1. Who is here right now — the live board

Source: `v_attendance_today_board` (one row per employee, today).

| Measure | Column |
|---|---|
| Present now | `attended` |
| Yet to reach | `yet_to_reach` |
| Late in | `late_in` / `is_late`, `late_minutes` |
| On time | `on_time` |
| Overdue (past expected) | `overdue`, `expected_by` |
| Off today | `off_today` |
| **Captured on web vs on-premise** | `web_punch_count` vs `punch_count` |

This block is the one the client asked for first — "how much is present today". It is
also the block that must be **live**: `attendance_punches` and `attendance_days` are
both in the `supabase_realtime` publication (migration `20260801004000`), so a punch at
the gate should move these tiles without a refresh.

---

## 2. Headcount and org shape

Source: `v_admin_employee` (111 columns), `v_headcount_daily` (`as_of_date`,
`department_id`, `department_name`, `employment_type`, `headcount`, `joiners`, `exits`).

- **Total headcount**, and headcount by `department_name`, `section_name`,
  `designation_name`, `grade_name`, `location_name`, `cost_centre_name`,
  `employment_type`.
- **Managers in the system** — distinct non-null `reporting_manager_id`. Note the
  distinction the dashboard must not blur: *people who manage someone* (derived) is not
  the same as *people with the manager role* (`user_roles.role = 'manager'`). Show the
  first; label it "people with reportees".
- **Span of control** — headcount ÷ distinct managers, and the distribution (a manager
  with 19 reportees is a finding).
- **Headcount trend** over the period from `v_headcount_daily.as_of_date`.
- **Joiners and exits** in the period (`joiners`, `exits`, or `date_of_join` /
  `last_working_day` within range).

## 3. Movement, tenure and risk

- **Attrition rate** = exits ÷ average headcount over the period. State the formula on
  screen; every HR team defines it slightly differently and an unlabelled percentage
  starts an argument.
- **Tenure distribution** — buckets from `date_of_join` (<3m, 3–12m, 1–3y, 3y+).
- **Probation watch** — `confirmation_due_date` in or before the period and
  `confirmed_on IS NULL`. This is an action list, not a statistic.
- **Contract expiry watch** — `contract_end_date` approaching.
- **Serving notice** — `resignation_date` set, `last_working_day` in the future;
  `notice_period_days`.
- **Exit quality** — `exit_type`, `exit_reason`, `exit_interview_done`,
  `is_rehire_eligible`, `full_and_final_settled_on`.

## 4. Diversity and workforce composition

From `v_admin_employee`: `gender`, `category`, `is_differently_abled`, `nationality`,
`marital_status`, `employment_type`, and an age distribution from `date_of_birth`.

> **Handle with care.** `religion`, `category` and `disability_type` are special-category
> personal data under the DPDP Act. Aggregate counts only, never a drill-through to named
> individuals, and never in an export that leaves the building. The drill-down rule that
> applies everywhere else is deliberately **switched off** for these.

## 5. Attendance behaviour — the analytical core

Source: `v_attendance_day_enriched`, one row per employee per IST day. This single view
answers most of what the client described.

| Question | Column |
|---|---|
| Average work time | `total_worked_minutes` (and `payable_worked_minutes`) |
| Average time in office | `gross_span_minutes` |
| Average arrival / departure | `first_in_at` / `last_out_at` (wall clock via `first_in_hm` / `last_out_hm`) |
| Average break | `break_minutes`, `break_count` |
| Lateness | `is_late`, `late_minutes` |
| Early exits | `is_early_exit`, `early_exit_minutes` |
| Overtime | `overtime_minutes`, `approved_overtime_minutes`, `extra_work_minutes` |
| Leave | `leave_type_name`, `leave_day_fraction` |
| Data quality | `is_regularized`, `manual_override_status`, `anomaly_flags`, `has_anomalies` |
| Calendar context | `is_holiday`, `is_weekly_off`, `is_working_day` |

**The averaging trap.** An employee with no punch on a working day did not work zero
minutes — they were absent. Including them as 0 drags every mean down and makes the
dashboard lie. Averages are over **days with data**, and the denominator is stated.
Similarly, weekly offs and holidays must be excluded from "average worked hours" unless
the user explicitly asks for calendar-day averages.

Distributions worth charting: arrival-time histogram (`v_attendance_hour_buckets`),
late trend (`v_attendance_late_trend`), in-trend (`v_attendance_in_trend`), break trend
(`v_break_trend`).

## 6. Leave

`v_leave_balance_current`, `v_leave_ledger_statement`, `v_leave_calendar`,
`v_comp_off_balance`.

- Balance by leave type; **leave liability** (the accrued balance the company owes).
- Leave taken in the period by type and department.
- Comp-off earned vs expiring — expiring credits are an action list.
- Calendar density: who is off on the same day (the roster risk view).

## 7. Payroll and cost

`v_payroll_cost_monthly`, `v_payroll_variance`, `v_employee_current_salary`.

- Cost by month, by department, by cost centre.
- **Variance vs the previous run** — the number a finance director opens first.
- Overtime cost as a share of total.

> Salary is need-to-know. Gate these tiles on the payroll capability and keep individual
> figures out of any department-level export.

## 8. Compliance and readiness

- **Document compliance** — `v_document_compliance`; expiring documents.
- **Policy acknowledgement** — `v_policy_acknowledgement_status`.
- **Statutory flags** — `pf_applicable`, `esi_applicable`, `professional_tax_applicable`,
  `lwf_applicable`, `tax_regime`.
- **Profile completeness** — `profile_completeness_pct`, a good nudge metric.
- **Biometric coverage** — `v_enrolment_coverage`, `face_enrolled_at`,
  `fingerprint_enrolled_at`; who cannot use the gate and why.
- **Gate health** — `v_kiosk_health` (match rate, p50/p95 latency, offline replays).

## 9. Operations

- **Approvals** — `v_approval_inbox`, `v_approval_sla` (breaches are the metric, not volume).
- **Exceptions** — `v_exception_queue`.
- **Assets** — `v_asset_custody`; items out with people who have left is a real finding.

---

## Known gaps — say these are missing rather than approximate them

- **No recruitment or vacancy data.** "Open positions", "time to hire" and "offer
  acceptance" cannot be computed; there is no requisition table.
- **No performance ratings table.** The client asked "how much they are performing" —
  what the data supports is *attendance* performance (punctuality, hours, overtime,
  anomalies), not appraisal. The dashboard must label it as attendance performance, or
  it implies a judgement the system has not made.
- **No training or certification completion** beyond the certification claim flow.
- **No engagement or survey data.**
- **Salary history exists** (`v_salary_revisions`) but there is no compa-ratio or band
  midpoint, so pay-equity analysis is not currently possible.

---

## Making it dynamic

`supabase_realtime` already publishes `attendance_punches`, `attendance_days`,
`approval_requests`, `notifications`, `leave_requests`, `roster_slots`, `kiosk_devices`,
`payroll_runs`, `attendance_recompute_runs`, `announcements`, `system_health` and
`ai_messages` (migration `20260801004000`).

`src/features/home/api/home.api.ts` already contains a working subscription to model on.
The analytics layer should subscribe once, at the dashboard level, and invalidate the
analytics query keys on change — so a punch at the gate moves the "present now" tile and
every chart derived from it, without anybody pressing refresh. Polling is the fallback
for tables not in the publication, not the default.
