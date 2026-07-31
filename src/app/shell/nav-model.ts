/**
 * nav-model.ts — the navigation model, derived from the spec route tables.
 * Single source for the desktop rail, the tablet icon rail, the mobile bottom
 * bar and the "More" sheet, so those four surfaces can never disagree.
 *
 * `cap` is a UX visibility gate only (RLS is the real boundary). Items with a
 * `badge` key get a count slot the feature layer fills in later; the shell
 * renders nothing until a count exists (never a "0" dot).
 */
import type { ComponentType } from "react";
import {
  Banknote,
  BadgeCheck,
  BarChart3,
  CalendarDays,
  ClipboardList,
  Clock,
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
  Settings,
  ShieldCheck,
  Sparkles,
  UserCog,
  UserRound,
  Users,
} from "lucide-react";
import type { Capability } from "@/shared/auth/capabilities";
import type { MessageKey } from "@/shared/i18n/en";

export type BadgeKey =
  | "attendance.unresolved"
  | "leave.pending"
  | "compOff.expiring"
  | "salary.new"
  | "profile.incomplete"
  | "approvals.mine"
  | "documents.unacked"
  | "assets.handover"
  | "helpdesk.unread"
  | "team.approvals"
  | "admin.alerts";

export interface NavItem {
  /** i18n key — never a literal label. */
  labelKey: MessageKey;
  to: string;
  icon: ComponentType<{ className?: string }>;
  cap: Capability;
  badge?: BadgeKey;
  /** Mobile bottom-bar slot (1–4); everything else lives in "More". */
  mobileSlot?: 1 | 2 | 3 | 4;
}

export interface NavGroup {
  titleKey: MessageKey;
  cap: Capability;
  items: readonly NavItem[];
}

/** ME group — order is spec-employee §2, verbatim. */
const ME_ITEMS: readonly NavItem[] = [
  { labelKey: "shell.nav.home", to: "/me", icon: Home, cap: "me.view", mobileSlot: 1 },
  {
    labelKey: "shell.nav.attendance",
    to: "/me/attendance",
    icon: Clock,
    cap: "me.view",
    badge: "attendance.unresolved",
    mobileSlot: 2,
  },
  {
    labelKey: "shell.nav.leave",
    to: "/me/leave",
    icon: CalendarDays,
    cap: "me.view",
    badge: "leave.pending",
    mobileSlot: 3,
  },
  { labelKey: "shell.nav.compOff", to: "/me/comp-off", icon: HeartHandshake, cap: "me.view", badge: "compOff.expiring" },
  {
    labelKey: "shell.nav.salary",
    to: "/me/payslips",
    icon: Banknote,
    cap: "me.view",
    badge: "salary.new",
    mobileSlot: 4,
  },
  { labelKey: "shell.nav.profile", to: "/me/profile", icon: UserRound, cap: "me.view", badge: "profile.incomplete" },
  { labelKey: "shell.nav.apply", to: "/me/apply", icon: ClipboardList, cap: "me.view" },
  { labelKey: "shell.nav.approvals", to: "/me/approvals", icon: Inbox, cap: "me.view", badge: "approvals.mine" },
  { labelKey: "shell.nav.documents", to: "/me/profile/documents", icon: FileText, cap: "me.view", badge: "documents.unacked" },
  { labelKey: "shell.nav.assets", to: "/me/assets", icon: Package, cap: "me.view", badge: "assets.handover" },
  { labelKey: "shell.nav.policies", to: "/me/policies", icon: ScrollText, cap: "me.view" },
  { labelKey: "shell.nav.helpdesk", to: "/me/helpdesk", icon: LifeBuoy, cap: "me.view", badge: "helpdesk.unread" },
];

/** TEAM group — spec-manager route table. */
const TEAM_ITEMS: readonly NavItem[] = [
  { labelKey: "shell.nav.team.today", to: "/team", icon: Users, cap: "team.view" },
  { labelKey: "shell.nav.team.approvals", to: "/team/approvals", icon: BadgeCheck, cap: "team.view", badge: "team.approvals" },
  { labelKey: "shell.nav.team.attendance", to: "/team/attendance", icon: Clock, cap: "team.view" },
  { labelKey: "shell.nav.team.leave", to: "/team/leave", icon: CalendarDays, cap: "team.view" },
  { labelKey: "shell.nav.team.roster", to: "/team/roster", icon: CalendarDays, cap: "team.view" },
  { labelKey: "shell.nav.team.analytics", to: "/team/analytics", icon: BarChart3, cap: "team.view" },
  { labelKey: "shell.nav.team.people", to: "/team/people", icon: UserCog, cap: "team.view" },
];

/** ADMIN group — section landings from the spec-admin route table. */
const ADMIN_ITEMS: readonly NavItem[] = [
  // DASHBOARD FIRST, ahead of the Command Centre. It is the screen an admin opens
  // to see the state of the business, and it was previously eighth of ten — below
  // the fold in a normal viewport, which is how it came to be reported missing.
  { labelKey: "shell.nav.admin.analytics", to: "/admin/analytics", icon: BarChart3, cap: "admin.access" },
  { labelKey: "shell.nav.admin.command", to: "/admin", icon: Gauge, cap: "admin.access", badge: "admin.alerts" },
  { labelKey: "shell.nav.admin.people", to: "/admin/people", icon: Users, cap: "admin.access" },
  { labelKey: "shell.nav.admin.attendance", to: "/admin/attendance/live", icon: Clock, cap: "admin.access" },
  { labelKey: "shell.nav.admin.leave", to: "/admin/leave/requests", icon: CalendarDays, cap: "admin.access" },
  { labelKey: "shell.nav.admin.payroll", to: "/admin/payroll/runs", icon: Banknote, cap: "admin.access" },
  { labelKey: "shell.nav.admin.documents", to: "/admin/documents/vault", icon: FileText, cap: "admin.access" },
  // Face & kiosk. Nine screens live under /admin/kiosk/* — enrolment, devices,
  // templates, match review, consent, operators, policy, purge, abuse — and NONE
  // of them had a nav entry, so the entire section was reachable only by typing a
  // URL. It points at `enrolment` rather than `devices` because registering an
  // employee's face is the task an admin comes here to do; the rest of the section
  // is reachable from that screen's own tabs.
  { labelKey: "shell.nav.admin.faceKiosk", to: "/admin/kiosk/enrolment", icon: ScanFace, cap: "admin.access" },
  { labelKey: "shell.nav.admin.audit", to: "/admin/audit", icon: ShieldCheck, cap: "admin.access" },
  { labelKey: "shell.nav.admin.settings", to: "/admin/settings/branding", icon: Settings, cap: "admin.access" },
];

export const NAV_GROUPS: readonly NavGroup[] = [
  { titleKey: "shell.nav.group.me", cap: "me.view", items: ME_ITEMS },
  { titleKey: "shell.nav.group.team", cap: "team.view", items: TEAM_ITEMS },
  { titleKey: "shell.nav.group.admin", cap: "admin.access", items: ADMIN_ITEMS },
];

/**
 * The groups in the order THIS reader needs them.
 *
 * WHY THIS IS NOT JUST A FIXED ARRAY ANY MORE
 *
 * MY WORK holds thirteen entries and TEAM six. In a 1000 px viewport the ADMIN group
 * begins around "People" and the remaining eight rows — including the Dashboard —
 * are below the fold, reachable only by scrolling the rail. The client asked where
 * the dashboard tab was while the answer was nineteen rows above it, off screen.
 *
 * So for somebody holding `admin.access`, ADMIN comes FIRST. It is the work they
 * opened the product to do; self-service is the thing they visit occasionally, not
 * the thing that should occupy the first screenful. Everyone else is unaffected —
 * an employee still sees MY WORK first, because for them that IS the product.
 *
 * Membership is unchanged: this reorders groups, it never adds or removes one, and
 * the `cap` filter in `AppShell` still decides which a reader sees at all.
 */
export function navGroupsFor(has: (cap: NavItem["cap"]) => boolean): readonly NavGroup[] {
  if (!has("admin.access")) return NAV_GROUPS;
  const admin = NAV_GROUPS.filter((g) => g.cap === "admin.access");
  const rest = NAV_GROUPS.filter((g) => g.cap !== "admin.access");
  return [...admin, ...rest];
}

/** Footer items (rail bottom / More sheet tail). */
export const FOOTER_ITEMS: readonly NavItem[] = [
  { labelKey: "shell.nav.holidays", to: "/me/holidays", icon: CalendarDays, cap: "me.view" },
  { labelKey: "shell.nav.notifications", to: "/me/notifications", icon: Inbox, cap: "me.view" },
  { labelKey: "shell.nav.security", to: "/me/settings/security", icon: Fingerprint, cap: "me.view" },
];

/** Mobile bottom bar: the four slotted ME items, in slot order. */
export const MOBILE_ITEMS: readonly NavItem[] = [...ME_ITEMS]
  .filter((i): i is NavItem & { mobileSlot: 1 | 2 | 3 | 4 } => i.mobileSlot !== undefined)
  .sort((a, b) => a.mobileSlot - b.mobileSlot);

export const AI_FAB = { labelKey: "shell.fab.askTT" as MessageKey, to: "/me/ask", icon: Sparkles };
