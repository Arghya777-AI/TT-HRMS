/**
 * §1 · /admin — Command Centre. The administrator's morning screen.
 *
 * Layout follows spec-admin §2: KPI strip (row 1), live ops band (row 2), alert
 * feed + quick actions 8/4 (row 3).
 *
 * The three rules this screen is built to keep:
 *
 *  1. EVERY NUMBER OPENS. Twelve tiles, twelve routes; the presence chips, the
 *     gate panel and every alert row link out too. A figure an admin cannot
 *     interrogate is a figure they cannot trust.
 *  2. EVERY NUMBER IS THE SERVER'S. Each tile is a `HEAD … count=exact` against a
 *     view, using the same predicate as the screen it drills into, so a tile and
 *     its detail screen cannot disagree (DR-29). There is no arithmetic on this
 *     page — no sums, no averages, no percentages of anything.
 *  3. A NUMBER THAT CANNOT BE READ IS `—`, WITH THE REASON. Offline, not-yours
 *     and this-screen-is-out-of-step each say so on the tile. A `0` here always
 *     means "the database counted zero rows".
 *
 * What §2 asks for and this screen does NOT have, honestly rather than faked:
 *   * §2.3's `alerts` table (assignee / acknowledge / snooze / resolution) is not
 *     deployed. The feed is `v_exception_queue`, which is self-clearing, and the
 *     card says so instead of offering buttons that would write nowhere.
 *   * §2.2's dept "Rostered / Present / Short" coverage strip and the events
 *     panel: `rosters`/`roster_slots` and `events` have no summary view, and
 *     "short by n heads" is exactly the kind of figure this console refuses to
 *     compute in the browser.
 *   * §2.5's period analytics (presence trend, composition, OT by department,
 *     punctuality donut) — separate work, and `/admin/analytics` already owns it.
 *
 * @route /admin
 */
import { Link } from "react-router-dom";
import { Bell, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { fmtDateWeekday, nowInstantIso } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { AlertList } from "../components/AlertList";
import { CommandKpiStrip } from "../components/CommandKpiStrip";
import { LiveOpsBand } from "../components/LiveOpsBand";
import { Notice } from "../components/Notice";
import { QuickActions } from "../components/QuickActions";
import { ADMIN_ROUTES } from "../command-vocab";
import { useAlertCount, useAlertFeed, useIstToday } from "../hooks/useCommandCentre";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";

/** How many alerts the Command Centre shows before "view all". */
const FEED_PREVIEW = 8;

export default function CommandCentrePage() {
  const istDate = useIstToday();
  const feed = useAlertFeed({}, FEED_PREVIEW);
  const openCount = useAlertCount({});
  const labels = useEmployeeLabels();

  const rows = feed.data ?? [];
  const total = openCount.error === null ? openCount.data : undefined;

  return (
    <>
      <PageHeader
        icon={Gauge}
        title={t("admin.cc.title")}
        subtitle={t("admin.cc.subtitle", { date: fmtDateWeekday(nowInstantIso()) })}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to={ADMIN_ROUTES.tasks}>{t("admin.cc.openTasks")}</Link>
          </Button>
        }
      />

      <div className="space-y-6">
        <CommandKpiStrip istDate={istDate} />

        <LiveOpsBand istDate={istDate} />

        <div className="grid gap-3 xl:grid-cols-3">
          <section aria-labelledby="alert-feed-heading" className="space-y-3 xl:col-span-2">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2
                  id="alert-feed-heading"
                  className="flex items-center gap-2 font-display text-lg font-semibold"
                >
                  <Bell className="h-4 w-4 text-primary" aria-hidden />
                  {t("admin.cc.alerts.title")}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {total === undefined
                    ? t("admin.cc.alerts.countUnknown")
                    : total > rows.length
                      ? t("admin.cc.alerts.showing", {
                          shown: formatNumber(rows.length),
                          total: formatNumber(total),
                        })
                      : t("admin.cc.alerts.count", { total: formatNumber(total) })}
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to={ADMIN_ROUTES.alerts}>{t("admin.cc.alerts.viewAll")}</Link>
              </Button>
            </div>

            <Notice tone="info">{t("admin.alert.derivedNote")}</Notice>

            <StateBoundary
              loading={feed.isPending}
              error={feed.error}
              onRetry={() => void feed.refetch()}
              isEmpty={rows.length === 0}
              empty={
                <EmptyState
                  icon={Bell}
                  title={t("admin.alert.empty.title")}
                  hint={t("admin.alert.empty.hint")}
                />
              }
              partialError={labels.error}
              partialLabel={t("admin.alert.partial.people")}
              skeletonRows={4}
            >
              <AlertList rows={rows} labels={labels.data} />
            </StateBoundary>
          </section>

          <QuickActions />
        </div>
      </div>
    </>
  );
}
