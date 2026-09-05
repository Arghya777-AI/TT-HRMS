/**
 * useNavBadges — the counts the rail's badges were always shaped for and never given.
 *
 * `NavItem.badge` and `NavRow`'s rendering have been in the shell since it was written, fed by
 *
 *     const counts = useMemo<BadgeCounts>(() => ({}), []);
 *
 * — an empty object, so no badge has ever appeared on any row. "Approval/workflow should have
 * a sign showing how many are pending, so they know" is that literal gap.
 *
 * ── WHY THE QUERIES ARE RE-DECLARED HERE ─────────────────────────────────────
 * They use the SAME query keys as `useCommandCentre`'s versions, so mounting both costs one
 * request, not two — react-query dedupes by key. What this file adds is `enabled`: the rail
 * renders on every page for every reader, and an employee's session must not issue admin
 * counts it would then discard. `useMyTaskCount` has no `enabled` parameter, and giving it one
 * would push a shell concern into a console hook.
 *
 * ── WHAT IS DELIBERATELY NOT COUNTED ─────────────────────────────────────────
 * The other `BadgeKey`s (`leave.pending`, `documents.unacked`, `assets.handover`,
 * `profile.incomplete`, `attendance.unresolved`, `compOff.expiring`, `salary.new`,
 * `approvals.mine`, `helpdesk.unread`) have no cheap server count behind them yet and stay
 * absent. Absent renders nothing, which is honest. A zero would claim the queue is empty when
 * in fact nobody has looked — and these badges sit on every page, so a wrong one is wrong
 * everywhere.
 *
 * A FAILED OR PENDING COUNT IS ABSENT, NOT ZERO — the same rule as the KPI tiles and the bell.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { countAlerts, countMyAdminTasks } from "@/features/admin/api/command.api";
import { REFRESH } from "@/features/admin/hooks/useCommandCentre";
import type { NavItem } from "./nav-model";

export type BadgeCounts = Partial<Record<NonNullable<NavItem["badge"]>, number>>;

interface CountLike {
  readonly data: number | undefined;
  readonly isSuccess: boolean;
}

/** Only a succeeded, non-zero count earns a badge. */
function got(q: CountLike): number | undefined {
  return q.isSuccess && q.data !== undefined && q.data > 0 ? q.data : undefined;
}

export function useNavBadges(): BadgeCounts {
  const { caps } = useAuth();
  const isAdmin = caps.has("admin.access");

  const approvals = useQuery({
    queryKey: qk.admin.approvalInboxCount(),
    queryFn: ({ signal }) => countMyAdminTasks(signal),
    enabled: isAdmin,
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.minute,
  });

  const alerts = useQuery({
    /* Must match `useAlertCount({})` EXACTLY or the Command Centre and the rail issue the
       same count twice under two keys. That hook's key is `{ ...filters, agg: "count" }`. */
    queryKey: qk.admin.exceptions({ agg: "count" }),
    queryFn: ({ signal }) => countAlerts({}, signal),
    enabled: isAdmin,
    retry: shouldRetryQuery,
    refetchInterval: REFRESH.fiveMinutes,
  });

  const out: BadgeCounts = {};
  const pendingApprovals = got(approvals);
  if (pendingApprovals !== undefined) out["admin.approvals"] = pendingApprovals;
  const openAlerts = got(alerts);
  if (openAlerts !== undefined) out["admin.alerts"] = openAlerts;
  return out;
}
