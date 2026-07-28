/**
 * i18n keys owned EXCLUSIVELY by the Leave & Cost panel — `components/LeaveCostPanel.tsx`,
 * `api/hr-leavecost.api.ts` and `hrLeaveCostAggregate.ts`.
 *
 * Its own file, like every other author's: `t()` is typed on `keyof typeof en`, so two
 * people appending to one catalogue silently lose each other's keys.
 *
 * MOST OF THE COPY BELOW IS DOING WORK, NOT DECORATION. The caveats exist because this
 * panel answers six questions from six relations that disagree about what a "period", a
 * "department" and an "employee" mean, and a reader who is not told which of those a
 * figure honoured cannot check it. In particular `liabilityInDays` is the panel saying
 * out loud that it will not invent a daily rate, which is the whole reason the headline
 * liability is a day count and not a rupee figure.
 */
export const keysHrLeaveCost = {
  // ── Panel chrome ──────────────────────────────────────────────────────────
  "hr.leavecost.title": "Leave & cost",
  "hr.leavecost.subtitle":
    "What leave is owed, what was taken, what is about to lapse — and what payroll cost.",
  "hr.leavecost.section.leave": "Leave",
  "hr.leavecost.section.cost": "Cost",
  /**
   * The unit travels WITH the figure, on every tile that reports days. The panel's
   * headline liability is a day count and reads as one at a glance, so it can never
   * be mistaken for the rupee figure this panel refuses to invent.
   */
  "hr.leavecost.days": "{days} days",
  /** The null-department bucket. A real bucket: somebody can exist before placement. */
  "hr.leavecost.unassigned": "Not assigned",
  // Said on EVERY capped chart. A top-N that does not admit it is a top-N is how a
  // picture of fourteen departments gets read as the whole organisation.
  "hr.leavecost.bars.more": "Top {shown} of {total} shown; the rest are not drawn.",

  // ── Block 1: liability ────────────────────────────────────────────────────
  "hr.leavecost.liability.title": "Leave liability — as at today",
  "hr.leavecost.liability.total": "Balance owed",
  "hr.leavecost.liability.totalUnit": "days",
  // The denominator, said out loud on the tile itself.
  "hr.leavecost.liability.totalHint":
    "Sum of available_days across {employees} employees and {types} leave types, from the balance view's generated column. In DAYS — see the note below.",
  "hr.leavecost.liability.paid": "Paid types",
  "hr.leavecost.liability.paidHint":
    "The part that costs money to honour: leave types flagged is_paid. An unpaid type's balance carries no cost.",
  "hr.leavecost.liability.unpaid": "Unpaid types",
  "hr.leavecost.liability.unpaidHint":
    "Balances on types NOT flagged is_paid. Kept apart from the figure on its left because honouring one of these days costs the company nothing, and folding the two together would overstate the obligation.",
  "hr.leavecost.liability.compOff": "Comp-off in balances",
  "hr.leavecost.liability.compOffHint":
    "Comp-off types inside the balance view. Expiring credits are tracked separately below.",
  "hr.leavecost.liability.spendable": "Spendable now",
  "hr.leavecost.liability.spendableHint":
    "available_after_pending — the balance less days already applied for and awaiting a decision.",
  "hr.leavecost.liability.col.type": "Leave type",
  "hr.leavecost.liability.col.code": "Code",
  "hr.leavecost.liability.col.employees": "People",
  "hr.leavecost.liability.col.entitlement": "Entitlement",
  "hr.leavecost.liability.col.availed": "Taken",
  "hr.leavecost.liability.col.pending": "Applied for",
  "hr.leavecost.liability.col.lapsed": "Lapsed",
  "hr.leavecost.liability.col.available": "Balance",
  "hr.leavecost.liability.col.avgPerEmployee": "Avg per person",
  "hr.leavecost.liability.paidChip": "Paid",
  "hr.leavecost.liability.unpaidChip": "Unpaid",
  // DENOMINATOR FOR THE ONLY AVERAGE IN THIS BLOCK, printed under the grid that
  // carries it. Per-type, not per-headcount: a type only three people hold has three
  // in its denominator, and dividing by the whole venue would flatten it to nothing.
  "hr.leavecost.liability.avgDenominator":
    "Avg per person divides that type's available_days by the people holding a balance row OF THAT TYPE (the People column) — never by total headcount. A type nobody holds shows — rather than 0.",
  "hr.leavecost.liability.drill": "Open leave balances for {name}",
  "hr.leavecost.liability.emptyTitle": "No leave balances",
  "hr.leavecost.liability.empty":
    "No leave balances for this scope. Balances appear once the year's accruals have run.",

  // ── Block 2: leave taken ──────────────────────────────────────────────────
  "hr.leavecost.taken.title": "Leave taken in the period",
  "hr.leavecost.taken.days": "Days booked",
  "hr.leavecost.taken.daysHint":
    "Sum of day_value over {rows} leave days for {employees} people. A half day counts 0.5.",
  "hr.leavecost.taken.confirmed": "Approved",
  "hr.leavecost.taken.pending": "Awaiting approval",
  "hr.leavecost.taken.cancelling": "Cancellation asked",
  "hr.leavecost.taken.cancellingHint":
    "Approved days somebody has since asked to cancel. Still booked off, not yet given back.",
  "hr.leavecost.taken.byTypeTitle": "By leave type",
  "hr.leavecost.taken.byTypeCaption":
    "Sum of day_value per leave type, over the {rows} calendar rows read. Every status the view carries is included — the People column is distinct employees, so it does not add up across types.",
  "hr.leavecost.taken.byDeptTitle": "By department",
  "hr.leavecost.taken.byDeptCaption":
    "Sum of day_value per department, as recorded on each leave day. Click a bar to narrow the whole panel to that department.",
  "hr.leavecost.taken.deptDrill": "Narrow this panel to {name}",
  "hr.leavecost.taken.col.type": "Leave type",
  "hr.leavecost.taken.col.department": "Department",
  "hr.leavecost.taken.col.days": "Days",
  "hr.leavecost.taken.col.confirmed": "Approved",
  "hr.leavecost.taken.col.pending": "Pending",
  "hr.leavecost.taken.col.cancelling": "Cancelling",
  "hr.leavecost.taken.col.people": "People",
  "hr.leavecost.taken.emptyTitle": "No leave in this period",
  "hr.leavecost.taken.empty":
    "Nobody took leave in this period, for the filters selected.",

  // ── Block 3: roster density ───────────────────────────────────────────────
  "hr.leavecost.density.title": "How many are off at once",
  "hr.leavecost.density.peak": "Busiest day",
  "hr.leavecost.density.peakUnit": "people off",
  "hr.leavecost.density.peakHint":
    "Peak of {count} on {dates}. The spike is the roster risk — everything else is background.",
  "hr.leavecost.density.peakNone": "Nobody was off on any day in this period.",
  // A repeating peak is the finding, so every date that hit it is reported — but a
  // period where forty dates tie would fill the tile, so the tail is counted instead.
  "hr.leavecost.density.peakMoreDates": "…and {count} more dates at the same peak.",
  "hr.leavecost.density.mean": "Average off per day",
  // Zero-filling is correct HERE and the hint says why, because it is wrong almost
  // everywhere else in this product.
  "hr.leavecost.density.meanHint":
    "Mean over all {days} days in the period. Days with nobody away count as zero — the leave calendar has a row only when somebody is on leave, so an empty date is a real zero, not a missing measurement.",
  "hr.leavecost.density.chartTitle": "People off, day by day",
  "hr.leavecost.density.seriesHeadcount": "People off",
  "hr.leavecost.density.seriesConfirmed": "Approved",
  // GROUPED, NEVER STACKED, and the caption says why: approved people are a SUBSET of
  // the people off, so stacking the two bars would draw a total nobody counted.
  "hr.leavecost.density.chartCaption":
    "One bar pair per IST date across the period. 'People off' is distinct employees away that day; 'Approved' is the part of that already decided — a subset, drawn beside it rather than stacked on it, because the two do not add up to anything.",
  // The one place the panel REFUSES to draw. A capped calendar read makes the zeroes
  // unsafe: an empty date could be a day nobody was away, or a day whose rows the cap
  // cut off, and a bar chart cannot tell the reader which.
  "hr.leavecost.density.truncated":
    "Not drawn: the calendar read hit its row cap, so a date with no bar could mean nobody was away OR that its rows were cut off. Narrow the period or the department and the chart returns.",
  "hr.leavecost.density.riskTitle": "Days to look at",
  "hr.leavecost.density.riskHint":
    "The {shown} dates with the most people away, worst first, out of {total} dates that had anybody off. Click a date to narrow the whole panel to that one day.",
  "hr.leavecost.density.drill": "Narrow this panel to {date}",
  "hr.leavecost.density.col.date": "Date",
  "hr.leavecost.density.col.headcount": "People off",
  "hr.leavecost.density.col.confirmed": "Approved",
  "hr.leavecost.density.col.pending": "Pending",
  "hr.leavecost.density.col.days": "Day value",

  // ── Block 4: comp-off ─────────────────────────────────────────────────────
  "hr.leavecost.compoff.title": "Comp-off — banked and expiring",
  "hr.leavecost.compoff.available": "Banked",
  "hr.leavecost.compoff.availableHint":
    "Open earned credits across {employees} people, from the comp-off balance view.",
  "hr.leavecost.compoff.expiring": "Expiring",
  "hr.leavecost.compoff.expiringHint":
    "Days lapsing inside the view's own 30-day window, across {employees} people. This is an action list, not a statistic.",
  "hr.leavecost.compoff.expiringNone": "Nothing lapses in the next 30 days.",
  "hr.leavecost.compoff.expiringPeople": "People losing days",
  "hr.leavecost.compoff.expiringPeopleHint":
    "Employees with at least one credit inside the view's window. Each is a conversation somebody owes this week — the list below is the work.",
  "hr.leavecost.compoff.nearest": "Soonest expiry",
  "hr.leavecost.compoff.nearestHint":
    "The earliest nearest_expiry anywhere in scope. After this date those days are gone, not carried.",
  "hr.leavecost.compoff.credits": "Open credits",
  "hr.leavecost.compoff.creditsHint":
    "{credits} individual comp-off credits, still available or partially used, across {employees} people. One person can hold several, which is why this is larger than the headcount.",
  "hr.leavecost.compoff.col.employee": "Employee",
  "hr.leavecost.compoff.col.expiring": "Expiring",
  "hr.leavecost.compoff.col.available": "Banked",
  "hr.leavecost.compoff.col.nearest": "Expires",
  "hr.leavecost.compoff.col.credits": "Credits",
  "hr.leavecost.compoff.unknownEmployee": "Employee not in scope",
  "hr.leavecost.compoff.drill": "Open the comp-off ledger for {name}",
  // The action list is capped at the SERVER, ordered soonest-expiry-first, so a capped
  // read keeps the rows that matter — but the count above it then describes the rows
  // that arrived rather than everybody at risk, and that has to be said.
  "hr.leavecost.compoff.listCapped":
    "This list hit its row cap, so the counts above describe the {shown} soonest-expiring people it could read, not everybody at risk. Filter to a department to see the rest.",
  "hr.leavecost.compoff.namesUnavailable":
    "Names could not be loaded, so rows show what the balance view carries. The expiry dates and day counts are unaffected.",
  "hr.leavecost.compoff.emptyTitle": "No open comp-off",
  "hr.leavecost.compoff.empty": "Nobody is holding an open comp-off credit.",

  // ── Block 5: ledger movement ──────────────────────────────────────────────
  "hr.leavecost.movement.title": "How balances moved in the period",
  "hr.leavecost.movement.credited": "Credited",
  "hr.leavecost.movement.creditedHint":
    "Sum of the POSITIVE ledger entries in the period — accruals, carry-forward in, comp-off credits, credit adjustments and availed reversals.",
  "hr.leavecost.movement.debited": "Debited",
  "hr.leavecost.movement.debitedHint":
    "Magnitude of the NEGATIVE entries — leave availed, lapses, encashments, late deductions and debit adjustments. Shown as a positive count of days that left the balance.",
  "hr.leavecost.movement.net": "Net change",
  "hr.leavecost.movement.netHint":
    "Credits less debits over {entries} ledger entries for {employees} people. Reversals are their own signed entries, so the net already accounts for them.",
  "hr.leavecost.movement.reversed": "{count} entries were later reversed.",
  "hr.leavecost.movement.col.entry": "Entry type",
  "hr.leavecost.movement.col.days": "Days",
  "hr.leavecost.movement.col.entries": "Entries",
  "hr.leavecost.movement.col.people": "People",
  "hr.leavecost.movement.emptyTitle": "No balance movement",
  "hr.leavecost.movement.empty": "No ledger entries in this period.",

  // ── Block 6: payroll cost ─────────────────────────────────────────────────
  "hr.leavecost.cost.title": "Payroll cost",
  "hr.leavecost.cost.total": "Payroll cost",
  "hr.leavecost.cost.totalHint":
    "Gross earnings plus employer contributions, summed from total_cost_paise over {rows} department × cost-centre cells in {months} months.",
  "hr.leavecost.cost.gross": "Gross earnings",
  "hr.leavecost.cost.grossHint":
    "Sum of gross_paise — earnings before deductions. One of the two halves of the total on its left.",
  "hr.leavecost.cost.employer": "Employer cost",
  "hr.leavecost.cost.employerHint":
    "Sum of employer_cost_paise — the contributions the company pays on top of gross. The other half of Payroll cost.",
  "hr.leavecost.cost.net": "Net paid",
  "hr.leavecost.cost.netHint":
    "Sum of net_paise — what reached employees after deductions. NOT part of the cost total: gross already contains it.",
  "hr.leavecost.cost.overtime": "Overtime cost",
  "hr.leavecost.cost.overtimeHint":
    "{share} of total cost. Recomputed from the two paise columns — never an average of the view's per-row share, which is a ratio and cannot be averaged.",
  "hr.leavecost.cost.overtimeUnavailable":
    "No overtime cost is booked in these months. The matview reads the salary component coded OT; a venue that books overtime under another code will read zero here.",
  "hr.leavecost.cost.perEmployeeUnavailable":
    "Cost per employee is not shown at this grain: employee_count is a distinct count per cost centre, so somebody split across two centres is counted twice and a summed denominator would understate it. It is exact on the rows below.",
  "hr.leavecost.cost.monthTitle": "Cost by month",
  /**
   * WHY THE SEGMENTS ARE NOT DEPARTMENTS, though an earlier draft of this caption said
   * they were: the validated palette carries FOUR honestly separable series
   * (`MAX_SERIES`), and a venue with nine departments would have five of them silently
   * dropped — a bar shorter than the month actually cost, which is precisely the
   * invented number this panel exists to avoid. The two segments are instead the two
   * halves of the §9.2 definition, both server columns, so the bar's height IS the
   * total drawn. Departments get their own ranked chart, where every one of them fits.
   */
  "hr.leavecost.cost.monthChartCaption":
    "Each bar is one month. The two segments are gross_paise and employer_cost_paise, and their sum is the §9.2 payroll cost — so the bar's height is that sum DRAWN, not a second total computed somewhere else. Departments are ranked separately below, where none of them has to be dropped to fit a palette.",
  "hr.leavecost.cost.deptTitle": "Cost by department",
  "hr.leavecost.cost.deptChartCaption":
    "Sum of total_cost_paise per department across every month in the window, cost-centre rows added together. Click a bar to narrow the whole panel to that department.",
  "hr.leavecost.cost.deptDrill": "Narrow this panel to {name}",
  "hr.leavecost.cost.cellsTitle": "Month × department",
  "hr.leavecost.cost.cellsHint":
    "One row per (month × department), the matview's cost-centre level collapsed by integer addition of named paise columns. Cost centres tells you how many rows were added.",
  "hr.leavecost.cost.window": "{months} of {total} months in the period are covered.",
  "hr.leavecost.cost.col.month": "Month",
  "hr.leavecost.cost.col.department": "Department",
  "hr.leavecost.cost.col.cells": "Cost centres",
  "hr.leavecost.cost.col.gross": "Gross",
  "hr.leavecost.cost.col.employer": "Employer",
  "hr.leavecost.cost.col.overtime": "Overtime",
  "hr.leavecost.cost.col.total": "Total cost",
  "hr.leavecost.cost.asOf": "Matview refreshed {when}.",
  "hr.leavecost.cost.asOfUnknown":
    "The matview carries no refresh stamp for these months, so how current these figures are cannot be stated.",
  "hr.leavecost.cost.emptyTitle": "No payroll cost",
  "hr.leavecost.cost.empty":
    "No released payroll covers these months. Cost appears once a run reaches approved.",
  "hr.leavecost.cost.locked": "Payroll figures are not part of your access.",
  "hr.leavecost.cost.lockedHint":
    "Cost and variance need the payroll console capability. The database enforces the same rule — these views are gated on app.is_admin().",

  // ── Block 7: variance ─────────────────────────────────────────────────────
  "hr.leavecost.variance.title": "Variance vs the previous run",
  "hr.leavecost.variance.run": "Run {run}",
  "hr.leavecost.variance.runUnknown": "No released run",
  "hr.leavecost.variance.employees": "On this run",
  "hr.leavecost.variance.employeesHint":
    "Every net_pay row on the run: {comparable} with a previous payslip to compare against, {firstPayslip} being paid for the first time.",
  "hr.leavecost.variance.currentTotal": "Net pay this run",
  "hr.leavecost.variance.currentTotalHint":
    "Sum of current_amount_paise over ALL {employees} employees on the run — including first payslips, which the change figures exclude.",
  "hr.leavecost.variance.netChange": "Net change",
  // The denominator that stops a variance report crying wolf over new joiners.
  "hr.leavecost.variance.netChangeHint":
    "Over the {comparable} employees who also had a previous payslip. {firstPayslip} first-time payslips are excluded — a first salary is not an increase.",
  "hr.leavecost.variance.flagged": "Past ±{pct}%",
  "hr.leavecost.variance.flaggedHint":
    "The database blocks approval of a run that moves an employee's net pay more than ±{pct}% without a written reason. These are the rows that will ask for one.",
  "hr.leavecost.variance.increased": "Went up",
  "hr.leavecost.variance.decreased": "Went down",
  "hr.leavecost.variance.movementHint":
    "{increased} up, {decreased} down, {unchanged} unchanged — of the {comparable} employees who had a previous payslip.",
  "hr.leavecost.variance.flaggedChip": "Needs a reason",
  "hr.leavecost.variance.moversTitle": "Biggest movers",
  "hr.leavecost.variance.moversHint":
    "Largest absolute change first, capped at {shown} of {total} comparable employees. First payslips never appear here — they have nothing to move from.",
  "hr.leavecost.variance.drill": "Open compensation for {name}",
  // Should always be zero: the fetch pins variance_grain = 'net_pay' server-side. A
  // non-zero value means per-component rows reached the aggregate, which would have
  // counted every employee once per payslip line.
  "hr.leavecost.variance.componentRows":
    "{count} rows arrived at the wrong grain and were ignored. The fetch asks for net-pay rows only, so this should never happen — treat these figures as suspect and report it.",
  "hr.leavecost.variance.col.employee": "Employee",
  "hr.leavecost.variance.col.previous": "Previous",
  "hr.leavecost.variance.col.current": "This run",
  "hr.leavecost.variance.col.change": "Change",
  "hr.leavecost.variance.col.changePct": "Change %",
  "hr.leavecost.variance.noPrevious": "First payslip",
  "hr.leavecost.variance.emptyTitle": "Nothing to compare",
  "hr.leavecost.variance.empty":
    "No released run covers these months, so there is nothing to compare.",

  // ── Caveats — what the data layer discovered while answering ──────────────
  "hr.leavecost.caveat.truncated":
    "This read hit its row cap, so these figures cover only part of the scope. Narrow the period, the department or the employee for a complete answer.",
  "hr.leavecost.caveat.sourceNotApplicable":
    "The punch-source filter does not apply here. It selects individual scans; none of the leave or payroll relations records one.",
  /**
   * The filter bar hides location on this panel, so this can only be reached by a
   * hand-edited URL — which is exactly when it must be said. None of the six relations
   * carries a location column and the scope resolver does not consult `loc`, so a
   * location in the address bar narrows NOTHING and every figure below is org-wide.
   */
  "hr.leavecost.caveat.locationNotApplicable":
    "A location is in the address bar but no figure here honours it: none of the six leave and payroll relations carries a location column. Everything below covers every location.",
  "hr.leavecost.caveat.liabilityInDays":
    "Liability is reported in DAYS, not rupees. Converting a day to money needs a per-employee daily rate, and no relation this panel reads carries one — inventing a basis (gross ÷ 26? ÷ period days? basic only?) would produce a figure nobody could check.",
  "hr.leavecost.caveat.balanceAsAtToday":
    "Balances are a position as at today, for the current leave year. The period filter does not narrow them — the balance view is pinned to leave_year_of(ist_today()).",
  "hr.leavecost.caveat.calendarIncludesPending":
    "The leave calendar carries requests that are pending and requests awaiting cancellation as well as approved ones, so every total here is split by status rather than merged.",
  "hr.leavecost.caveat.compOffSnapshot":
    "Comp-off is a snapshot of open credits as at today, not credits earned in the period — the view filters to credits that are still available and not yet expired.",
  "hr.leavecost.caveat.costIsMonthly":
    "Payroll cost is booked to the month each pay period ENDS in, so a period that touches a month pulls that whole month. A part-month filter does not part-count the payroll.",
  "hr.leavecost.caveat.costMonthsCapped":
    "The period covers more months than one cost read allows, so the earliest months are missing. The most recent months are kept.",
  "hr.leavecost.caveat.costEmployeeNotApplicable":
    "The employee filter does not reach payroll cost: the matview's grain is department × cost centre and holds no employee. These cost figures cover the whole selected scope.",
  "hr.leavecost.caveat.varianceOneRun":
    "Variance describes ONE run — the newest released run covering these months — and compares each employee to their own previous payslip, not to the run before it.",
  "hr.leavecost.caveat.noReleasedRun":
    "No released payroll run covers the selected months, so there is nothing to compare against.",
  "hr.leavecost.caveat.departmentEmpty":
    "That department has no employees in scope, so the balance, comp-off, ledger and variance blocks are empty rather than showing the whole organisation.",
  "hr.leavecost.caveat.departmentTooLarge":
    "That department has more people than one query can name, and the balance, comp-off, ledger and variance views carry no department column. Those blocks are empty rather than silently unfiltered — filter to an employee, or read them from the leave console.",
  "hr.leavecost.caveat.ledgerDepartmentAsAtToday":
    "The department filter matches people by the department they are in TODAY. A transfer mid-period moves that person's earlier ledger entries with them.",

  // ── Provenance line ───────────────────────────────────────────────────────
  "hr.leavecost.basis": "Totalled in this browser from {rows} rows of {relation}.",
  "hr.leavecost.basisNone": "No rows in {relation} for this scope.",
  "hr.leavecost.orgTotalPointer":
    "For the payroll engine's own org totals, see Payroll & Cost Analytics — those come from the run headers rather than from these cells.",

  // ── Export ────────────────────────────────────────────────────────────────
  // Only the report TITLES live here. The button labels belong to
  // `AnalyticsExportButtons`, which every analytics surface shares — a second "Excel"
  // string owned by this panel would let one screen's download button disagree with
  // the next one's, and the shared component already says CSV (which is what
  // `exportReport` writes) rather than promising a workbook it does not produce.
  "hr.leavecost.export.liabilityTitle": "Leave liability by type",
  "hr.leavecost.export.costTitle": "Payroll cost by month and department",
} as const;
