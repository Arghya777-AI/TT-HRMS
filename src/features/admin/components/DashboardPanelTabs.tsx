/**
 * DashboardPanelTabs — the five sections of the admin dashboard, one at a time.
 *
 * WHY THIS EXISTS
 *
 * Everything the dashboard can show, stacked on one page, came to 19,906 px — about
 * twenty screenfuls. The client's words were that it is "very, very, very strict to
 * scroll down", which is the correct complaint: a dashboard you have to scroll for
 * half a minute is not a dashboard, it is a report.
 *
 * ONLY THE SELECTED SECTION IS MOUNTED, and that is the substantive half of the fix.
 * React Query fires a panel's reads when the panel renders, so five panels on one page
 * meant several dozen aggregate queries for figures nobody had scrolled to yet. One at
 * a time makes the page shorter AND cheaper, and the sections nobody opens cost nothing.
 *
 * THE SELECTION LIVES IN THE URL, in its own parameter.
 *
 * `?panel=leavecost` sits beside `?g/from/to/dept/loc/emp/src` rather than inside them,
 * for two reasons that both bite otherwise: switching section must not disturb the
 * filters, and "clear filters" must not bounce the reader back to Overview. Being a url
 * parameter also makes a section of a period a link somebody can send to a colleague,
 * which is the whole point of keeping the filter model in the url in the first place.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";

/** The five sections. `overview` is the default and must stay first. */
export const DASHBOARD_PANELS = [
  "overview",
  "workforce",
  "movement",
  "leavecost",
  "compliance",
] as const;

export type DashboardPanel = (typeof DASHBOARD_PANELS)[number];

/** The url parameter. Deliberately NOT one of `FILTER_PARAM_KEYS`. */
export const PANEL_PARAM = "panel";

const LABEL: Readonly<Record<DashboardPanel, MessageKey>> = {
  overview: "admin.dashboard.tab.overview",
  workforce: "admin.dashboard.tab.workforce",
  movement: "admin.dashboard.tab.movement",
  leavecost: "admin.dashboard.tab.leavecost",
  compliance: "admin.dashboard.tab.compliance",
};

function isPanel(value: string | null): value is DashboardPanel {
  return value !== null && (DASHBOARD_PANELS as readonly string[]).includes(value);
}

/**
 * Read and write the selected section.
 *
 * TOTAL, like `periodFromParams`: an unknown or hand-edited value yields `overview`
 * rather than an empty screen. A dashboard that renders nothing because somebody
 * trimmed the address bar is worse than one that shows the default.
 *
 * `replace: true` — nudging between five sections must not bury the previous page
 * under five history entries when the reader presses Back.
 */
export function useDashboardPanel(): [DashboardPanel, (next: DashboardPanel) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(PANEL_PARAM);
  const active = useMemo<DashboardPanel>(() => (isPanel(raw) ? raw : "overview"), [raw]);

  const select = useCallback(
    (next: DashboardPanel) => {
      const nextParams = new URLSearchParams(params);
      // The default is the ABSENCE of the parameter, so a link to the dashboard is
      // the bare path rather than one carrying a redundant `?panel=overview`.
      if (next === "overview") nextParams.delete(PANEL_PARAM);
      else nextParams.set(PANEL_PARAM, next);
      setParams(nextParams, { replace: true });
    },
    [params, setParams],
  );

  return [active, select];
}

export interface DashboardPanelTabsProps {
  readonly active: DashboardPanel;
  readonly onSelect: (next: DashboardPanel) => void;
}

export function DashboardPanelTabs({ active, onSelect }: DashboardPanelTabsProps) {
  return (
    /*
      A real tablist, not a row of links: the sections are one control's states, so a
      screen reader should hear "tab 2 of 5" rather than five unrelated buttons. Arrow
      keys are left to the browser's default focus order — a roving tabindex would be
      the correct next step, and claiming it here without implementing it would be
      worse than the honest simpler thing.
    */
    <div role="tablist" aria-label={t("admin.dashboard.tabs.label")} className="mt-4 border-b">
      <div className="-mb-px flex gap-1 overflow-x-auto text-sm">
        {DASHBOARD_PANELS.map((panel) => {
          const selected = panel === active;
          return (
            <button
              key={panel}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(panel)}
              className={cn(
                "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 transition-colors",
                selected
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {t(LABEL[panel])}
            </button>
          );
        })}
      </div>
    </div>
  );
}
