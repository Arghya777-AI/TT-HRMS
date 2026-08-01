/**
 * keys.ts — the ROOT TanStack Query key factory. Every useQuery/useMutation in
 * every feature builds its key from here; ad-hoc inline key arrays are banned
 * by the frontend contract (docs/build/frontend-contract.md §5).
 *
 * Shape convention: [domain, entity, ...params]. Params must be serialisable
 * primitives or plain objects (filters). Invalidate with the widest prefix
 * that is correct: `qk.leave.all` after a leave mutation, not the whole cache.
 */

/** Standard sub-key set every domain gets. */
function domainKeys<D extends string>(d: D) {
  return {
    /** Root — invalidation prefix for the whole domain. */
    all: [d] as const,
    lists: () => [d, "list"] as const,
    list: (filters: Record<string, unknown>) => [d, "list", filters] as const,
    details: () => [d, "detail"] as const,
    detail: (id: string) => [d, "detail", id] as const,
  };
}

export const qk = {
  auth: {
    ...domainKeys("auth"),
    profile: (userId: string) => ["auth", "profile", userId] as const,
    roles: (userId: string) => ["auth", "roles", userId] as const,
  },
  home: {
    ...domainKeys("home"),
    pendingActions: () => ["home", "pending-actions"] as const,
    announcements: () => ["home", "announcements"] as const,
    /** Urgent (high/critical) notices only — the banner slot. */
    urgentAnnouncements: () => ["home", "announcements", "urgent"] as const,
    /** The caller's own employee row, narrowed to what the greeting band needs. */
    myEmployee: () => ["home", "my-employee"] as const,
    /** The caller's own open face-enrolment ask (draft = come and enrol). */
    faceEnrolmentAsk: () => ["home", "face-enrolment-ask"] as const,
    /** Today's attendance_days row. isoDate is the IST business date. */
    today: (employeeId: string, isoDate: string) =>
      ["home", "today", employeeId, isoDate] as const,
    /** Region D month strip — reads the month-to-date summary row. */
    monthStrip: (employeeId: string) => ["home", "month-strip", employeeId] as const,
    /** Regions E + F — leave balances and comp-off together. */
    balances: (employeeId: string) => ["home", "balances", employeeId] as const,
    /** Region H — upcoming holidays on the employee's calendar. */
    upcomingHolidays: (holidayCalendarId: string) =>
      ["home", "upcoming-holidays", holidayCalendarId] as const,
  },
  attendance: {
    ...domainKeys("attendance"),
    /** THE one summary row — v_attendance_period_summary. month = 'YYYY-MM'. */
    periodSummary: (employeeId: string, month: string) =>
      ["attendance", "period-summary", employeeId, month] as const,
    /**
     * The same summary row for an arbitrary inclusive range (the RPC path).
     * Distinct from `periodSummary` so a month view and an FY export cannot
     * collide in the cache.
     */
    rangeSummary: (employeeId: string, from: string, to: string) =>
      ["attendance", "period-summary", employeeId, "range", from, to] as const,
    /** Month-to-date row read from the zero-argument view wrapper. */
    monthToDate: (employeeId: string) => ["attendance", "period-summary", employeeId, "mtd"] as const,
    month: (employeeId: string, month: string) => ["attendance", "month", employeeId, month] as const,
    /** Day rows for an arbitrary range from v_attendance_day_enriched. */
    days: (employeeId: string, from: string, to: string) =>
      ["attendance", "days", employeeId, from, to] as const,
    day: (employeeId: string, isoDate: string) => ["attendance", "day", employeeId, isoDate] as const,
    /** Per-scan drill-down, keyed by the business (effective) date. */
    punches: (employeeId: string, effectiveDate: string) =>
      ["attendance", "punches", employeeId, effectiveDate] as const,
    /**
     * Which scans of a business date the engine collapsed as duplicates.
     * Prefixed by `punches` so one invalidation refreshes the timeline whole.
     */
    punchDuplicates: (employeeId: string, effectiveDate: string) =>
      ["attendance", "punches", employeeId, effectiveDate, "duplicates"] as const,
    /** Shift master rows behind the register's shift column, by id set. */
    shiftRefs: (shiftIds: readonly string[]) => ["attendance", "shift-refs", shiftIds] as const,
    /** Own join date + shift/weekly-off ids — bounds the E-03 period selector. */
    context: () => ["attendance", "context"] as const,
    /** `weekly_off_rules` row behind the banner chip. */
    weeklyOffRule: (ruleId: string) => ["attendance", "weekly-off-rule", ruleId] as const,
    /** The `pay_periods` row for a 'YYYY-MM' month — cutoff, lock, arrears line. */
    payPeriod: (month: string) => ["attendance", "pay-period", month] as const,
    regularizations: () => ["attendance", "regularizations"] as const,
    /**
     * E-04 sub-keys. All three are PREFIXED by `regularizations()`, so one
     * `invalidateQueries({ queryKey: qk.attendance.regularizations() })` after a
     * submit or withdrawal refreshes the list, the quota and the policy together.
     */
    regularizationQuota: (month: string) =>
      ["attendance", "regularizations", "quota", month] as const,
    regularizationPolicy: (isoDate: string) =>
      ["attendance", "regularizations", "policy", isoDate] as const,
    regularizationPreview: (payloadHash: string) =>
      ["attendance", "regularizations", "preview", payloadHash] as const,
  },
  leave: {
    ...domainKeys("leave"),
    balances: (employeeId: string) => ["leave", "balances", employeeId] as const,
    /** One type's balance — the apply form's live impact panel. */
    balanceForType: (employeeId: string, leaveTypeId: string) =>
      ["leave", "balances", employeeId, leaveTypeId] as const,
    /** Keyset-paginated ledger statement; `filters` carries type/year/range. */
    ledger: (employeeId: string, filters: Record<string, unknown>) =>
      ["leave", "ledger", employeeId, filters] as const,
    /** Keyset-paginated request list. */
    requests: (employeeId: string, filters: Record<string, unknown>) =>
      ["leave", "requests", employeeId, filters] as const,
    /** Live (balance-holding) requests only. */
    openRequests: (employeeId: string) => ["leave", "requests", employeeId, "open"] as const,
    request: (requestId: string) => ["leave", "request", requestId] as const,
    calendar: (month: string) => ["leave", "calendar", month] as const,
    /** My own leave days over an explicit window. */
    myCalendar: (employeeId: string, from: string, to: string) =>
      ["leave", "calendar", employeeId, from, to] as const,
    preview: (payloadHash: string) => ["leave", "preview", payloadHash] as const,
    /** Active leave types + their rulebook — the apply form's type list. */
    types: () => ["leave", "types"] as const,
    /** My employment context (probation, calendar, department) for E-05/E-05.4. */
    context: () => ["leave", "context"] as const,
    /** Per-date allocation of one request (`leave_request_days`). */
    allocation: (requestId: string) => ["leave", "allocation", requestId] as const,
    /** Approval trail of one request (`approval_requests` + `approval_actions`). */
    trail: (requestId: string) => ["leave", "trail", requestId] as const,
    /** Holidays on my calendar over an explicit window — the calendar wash. */
    holidays: (holidayCalendarId: string, from: string, to: string) =>
      ["leave", "holidays", holidayCalendarId, from, to] as const,
    /**
     * Which dates in a from–to range would cost this employee leave (migration 039900).
     * Keyed on the employee AND both ends: a different rota or a different range is a
     * different answer, and reusing one for the other is how a preview goes stale.
     */
    countable: (employeeId: string, from: string, to: string) =>
      ["leave", "countable", employeeId, from, to] as const,
  },
  compOff: {
    ...domainKeys("comp-off"),
    balance: (employeeId: string) => ["comp-off", "balance", employeeId] as const,
    credits: (employeeId: string) => ["comp-off", "credits", employeeId] as const,
  },
  profile: {
    ...domainKeys("profile"),
    /**
     * THE one employee row behind every E-07 tab, so two tabs can never
     * disagree about the same field (the "7 vs 8" defect class).
     */
    me: () => ["profile", "me"] as const,
    /** Resolved org labels for the caller (v_team_employee_basic, self row). */
    orgLabels: (employeeId: string) => ["profile", "org-labels", employeeId] as const,
    /** Employment tab: shift + weekly-off + attendance policy + pay period. */
    employmentPolicies: (employeeId: string) => ["profile", "employment-policies", employeeId] as const,
    /** Reporting line + dotted line, resolved to names. */
    reporting: (employeeId: string) => ["profile", "reporting", employeeId] as const,
    skills: (employeeId: string) => ["profile", "skills", employeeId] as const,
    hobbies: (employeeId: string) => ["profile", "hobbies", employeeId] as const,
    swipeCards: (employeeId: string) => ["profile", "swipe-cards", employeeId] as const,
    /** Masked statutory identifiers (PAN/Aadhaar/UAN/PF/ESI). */
    statutory: (employeeId: string) => ["profile", "statutory", employeeId] as const,
    /** Masked bank accounts (last-4 only on the wire). */
    bankAccounts: (employeeId: string) => ["profile", "bank-accounts", employeeId] as const,
    addresses: (employeeId: string) => ["profile", "addresses", employeeId] as const,
    contacts: (employeeId: string) => ["profile", "contacts", employeeId] as const,
    dependents: (employeeId: string) => ["profile", "dependents", employeeId] as const,
    qualifications: (employeeId: string) => ["profile", "qualifications", employeeId] as const,
    identityDocuments: (employeeId: string) => ["profile", "identity-documents", employeeId] as const,
    /** Custom-field defs + the caller's values, read together. */
    customFields: (employeeId: string) => ["profile", "custom-fields", employeeId] as const,
    /** Documents attached to the employee record (E-07 tab 6). */
    documents: (employeeId: string) => ["profile", "documents", employeeId] as const,
    /** Maker-checker queue: employee_change_requests. */
    changeRequests: (employeeId: string) => ["profile", "change-requests", employeeId] as const,
    /** Own-record change history (audit trail). */
    recordHistory: (employeeId: string) => ["profile", "record-history", employeeId] as const,
    /** Who read the caller's sensitive fields, and why (v_my_data_access). */
    dataAccess: (employeeId: string) => ["profile", "data-access", employeeId] as const,
  },
  pay: {
    ...domainKeys("pay"),
    payslip: (period: string) => ["pay", "payslip", period] as const,
    /** Released payslip list (header grain). */
    payslips: (employeeId: string) => ["pay", "payslips", employeeId] as const,
    /** The most recent released payslip — the home tile. */
    latestPayslip: (employeeId: string) => ["pay", "payslips", employeeId, "latest"] as const,
    /** Line rows of one payslip, by id. */
    payslipLines: (payslipId: string) => ["pay", "payslip", "lines", payslipId] as const,
    /** Line rows keyed by pay-period code — the /me/payslips/:period route. */
    payslipByPeriod: (employeeId: string, period: string) =>
      ["pay", "payslip", employeeId, period] as const,
    ytd: (fy: string) => ["pay", "ytd", fy] as const,
    structure: (employeeId: string) => ["pay", "structure", employeeId] as const,
    /** Revision history for the timeline + history grid. */
    revisions: (employeeId: string) => ["pay", "revisions", employeeId] as const,
    /** The revision in force today. */
    currentRevision: (employeeId: string) => ["pay", "revisions", employeeId, "current"] as const,
  },
  docs: domainKeys("docs"),
  apply: {
    ...domainKeys("apply"),
    openRequests: () => ["apply", "open-requests"] as const,
  },
  assets: domainKeys("assets"),
  approvals: {
    ...domainKeys("approvals"),
    inbox: () => ["approvals", "inbox"] as const,
  },
  policies: domainKeys("policies"),
  helpdesk: domainKeys("helpdesk"),
  holidays: domainKeys("holidays"),
  notifications: {
    ...domainKeys("notifications"),
    unreadCount: () => ["notifications", "unread-count"] as const,
  },
  settings: domainKeys("settings"),
  ai: domainKeys("ai"),
  team: {
    ...domainKeys("team"),
    today: (scope: Record<string, unknown>) => ["team", "today", scope] as const,
    approvals: (scope: Record<string, unknown>) => ["team", "approvals", scope] as const,
  },
  /**
   * Admin console. Every key starts with `["admin", <area>, …]`, so:
   *   - `qk.admin.all` invalidates the whole console (rarely what you want),
   *   - `qk.admin.employeesAll()` invalidates every employee list AND detail,
   *   - a single row's key invalidates just that drawer.
   * After an audited write, invalidate the widest AREA prefix that is correct —
   * a grid that disagrees with the drawer above it is the `7 vs 8` defect.
   */
  admin: {
    ...domainKeys("admin"),

    // People (§2) ------------------------------------------------------------
    employeesAll: () => ["admin", "employees"] as const,
    employees: (filters: Record<string, unknown>) => ["admin", "employees", "list", filters] as const,
    /** Keyed by employee_code — that is what the route carries. */
    employee: (code: string) => ["admin", "employees", "detail", code] as const,
    employeeById: (employeeId: string) => ["admin", "employees", "by-id", employeeId] as const,
    employeeStatutory: (employeeId: string) => ["admin", "employees", "statutory", employeeId] as const,
    employeeBank: (employeeId: string) => ["admin", "employees", "bank", employeeId] as const,
    employeeSalary: (employeeId: string) => ["admin", "employees", "salary", employeeId] as const,
    employeeRevisions: (employeeId: string) => ["admin", "employees", "revisions", employeeId] as const,
    employeeDocuments: (employeeId: string) => ["admin", "employees", "documents", employeeId] as const,
    /**
     * One employee's field-level history (360 tab 13 / /admin/people/:code/audit).
     * Under the `employees` prefix on purpose: saving an edit invalidates
     * `employeesAll()` and the history refreshes with the change that was just
     * made, which is the whole point of showing it next to the form.
     */
    employeeAudit: (employeeId: string, filters: Record<string, unknown>) =>
      ["admin", "employees", "audit", employeeId, filters] as const,
    lifecycleBoard: () => ["admin", "employees", "lifecycle"] as const,
    /** Command Centre headcount tile — a server COUNT over the directory view. */
    headcount: () => ["admin", "employees", "headcount"] as const,
    archive: (filters: Record<string, unknown>) => ["admin", "employees", "archive", filters] as const,

    // Attendance (§4) --------------------------------------------------------
    attendanceAll: () => ["admin", "attendance"] as const,
    /**
     * The admin correction queue (/admin/attendance/regularisations). Under the
     * attendance prefix on purpose: deciding a request creates punches and
     * recomputes the day, so one attendanceAll() invalidation refreshes the
     * queue, the punch log and the day records together.
     */
    regularizations: (filters: Record<string, unknown>) =>
      ["admin", "attendance", "regularizations", filters] as const,
    attendanceDays: (filters: Record<string, unknown>) =>
      ["admin", "attendance", "days", filters] as const,
    /** The ONE summary row behind both the 14-KPI strip and the Command Centre. */
    attendanceSummary: (from: string, to: string, employeeId: string | null) =>
      ["admin", "attendance", "summary", from, to, employeeId] as const,
    attendanceDay: (employeeId: string, isoDate: string) =>
      ["admin", "attendance", "day", employeeId, isoDate] as const,
    punches: (filters: Record<string, unknown>) => ["admin", "attendance", "punches", filters] as const,
    exceptions: (filters: Record<string, unknown>) =>
      ["admin", "attendance", "exceptions", filters] as const,
    todayBoard: (filters: Record<string, unknown>) => ["admin", "attendance", "today", filters] as const,
    locks: () => ["admin", "attendance", "locks"] as const,
    regularisations: (filters: Record<string, unknown>) =>
      ["admin", "attendance", "regularisations", filters] as const,
    /** Weekly rosters + published-slot counts behind /admin/attendance/coverage. */
    rosters: (filters: Record<string, unknown>) =>
      ["admin", "attendance", "rosters", filters] as const,

    // Leave (§7) -------------------------------------------------------------
    leaveAll: () => ["admin", "leave"] as const,
    leaveTypes: () => ["admin", "leave", "types"] as const,
    leaveType: (id: string) => ["admin", "leave", "types", id] as const,
    leaveBalances: (filters: Record<string, unknown>) => ["admin", "leave", "balances", filters] as const,
    leaveLedger: (employeeId: string, filters: Record<string, unknown>) =>
      ["admin", "leave", "ledger", employeeId, filters] as const,
    leaveRequests: (filters: Record<string, unknown>) => ["admin", "leave", "requests", filters] as const,
    leaveCalendar: (from: string, to: string) => ["admin", "leave", "calendar", from, to] as const,
    compOff: (employeeId: string) => ["admin", "leave", "comp-off", employeeId] as const,
    /** Command Centre tile — how many employees hold credits lapsing in 30 days. */
    compOffExpiring: () => ["admin", "leave", "comp-off", "expiring"] as const,

    // Payroll (§8) -----------------------------------------------------------
    payrollAll: () => ["admin", "payroll"] as const,
    payrollRuns: (filters: Record<string, unknown>) => ["admin", "payroll", "runs", filters] as const,
    payrollRun: (runId: string) => ["admin", "payroll", "runs", "detail", runId] as const,
    payrollVariance: (runId: string) => ["admin", "payroll", "variance", runId] as const,
    payslips: (filters: Record<string, unknown>) => ["admin", "payroll", "payslips", filters] as const,
    salaryComponents: () => ["admin", "payroll", "components"] as const,
    salaryRevisions: (filters: Record<string, unknown>) =>
      ["admin", "payroll", "revisions", filters] as const,
    payPeriods: () => ["admin", "payroll", "pay-periods"] as const,

    // Organisation (§3) + time policies (§6) ---------------------------------
    orgAll: () => ["admin", "org"] as const,
    /** `entity` is one of the ORG_ENTITIES keys in org.api.ts. */
    orgList: (entity: string, filters: Record<string, unknown>) =>
      ["admin", "org", entity, filters] as const,
    orgRow: (entity: string, id: string) => ["admin", "org", entity, "detail", id] as const,
    shifts: () => ["admin", "org", "shifts"] as const,
    /** The employing legal entities (`companies`) — /admin/org/entities. */
    companies: () => ["admin", "org", "companies"] as const,
    holidays: (calendarId: string, year: number) =>
      ["admin", "org", "holidays", calendarId, year] as const,
    holidayCalendars: () => ["admin", "org", "holiday-calendars"] as const,

    // Audit & compliance (§13) ----------------------------------------------
    auditAll: () => ["admin", "audit"] as const,
    auditTrail: (filters: Record<string, unknown>) => ["admin", "audit", "trail", filters] as const,
    auditEmployee: (employeeId: string, filters: Record<string, unknown>) =>
      ["admin", "audit", "employee", employeeId, filters] as const,
    auditEntity: (entityTable: string, entityId: string) =>
      ["admin", "audit", "entity", entityTable, entityId] as const,
    auditEvent: (eventId: string) => ["admin", "audit", "event", eventId] as const,
    dataAccess: (filters: Record<string, unknown>) => ["admin", "audit", "data-access", filters] as const,
    documentCompliance: (filters: Record<string, unknown>) =>
      ["admin", "audit", "document-compliance", filters] as const,
    /** Sibling field-changes of one audited statement, grouped by request_id. */
    auditEventGroup: (requestId: string) => ["admin", "audit", "event-group", requestId] as const,
    /** Every event by one actor — /admin/audit/user/:userId. */
    auditUser: (actorId: string, filters: Record<string, unknown>) =>
      ["admin", "audit", "user", actorId, filters] as const,
    /** sessions_audit — sign-ins, failures, revocations. */
    auditSessions: (filters: Record<string, unknown>) => ["admin", "audit", "sessions", filters] as const,
    /** export_log — the Export Register. */
    auditExports: (filters: Record<string, unknown>) => ["admin", "audit", "exports", filters] as const,
    /** audit_seals — the daily hash-chain seals. */
    auditSeals: (from: string, to: string) => ["admin", "audit", "seals", from, to] as const,
    /** system_health rows the integrity job writes (component integrity.*). */
    auditIntegrityHealth: () => ["admin", "audit", "integrity", "health"] as const,
    /** profile id → display name, for actor labels. */
    auditActorNames: (ids: readonly string[]) => ["admin", "audit", "actors", [...ids].sort()] as const,

    // System (§15) + kiosk (§5) ---------------------------------------------
    systemAll: () => ["admin", "system"] as const,
    settings: (group: string) => ["admin", "system", "settings", group] as const,
    setting: (key: string) => ["admin", "system", "settings", "one", key] as const,
    featureFlags: () => ["admin", "system", "feature-flags"] as const,
    roleGrants: () => ["admin", "system", "role-grants"] as const,
    roleCapabilities: () => ["admin", "system", "role-capabilities"] as const,
    roleAssignments: () => ["admin", "system", "role-assignments"] as const,
    notificationTemplates: () => ["admin", "system", "notification-templates"] as const,
    kioskDevices: () => ["admin", "system", "kiosk-devices"] as const,
    kioskHealth: (from: string, to: string) => ["admin", "system", "kiosk-health", from, to] as const,
    enrolmentGaps: () => ["admin", "system", "enrolment-gaps"] as const,
    /** kiosk_operators — the guards (§17). */
    kioskOperators: () => ["admin", "system", "kiosk-operators"] as const,
    /**
     * Face template METADATA from the `face-template-admin` edge function.
     * Prefixed under `kiosk-templates` so approving one set refreshes every
     * state tab (pending → active must not leave a stale "pending" grid).
     */
    faceTemplates: (state: string, offset: number) =>
      ["admin", "system", "kiosk-templates", state, offset] as const,
    /**
     * The same function scoped to ONE employee — the per-employee enrolment
     * console. Under the `kiosk-templates` prefix so `faceTemplatesAll()` after an
     * approve/retire refreshes this entry too. It is a separate entry on purpose:
     * `face-enrol` writes one row per accepted SAMPLE, so an org-wide page of 50
     * rows silently drops employees once ten sets exist.
     */
    employeeFaceTemplates: (employeeId: string) =>
      ["admin", "system", "kiosk-templates", "employee", employeeId] as const,
    faceTemplatesAll: () => ["admin", "system", "kiosk-templates"] as const,
    /** public.face_enrolment_requests — the self-enrolment review queue. */
    enrolmentRequests: (onlyPending: boolean) =>
      ["admin", "system", "enrolment-requests", onlyPending] as const,
    /** v_face_match_audit — one row per 1:N identification attempt. */
    faceMatchAudit: (filters: Record<string, unknown>) =>
      ["admin", "system", "face-match-audit", filters] as const,
    /** system_health rows behind /admin/settings/health. */
    systemHealth: (filters: Record<string, unknown>) =>
      ["admin", "system", "health", filters] as const,
    /** job_runs history + the cron_jobs register beside it. */
    jobRuns: (filters: Record<string, unknown>) => ["admin", "system", "job-runs", filters] as const,
    cronJobs: () => ["admin", "system", "cron-jobs"] as const,

    // Workflow (§12) ---------------------------------------------------------
    approvalInbox: () => ["admin", "workflow", "inbox"] as const,
    /** Badge count for the inbox — prefixed by it, so one invalidation does both. */
    approvalInboxCount: () => ["admin", "workflow", "inbox", "count"] as const,
    approvalSla: () => ["admin", "workflow", "sla"] as const,
  },
  kiosk: domainKeys("kiosk"),
} as const;

export type QueryKeyFactory = typeof qk;
