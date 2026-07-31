/**
 * route-manifest.ts — THE route table, as data.
 *
 * Source of truth: docs/build/spec-employee.md §1, spec-manager.md route
 * table, spec-admin.md §1 (complete inventory). Every entry declares its
 * required capability (`cap`) — a route without one fails the route-tree unit
 * test (spec-architecture D-06).
 *
 * How a screen gets built (docs/build/frontend-contract.md §3):
 *   1. A feature agent writes `src/features/<domain>/pages/<Name>.page.tsx`
 *      (default-exported component).
 *   2. It registers the lazy import in `src/features/registry.ts` under the
 *      exact `path` below.
 *   3. Until then the router renders <PageStub> from this metadata.
 * Feature agents therefore never edit `src/app/**`.
 */
import type { ComponentType } from "react";
import {
  MessagesSquare,
  Banknote,
  BarChart3,
  Bell,
  Building2,
  CalendarDays,
  ClipboardList,
  Clock,
  Cog,
  FileText,
  Fingerprint,
  Gauge,
  HeartHandshake,
  Home,
  Inbox,
  LifeBuoy,
  Package,
  ScanFace,
  ScrollText,
  ShieldCheck,
  Sparkles,
  UserCog,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import type { Capability } from "@/shared/auth/capabilities";

export type Phase = "P1" | "P1.5" | "P2";

export interface RouteMeta {
  /** Router path, relative to nothing — always absolute. */
  path: string;
  /** Screen name from the spec (shown by the stub and the document title). */
  title: string;
  /** One-line purpose from the spec — the stub's hint. */
  hint: string;
  /** UX capability gate. RLS remains the security boundary. */
  cap: Capability;
  /** Feature domain — also the lazy chunk grouping. */
  domain: string;
  phase: Phase;
  icon: ComponentType<{ className?: string }>;
  /** Optional subtitle for the stub header. */
  subtitle?: string;
}

/* ── Employee self-service (spec-employee §1) ─────────────────────────────── */
const ME: readonly RouteMeta[] = [
  { path: "/me", title: "Home", hint: "Today's punches, what needs your attention, month strip, balances.", cap: "me.view", domain: "home", phase: "P1", icon: Home },
  { path: "/me/attendance", title: "My Attendance", hint: "One month at a time: donut, 14 KPIs, and a row per date.", cap: "me.view", domain: "attendance", phase: "P1", icon: Clock },
  { path: "/me/attendance/:date", title: "Day detail", hint: "Every scan for the day, and how worked hours were derived.", cap: "me.view", domain: "attendance", phase: "P1", icon: Clock },
  { path: "/me/regularizations", title: "Regularizations", hint: "Your correction requests and where each one stands.", cap: "me.view", domain: "attendance", phase: "P1", icon: ClipboardList },
  { path: "/me/regularizations/new", title: "New regularization", hint: "Ask for a punch correction with evidence and a live preview.", cap: "me.view", domain: "attendance", phase: "P1", icon: ClipboardList },
  { path: "/me/leave", title: "Leave", hint: "Balances per type, plus every request you've made.", cap: "me.view", domain: "leave", phase: "P1", icon: CalendarDays },
  { path: "/me/leave/apply", title: "Apply for leave", hint: "Server-previewed day allocation before you can submit.", cap: "me.view", domain: "leave", phase: "P1", icon: CalendarDays },
  { path: "/me/leave/calendar", title: "Leave calendar", hint: "Your leave, offs, holidays and team density counts.", cap: "me.view", domain: "leave", phase: "P1", icon: CalendarDays },
  { path: "/me/leave/:id", title: "Leave request", hint: "Allocation table and the full approval trail.", cap: "me.view", domain: "leave", phase: "P1", icon: CalendarDays },
  { path: "/me/comp-off", title: "Comp-off", hint: "Credits earned, what expires when, and how to use them.", cap: "me.view", domain: "leave", phase: "P1", icon: HeartHandshake },
  { path: "/me/profile/basic", title: "Basic info", hint: "Identity, skills and interests — some fields need HR approval.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/profile/employment", title: "Employment", hint: "Your role, dates, and the attendance policies that apply.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/profile/payment", title: "Payment", hint: "Statutory ids and bank account — masked, change via approval.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/profile/personal", title: "Personal", hint: "Contacts, addresses, emergency contacts, dependents.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/profile/custom", title: "Additional details", hint: "Venue-specific fields such as uniform and transport.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/documents", title: "My documents", hint: "Issued to you, your uploads, and things you've signed. Uploading happens in your profile.", cap: "me.view", domain: "docs", phase: "P1", icon: FileText },
  { path: "/me/profile/documents", title: "Profile documents", hint: "Documents attached to your employee record.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/profile/salary", title: "Salary structure", hint: "Your current structure and revision history, masked.", cap: "me.view", domain: "profile", phase: "P1.5", icon: UserRound },
  { path: "/me/profile/history", title: "Record history", hint: "Every change to your record, who made it, and why.", cap: "me.view", domain: "profile", phase: "P1", icon: UserRound },
  { path: "/me/payslips", title: "Salary & payslips", hint: "This financial year's totals and every published payslip.", cap: "me.view", domain: "pay", phase: "P1.5", icon: Banknote },
  { path: "/me/payslips/:period", title: "Payslip", hint: "Earnings, deductions, net pay and the attendance it used.", cap: "me.view", domain: "pay", phase: "P1.5", icon: Banknote },
  { path: "/me/apply", title: "Apply", hint: "Start a request, and track everything already in flight.", cap: "me.view", domain: "apply", phase: "P1", icon: ClipboardList },
  { path: "/me/apply/web-punch", title: "Web punch", hint: "Punch from outside the gate when you're entitled to.", cap: "me.view", domain: "apply", phase: "P1.5", icon: ScanFace },
  { path: "/me/apply/claim", title: "Local claim", hint: "Expense claim with receipts and per-grade caps.", cap: "me.view", domain: "apply", phase: "P1.5", icon: ClipboardList },
  { path: "/me/apply/travel", title: "Travel requisition", hint: "Trip request with advance and estimated cost.", cap: "me.view", domain: "apply", phase: "P2", icon: ClipboardList },
  { path: "/me/apply/asset", title: "Asset request", hint: "Ask Stores for equipment or a uniform item.", cap: "me.view", domain: "apply", phase: "P1.5", icon: Package },
  { path: "/me/apply/resignation", title: "Resignation", hint: "Notice period, last working day and clearance.", cap: "me.view", domain: "apply", phase: "P2", icon: ClipboardList },
  { path: "/me/apply/tax", title: "Income tax", hint: "Regime election; full declarations arrive in a later phase.", cap: "me.view", domain: "apply", phase: "P2", icon: ClipboardList },
  { path: "/me/apply/certification", title: "Certification reimbursement", hint: "Claim a certification from the approved catalogue.", cap: "me.view", domain: "apply", phase: "P1.5", icon: ClipboardList },
  { path: "/me/assets", title: "My assets", hint: "What you hold, what to confirm, and what to return.", cap: "me.view", domain: "assets", phase: "P1.5", icon: Package },
  { path: "/me/approvals", title: "Awaiting your action", hint: "Everything waiting on you, plus what you're waiting on.", cap: "me.view", domain: "approvals", phase: "P1", icon: Inbox },
  { path: "/me/policies", title: "Policies", hint: "Read and acknowledge company policies by category.", cap: "me.view", domain: "policies", phase: "P1", icon: ScrollText },
  { path: "/me/policies/:slug", title: "Policy", hint: "Scroll-tracked reader with acknowledgement gate.", cap: "me.view", domain: "policies", phase: "P1", icon: ScrollText },
  { path: "/me/helpdesk", title: "Help desk", hint: "Raise a ticket to HR, Payroll, Stores or IT.", cap: "me.view", domain: "helpdesk", phase: "P1.5", icon: LifeBuoy },
  { path: "/me/helpdesk/:id", title: "Ticket", hint: "The conversation and its service-level clock.", cap: "me.view", domain: "helpdesk", phase: "P1.5", icon: LifeBuoy },
  { path: "/me/holidays", title: "Holidays", hint: "The Karnataka calendar and your optional-holiday picks.", cap: "me.view", domain: "holidays", phase: "P1", icon: CalendarDays },
  { path: "/me/notifications", title: "Notifications", hint: "Everything the system has told you, newest first.", cap: "me.view", domain: "notifications", phase: "P1", icon: Bell },
  { path: "/me/settings", title: "Settings", hint: "Channels, account security, and what the system records about you.", cap: "me.view", domain: "settings", phase: "P1", icon: Cog },
  { path: "/me/settings/notifications", title: "Notification preferences", hint: "Choose channels; some notices can't be switched off.", cap: "me.view", domain: "settings", phase: "P1", icon: Cog },
  { path: "/me/settings/security", title: "Security", hint: "Password, passkeys, face-enrolment status and sessions.", cap: "me.view", domain: "settings", phase: "P1", icon: Fingerprint },
  { path: "/me/activity", title: "My activity", hint: "Every change to your record, who made it and why, and who read it.", cap: "me.view", domain: "settings", phase: "P1", icon: ShieldCheck },
  /*
    BUILT, so no longer P2. The `ai-agent` function had been deployed and keyed for days —
    scope resolved in SQL, a fixed tool set, fourteen validator checks, every displayed
    figure recomputed from the tool results the model cited, tokens billed to
    `ai_usage_ledger`. What was missing was a screen, so the whole thing was unreachable
    behind the "not switched on" stub. `Ask.page.tsx` is that screen.

    P1.5 rather than P1: it depends on an external model and a paid key, so it is a real
    feature with an operational dependency, not core attendance.
  */
  { path: "/me/ask", title: "TTHR Assistant", hint: "Ask about your own attendance, leave and pay — charts, provenance for every figure, and Excel or PDF download.", cap: "me.view", domain: "ai", phase: "P1.5", icon: Sparkles },
  { path: "/me/ask/history", title: "Assistant history", hint: "Every conversation you have had with the assistant — open one, read it back, download it as Excel or PDF.", cap: "me.view", domain: "ai", phase: "P1.5", icon: MessagesSquare },
];

/* ── Manager (spec-manager route table) ───────────────────────────────────── */
const TEAM: readonly RouteMeta[] = [
  { path: "/team", title: "Team Today", hint: "Live presence board: in, yet to reach, late, on leave.", cap: "team.view", domain: "team", phase: "P1", icon: Users },
  { path: "/team/approvals", title: "Team Approvals", hint: "Leave, regularizations, comp-off, OT and claims to decide.", cap: "team.view", domain: "team", phase: "P1", icon: Inbox },
  { path: "/team/attendance", title: "Team Attendance", hint: "Your team's days, exceptions and trends.", cap: "team.view", domain: "team", phase: "P1", icon: Clock },
  { path: "/team/leave", title: "Team Leave", hint: "Leave board with coverage against booked events.", cap: "team.view", domain: "team", phase: "P1", icon: CalendarDays },
  { path: "/team/roster", title: "Roster & Events", hint: "Plan and publish next week against event staffing needs.", cap: "team.view", domain: "team", phase: "P1", icon: CalendarDays },
  { path: "/team/analytics", title: "Team Analytics", hint: "Late arrivals, hours worked, breaks and insights.", cap: "team.view", domain: "team", phase: "P1", icon: BarChart3 },
  { path: "/team/people", title: "My Team", hint: "Direct and indirect reportees with their key facts.", cap: "team.view", domain: "team", phase: "P1", icon: UserCog },
  { path: "/team/people/:employeeCode", title: "Reportee profile", hint: "The employee record, filtered to what a manager may see.", cap: "team.view", domain: "team", phase: "P1", icon: UserCog },
  { path: "/team/performance", title: "Performance", hint: "Appraisal cycles arrive after go-live.", cap: "team.view", domain: "team", phase: "P2", icon: BarChart3 },
];

/** Admin rows: [path, title, tier] — tier S ⇒ super-admin capability. */
type AdminRow = readonly [string, string, "A" | "A/S" | "S", string, ComponentType<{ className?: string }>, string];

const ADMIN_ROWS: readonly AdminRow[] = [
  // §1 Command Centre
  ["/admin", "Command Centre", "A", "admin-home", Gauge, "Twelve KPIs, live ops, alerts and quick actions."],
  ["/admin/alerts", "Alert Feed", "A", "admin-home", Gauge, "Every open alert with severity, owner and resolution."],
  ["/admin/tasks", "My Admin Tasks", "A", "admin-home", ClipboardList, "What this administrator personally owes."],
  // §2 People
  ["/admin/people", "Employee Directory", "A", "admin-people", Users, "Every employee, filterable, with bulk actions."],
  ["/admin/people/new", "Add Employee", "A", "admin-people", Users, "Seven-step onboarding wizard, resumable."],
  ["/admin/people/import", "Bulk Import", "A", "admin-people", Users, "Spreadsheet import that rejects rather than coerces."],
  ["/admin/people/changes", "Change Requests", "A", "admin-people", Workflow, "Field changes employees proposed, with old and new value side by side."],
  ["/admin/people/lifecycle", "Lifecycle Board", "A", "admin-people", Workflow, "Joiners, probation, notice and exits by stage."],
  ["/admin/people/onboarding", "Onboarding Tasks", "A", "admin-people", ClipboardList, "Checklist progress for every new joiner."],
  ["/admin/people/transfers", "Transfers & Promotions", "A", "admin-people", Workflow, "Movements with effective dates and letters."],
  ["/admin/people/exits", "Exits & Clearance", "A/S", "admin-people", Workflow, "Resignations, clearance items and settlement."],
  ["/admin/people/archive", "Archive", "A/S", "admin-people", Users, "Soft-deleted records, restorable with a reason."],
  ["/admin/people/rehire", "Rehire", "A", "admin-people", Users, "Bring a former employee back with history intact."],
  ["/admin/people/:code", "Employee 360", "A/S", "admin-people", UserRound, "Thirteen tabs covering the entire employee record."],
  ["/admin/people/:code/attendance", "Employee attendance", "A", "admin-people", Clock, "This employee's days, punches and exceptions."],
  ["/admin/people/:code/compensation", "Employee compensation", "A/S", "admin-people", Banknote, "Structure, revisions and payslips for this employee."],
  ["/admin/people/:code/audit", "Employee history", "A", "admin-people", ShieldCheck, "Every field-level change ever made to this record."],
  // §3 Organisation
  ["/admin/org/entities", "Legal Entities", "A/S", "admin-org", Building2, "The employing entities and their statutory ids."],
  ["/admin/org/locations", "Locations", "A", "admin-org", Building2, "Sites, geofences and time zones."],
  ["/admin/org/departments", "Departments", "A", "admin-org", Building2, "Department master with heads and cost centres."],
  ["/admin/org/sections", "Sections", "A", "admin-org", Building2, "Sub-units within departments."],
  ["/admin/org/designations", "Designations", "A", "admin-org", Building2, "Job titles, OT eligibility and default shifts."],
  ["/admin/org/grades", "Grades & Bands", "A", "admin-org", Building2, "Grades with probation, notice and entitlements."],
  ["/admin/org/cost-centres", "Cost Centres", "A", "admin-org", Building2, "Where payroll cost is booked."],
  ["/admin/org/chart", "Org Chart", "A", "admin-org", Users, "Reporting lines, solid and dotted."],
  ["/admin/org/custom-fields", "Custom Field Designer", "A", "admin-org", Cog, "Define typed extra fields without a deploy."],
  ["/admin/org/events", "Event Register", "A", "admin-org", CalendarDays, "Booked events that drive staffing requirements."],
  // §4 Attendance
  ["/admin/attendance/live", "Live Board", "A", "admin-attendance", Clock, "Who is in right now, by department and gate."],
  ["/admin/attendance/days", "Day Records", "A", "admin-attendance", Clock, "The computed day per employee, with every field."],
  ["/admin/attendance/punches", "Punch Log", "A", "admin-attendance", ScanFace, "The raw append-only scan log."],
  ["/admin/attendance/punches/new", "Manual Punch", "A", "admin-attendance", ScanFace, "Record a punch by code when the camera fails."],
  ["/admin/attendance/exceptions", "Exception Dashboard", "A", "admin-attendance", Clock, "Missing punches, single scans and anomalies."],
  ["/admin/attendance/regularisations", "Regularisation Requests", "A", "admin-attendance", ClipboardList, "Correction requests awaiting a decision."],
  ["/admin/attendance/bulk", "Bulk Actions", "A", "admin-attendance", Clock, "Apply a correction across many days safely."],
  ["/admin/attendance/recompute", "Recompute Console", "A/S", "admin-attendance", Cog, "Dry-run then commit a recompute for any scope."],
  ["/admin/attendance/locks", "Period Locks", "A/S", "admin-attendance", ShieldCheck, "Lock a period so payroll figures cannot move."],
  ["/admin/attendance/roster", "Roster Planner", "A", "admin-attendance", CalendarDays, "Publish shifts against event requirements."],
  ["/admin/attendance/coverage", "Event Coverage", "A", "admin-attendance", CalendarDays, "Planned versus required staffing per event."],
  // §5 Kiosk & Biometrics
  ["/admin/kiosk/devices", "Kiosk Devices", "A/S", "admin-kiosk", ScanFace, "The gate tablets, their health and their secrets."],
  ["/admin/kiosk/operators", "Kiosk Operators", "A", "admin-kiosk", Users, "Guards permitted to run the scanner."],
  ["/admin/kiosk/enrolment", "Enrolment Queue", "A", "admin-kiosk", ScanFace, "Face enrolments awaiting review and approval."],
  ["/admin/kiosk/templates", "Face Templates", "A/S", "admin-kiosk", Fingerprint, "Template metadata — never the biometric itself."],
  ["/admin/kiosk/match-review", "Match Review", "A", "admin-kiosk", ScanFace, "Low-confidence and guard-confirmed matches."],
  ["/admin/kiosk/abuse", "Abuse Review Queue", "A", "admin-kiosk", ShieldCheck, "Patterns that suggest buddy-punching or misuse."],
  ["/admin/kiosk/consent", "Biometric Consent Register", "A", "admin-kiosk", ShieldCheck, "Who consented, when, and who withdrew."],
  ["/admin/kiosk/policy", "Matching & Liveness Policy", "A/S", "admin-kiosk", Cog, "Thresholds and margins for automatic acceptance."],
  ["/admin/kiosk/purge", "Template Purge", "S", "admin-kiosk", ShieldCheck, "Irreversible biometric deletion, fully audited."],
  // §6 Time policies
  ["/admin/time/shifts", "Shift Master", "A", "admin-time", Clock, "Shift windows, breaks, grace and night flags."],
  ["/admin/time/weekly-offs", "Weekly-Off Rules", "A", "admin-time", CalendarDays, "Fixed, alternate and rotating off patterns."],
  ["/admin/time/holidays", "Holiday Calendars", "A", "admin-time", CalendarDays, "Calendars, holidays and who actually works them."],
  ["/admin/time/attendance-policies", "Attendance Policy Sets", "A", "admin-time", Cog, "Every threshold the attendance engine reads."],
  ["/admin/time/pay-periods", "Pay Periods", "A/S", "admin-time", CalendarDays, "Period windows, cutoffs and pay dates."],
  ["/admin/time/assignments", "Policy Assignments", "A", "admin-time", Cog, "Effective-dated binding of policies to scopes."],
  ["/admin/time/resolver", "Why this policy?", "A", "admin-time", Cog, "Explain which policy applies to whom, and why."],
  // §7 Leave
  ["/admin/leave/types", "Leave Type Master", "A", "admin-leave", CalendarDays, "Entitlements, accrual, carry-forward and rules."],
  ["/admin/leave/balances", "Leave Balances", "A", "admin-leave", CalendarDays, "Current balances across the organisation."],
  ["/admin/leave/requests", "Leave Requests", "A", "admin-leave", CalendarDays, "Every request, filterable, with decisions."],
  ["/admin/leave/adjustments", "Manual Adjustments", "A", "admin-leave", CalendarDays, "Credit or debit a balance with a mandatory reason."],
  ["/admin/leave/comp-off", "Comp-Off Ledger", "A", "admin-leave", HeartHandshake, "Credits earned, used, expiring and lapsed."],
  ["/admin/leave/rollover", "Year-End Rollover", "A/S", "admin-leave", Cog, "Carry forward, lapse and encash at year end."],
  ["/admin/leave/calendar", "Org Leave Calendar", "A", "admin-leave", CalendarDays, "Who is off, org-wide, with density warnings."],
  ["/admin/leave/encashment", "Encashment", "A", "admin-leave", Banknote, "Leave encashment runs and their payouts."],
  ["/admin/leave/ledger/:code", "Balance Ledger", "A", "admin-leave", CalendarDays, "Every credit and debit behind one balance."],
  // §8 Payroll
  ["/admin/payroll/components", "Salary Components", "A/S", "admin-payroll", Banknote, "Earnings, deductions and their formulas."],
  ["/admin/payroll/structures", "Structure Templates", "A", "admin-payroll", Banknote, "Reusable salary structures by grade."],
  ["/admin/payroll/compensation", "Employee Compensation", "A/S", "admin-payroll", Banknote, "Current pay for every employee."],
  ["/admin/payroll/revisions", "Revisions", "A/S", "admin-payroll", Banknote, "Increment history, effective-dated."],
  ["/admin/payroll/runs", "Payroll Runs", "A/S", "admin-payroll", Banknote, "Lock, compute, review, approve, publish."],
  ["/admin/payroll/runs/:id", "Payroll Run", "A/S", "admin-payroll", Banknote, "One run: variance flags, approvals, outputs."],
  ["/admin/payroll/payslips", "Payslips", "A/S", "admin-payroll", FileText, "Published payslips and their delivery state."],
  ["/admin/payroll/overtime", "Overtime & Incentives", "A", "admin-payroll", Clock, "Approve OT and event premiums for payment."],
  ["/admin/payroll/reimbursements", "Reimbursements", "A", "admin-payroll", Banknote, "Claims cleared for payment with payroll."],
  ["/admin/payroll/statutory", "Statutory", "A/S", "admin-payroll", ShieldCheck, "PF, ESI, PT and TDS registers and returns."],
  ["/admin/payroll/form16", "Form 16 Distribution", "A", "admin-payroll", FileText, "Generate and issue Form 16 in bulk."],
  ["/admin/payroll/bank-advice", "Bank Advice", "A/S", "admin-payroll", Banknote, "Payment files for the bank, checksummed."],
  ["/admin/payroll/register", "Payroll Register", "A", "admin-payroll", FileText, "The full register for a period."],
  ["/admin/payroll/variance", "Variance Report", "A", "admin-payroll", BarChart3, "What changed since last month, and why."],
  ["/admin/payroll/arrears", "Arrears & Reversals", "A/S", "admin-payroll", Banknote, "Retrospective corrections, fully traced."],
  // §9 Documents
  ["/admin/documents/types", "Document Type Master", "A", "admin-documents", FileText, "Categories, expiry rules and requirements."],
  ["/admin/documents/repository", "Document Repository", "A", "admin-documents", FileText, "Every document, searchable, access-logged."],
  ["/admin/documents/pending", "Approval Queue", "A", "admin-documents", FileText, "Uploads awaiting verification."],
  ["/admin/documents/expiry", "Expiry Tracker", "A", "admin-documents", FileText, "Licences and certificates about to lapse."],
  ["/admin/documents/templates", "Letter & Contract Templates", "A", "admin-documents", FileText, "Templates with variables for bulk generation."],
  ["/admin/documents/generate", "Bulk Generation", "A", "admin-documents", FileText, "Produce letters for many employees at once."],
  ["/admin/documents/esign", "E-Sign Requests", "A", "admin-documents", FileText, "Signature chains and their audit trail."],
  ["/admin/documents/access-log", "Document Access Log", "A", "admin-documents", ShieldCheck, "Who opened which document, and when."],
  // §10 Communications
  ["/admin/comms/announcements", "Announcements", "A", "admin-comms", Bell, "Post notices to the whole venue or a department."],
  ["/admin/comms/broadcasts", "Broadcasts", "A", "admin-comms", Bell, "Targeted email and in-app campaigns."],
  ["/admin/comms/templates", "Message Templates", "A", "admin-comms", FileText, "Notification and email templates per event."],
  ["/admin/comms/policies", "Policy Publication", "A", "admin-comms", ScrollText, "Publish a policy version and require acknowledgement."],
  ["/admin/comms/acknowledgements", "Acknowledgement Compliance", "A", "admin-comms", ShieldCheck, "Who has read and signed what."],
  ["/admin/comms/delivery", "Delivery Log", "A", "admin-comms", Bell, "Sent, delivered, opened, bounced."],
  ["/admin/comms/helpdesk", "Help Desk", "A", "admin-comms", LifeBuoy, "Tickets across every queue, with service levels."],
  // §11 Assets
  ["/admin/assets/master", "Asset Master", "A", "admin-assets", Package, "Every asset, its category and its value."],
  ["/admin/assets/consumables", "Consumable Stock", "A", "admin-assets", Package, "Uniforms and consumables, with reissue rules."],
  ["/admin/assets/allocations", "Allocations", "A", "admin-assets", Package, "Who holds what, since when."],
  ["/admin/assets/returns", "Returns & Recalls", "A", "admin-assets", Package, "Pending returns and recall campaigns."],
  ["/admin/assets/history", "Asset History", "A", "admin-assets", Package, "The full custody trail for an asset."],
  ["/admin/assets/exit-liability", "Exit Liability", "A", "admin-assets", Package, "What leavers still hold, valued."],
  // §12 Approvals & workflow
  ["/admin/workflow/inbox", "Approval Inbox", "A", "admin-workflow", Inbox, "Everything awaiting an administrator's decision."],
  ["/admin/workflow/designer", "Workflow Designer", "A/S", "admin-workflow", Workflow, "Approval chains as data, not code."],
  ["/admin/workflow/delegations", "Delegations", "A", "admin-workflow", Workflow, "Temporary transfer of approval authority."],
  ["/admin/workflow/sla", "SLA & Escalations", "A", "admin-workflow", Workflow, "Breaches, reminders and escalation paths."],
  ["/admin/workflow/overrides", "Override Log", "A", "admin-workflow", ShieldCheck, "Every time a rule was deliberately overridden."],
  // §13 Audit & compliance
  ["/admin/audit", "Audit Timeline", "A", "admin-audit", ShieldCheck, "Field-level history across the whole system."],
  ["/admin/audit/sessions", "Login & Session Audit", "A", "admin-audit", ShieldCheck, "Sign-ins, failures and active sessions."],
  ["/admin/audit/data-access", "Data-Access Audit", "A/S", "admin-audit", ShieldCheck, "Who revealed or exported sensitive data."],
  ["/admin/audit/exports", "Export Register", "A/S", "admin-audit", ShieldCheck, "Every export that left the system."],
  ["/admin/audit/integrity", "Integrity & Tamper Evidence", "S", "admin-audit", ShieldCheck, "Hash-chain verification and daily seals."],
  ["/admin/audit/dpdp", "DPDP Compliance Pack", "A/S", "admin-audit", ShieldCheck, "Consent register, retention and erasure runbook."],
  ["/admin/audit/retention", "Retention Jobs", "S", "admin-audit", Cog, "What gets purged, when, and what it wrote."],
  ["/admin/audit/diff/:eventId", "Diff Viewer", "A", "admin-audit", ShieldCheck, "Before and after for a single audited change."],
  ["/admin/audit/entity/:type/:id", "Entity History", "A", "admin-audit", ShieldCheck, "Everything ever done to one record."],
  ["/admin/audit/user/:userId", "User Activity Trail", "A", "admin-audit", ShieldCheck, "Everything one actor has done."],
  // §14 Analytics
  ["/admin/analytics", "Dashboard", "A", "admin-analytics", BarChart3, "Live today, then any period: headcount, attendance, leave, cost and compliance."],
  ["/admin/analytics/attendance", "Attendance Analytics", "A", "admin-analytics", BarChart3, "Punctuality, hours, exceptions and trends."],
  ["/admin/analytics/employees", "Employee Analytics", "A", "admin-analytics", Users, "One row per employee for the period: averages, lateness, leave and overtime."],
  ["/admin/analytics/employees/:employeeCode", "Employee Analytics Detail", "A", "admin-analytics", UserRound, "One person's period: average in and out, hours, leave, exceptions and every day."],
  ["/admin/analytics/workforce", "Workforce Analytics", "A", "admin-analytics", BarChart3, "Headcount, attrition, tenure and diversity."],
  ["/admin/analytics/payroll", "Payroll & Cost Analytics", "A/S", "admin-analytics", BarChart3, "Cost per department, per event, over time."],
  ["/admin/analytics/leave", "Leave Analytics", "A", "admin-analytics", BarChart3, "Utilisation, liability and seasonality."],
  ["/admin/analytics/compliance", "Compliance Analytics", "A", "admin-analytics", BarChart3, "Statutory, document and policy compliance."],
  ["/admin/analytics/kiosk", "Kiosk Analytics", "A", "admin-analytics", BarChart3, "Match rates, latency and device health."],
  ["/admin/analytics/ai", "AI Usage Analytics", "A/S", "admin-analytics", BarChart3, "Questions, cost, latency and refusals."],
  ["/admin/analytics/metrics", "Metric Dictionary", "A", "admin-analytics", ScrollText, "Every metric's exact definition and source."],
  ["/admin/analytics/scheduled", "Scheduled Reports", "A", "admin-analytics", BarChart3, "Recurring reports and their recipients."],
  ["/admin/analytics/builder", "Report Builder", "A", "admin-analytics", BarChart3, "Ad-hoc reporting arrives in a later phase."],
  ["/admin/analytics/exports", "Data Exports", "S", "admin-analytics", BarChart3, "Bulk extracts and warehouse feeds."],
  // §15 Settings
  ["/admin/settings/branding", "Branding", "A", "admin-settings", Cog, "Logo, palette and document letterheads."],
  // A/S, not S. spec-admin §15 tiers this row S, but the deployed database
  // deliberately lets an admin READ every table this screen shows — RLS has
  // `user_roles__admin_read`, `era__admin_read`, `profiles__admin_read` and a
  // read-to-all-authenticated policy on `role_capabilities` (006b, 050) — while
  // reserving INSERT/UPDATE to `app.is_super_admin()`. Roles.page.tsx already
  // implements exactly that split (`isSuper` gates the grant form and every
  // revoke button), and gating the ROUTE at admin.super made that read-only
  // path unreachable. HR is the admin role here, so HR must be able to see who
  // holds what and read the plain-English explanation on this screen.
  ["/admin/settings/roles", "Roles & Permissions", "A/S", "admin-settings", ShieldCheck, "Who can do what, with an audit of every grant."],
  ["/admin/settings/flags", "Feature Flags", "A/S", "admin-settings", Cog, "Switch features on per environment, with expiry."],
  ["/admin/settings/integrations", "Integrations", "A/S", "admin-settings", Cog, "Email, storage and device bridges."],
  ["/admin/settings/api", "API Keys & Webhooks", "S", "admin-settings", ShieldCheck, "Machine credentials, shown once."],
  ["/admin/settings/ai", "AI Configuration", "A/S", "admin-settings", Sparkles, "Model, scope, budget and guardrails."],
  ["/admin/settings/notifications", "Notification Templates", "A", "admin-settings", Bell, "Per-event copy across every channel."],
  ["/admin/settings/localisation", "Localisation", "A", "admin-settings", Cog, "Languages, formats and the string catalogue."],
  ["/admin/settings/security", "Security Settings", "S", "admin-settings", ShieldCheck, "Session policy, MFA and password rules."],
  ["/admin/settings/backup", "Backup & Retention", "S", "admin-settings", Cog, "Backup state, restore drills and retention."],
  ["/admin/settings/health", "System Health", "A", "admin-settings", Gauge, "Jobs, queues, kiosk heartbeats and errors."],
];

const ADMIN: readonly RouteMeta[] = ADMIN_ROWS.map(([path, title, tier, domain, icon, hint]) => ({
  path,
  title,
  hint,
  // Tier S routes need the super-admin capability; A and A/S need admin access
  // (the S half of A/S is enforced server-side by step-up + RLS).
  cap: tier === "S" ? ("admin.super" as const) : ("admin.access" as const),
  domain,
  phase: path === "/admin/analytics/builder" ? ("P2" as const) : ("P1" as const),
  icon,
}));

/** Every authenticated route, in declaration order. */
export const ROUTES: readonly RouteMeta[] = [...ME, ...TEAM, ...ADMIN];

/** Redirects (legacy paths and section defaults). */
export const REDIRECTS: readonly { from: string; to: string }[] = [
  { from: "/employee/*", to: "/me" },
  { from: "/manager/*", to: "/team" },
  { from: "/me/profile", to: "/me/profile/basic" },

  { from: "/admin/documents/vault", to: "/admin/documents/repository" },
];

/** Public routes that intentionally have no capability. */
export const PUBLIC_PATHS = [
  "/",
  "/welcome",
  "/login",
  "/login/forgot",
  "/reset-password",
  "/first-run",
  "/kiosk",
  "*",
] as const;
