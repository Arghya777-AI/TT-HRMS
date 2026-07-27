/**
 * QuickActions — the six primary actions of spec-admin §2.4.
 *
 * Every one is a real route from the manifest, so a quick action is a link and
 * not a modal that duplicates a screen. The approvals action carries the same
 * count as its KPI tile because both read the same query key — a badge that
 * disagrees with the tile above it would be the `7 vs 8` defect in miniature.
 *
 * The list is fixed rather than entitlement-derived for now: the capability the
 * shell already checks to render `/admin` at all (`admin.access`) covers all six
 * destinations, and each destination enforces its own tier server-side.
 */
import { Link } from "react-router-dom";
import {
  BarChart3,
  Bell,
  ClipboardList,
  Inbox,
  ScanFace,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ADMIN_ROUTES } from "../command-vocab";
import { useMyTaskCount } from "../hooks/useCommandCentre";

interface Action {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly to: string;
  readonly badge?: number;
}

export function QuickActions() {
  const myTasks = useMyTaskCount();
  const badge = myTasks.error === null ? myTasks.data : undefined;

  const actions: readonly Action[] = [
    { icon: UserPlus, label: t("admin.cc.action.addEmployee"), to: ADMIN_ROUTES.addEmployee },
    { icon: ScanFace, label: t("admin.cc.action.manualPunch"), to: ADMIN_ROUTES.manualPunch },
    {
      icon: Inbox,
      label: t("admin.cc.action.approvals"),
      to: ADMIN_ROUTES.workflowInbox,
      ...(badge !== undefined ? { badge } : {}),
    },
    { icon: ClipboardList, label: t("admin.cc.action.bulkAttendance"), to: ADMIN_ROUTES.bulkAttendance },
    { icon: Bell, label: t("admin.cc.action.announcement"), to: ADMIN_ROUTES.announcements },
    { icon: BarChart3, label: t("admin.cc.action.reports"), to: ADMIN_ROUTES.analytics },
  ];

  return (
    <section aria-labelledby="quick-actions-heading" className="rounded-lg border bg-card p-4">
      <h2 id="quick-actions-heading" className="font-display text-base font-semibold">
        {t("admin.cc.action.title")}
      </h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        {actions.map((action) => (
          <li key={action.to}>
            <Link
              to={action.to}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <action.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.badge !== undefined && action.badge > 0 ? (
                <span className="num shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-semibold text-warning">
                  {formatNumber(action.badge)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
