/**
 * url-state.ts — the audit console's filter state lives in the URL.
 *
 * Two reasons this is not `useState`:
 *  - D-24: "Full URL-encoded state." A filtered audit view is evidence; an
 *    auditor has to be able to paste the link into a report and have the next
 *    person see the same rows.
 *  - Every screen here has a URL (spec-screens: "no mega-tab pages"), and a
 *    filter that vanishes on back-navigation is the same defect at a smaller
 *    scale.
 *
 * The encoding is deliberately plain: `?from=2026-07-01&actor=<uuid>,<uuid>`.
 * Multi-selects are comma-joined, which is safe because every multi-select value
 * here is a uuid or a snake_case token.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { addIstDays, nowIstDate } from "@/lib/datetime";
import { t, type MessageKey } from "@/shared/i18n/en";

/** The date-window presets §13.2 asks for, all resolved in IST. */
export type RangePreset = "today" | "yesterday" | "d7" | "d30" | "d90" | "custom";

export const RANGE_PRESETS: readonly { readonly id: RangePreset; readonly labelKey: MessageKey }[] = [
  { id: "today", labelKey: "adminAudit.range.today" },
  { id: "yesterday", labelKey: "adminAudit.range.yesterday" },
  { id: "d7", labelKey: "adminAudit.range.d7" },
  { id: "d30", labelKey: "adminAudit.range.d30" },
  { id: "d90", labelKey: "adminAudit.range.d90" },
  { id: "custom", labelKey: "adminAudit.range.custom" },
];

export interface DateWindow {
  /** Inclusive IST civil date, 'YYYY-MM-DD'. */
  readonly from: string;
  readonly to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve a preset into an inclusive IST civil-date window. */
export function resolveRange(preset: RangePreset, custom: Partial<DateWindow>): DateWindow {
  const today = nowIstDate();
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addIstDays(today, -1);
      return { from: y, to: y };
    }
    case "d7":
      return { from: addIstDays(today, -6), to: today };
    case "d30":
      return { from: addIstDays(today, -29), to: today };
    case "d90":
      return { from: addIstDays(today, -89), to: today };
    case "custom": {
      const from = custom.from !== undefined && ISO_DATE.test(custom.from) ? custom.from : addIstDays(today, -29);
      const to = custom.to !== undefined && ISO_DATE.test(custom.to) ? custom.to : today;
      // A backwards window returns no rows and looks like "no data". Swap it.
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

export function rangeLabel(preset: RangePreset, window: DateWindow): string {
  const entry = RANGE_PRESETS.find((p) => p.id === preset);
  if (entry === undefined) return `${window.from} – ${window.to}`;
  return t(entry.labelKey);
}

/** Read a comma-joined multi-select param. Blank → empty array, never undefined. */
export function readList(params: URLSearchParams, key: string): readonly string[] {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function readText(params: URLSearchParams, key: string): string {
  return params.get(key) ?? "";
}

export function readBool(params: URLSearchParams, key: string): boolean {
  return params.get(key) === "1";
}

export function readPreset(params: URLSearchParams, fallback: RangePreset = "d30"): RangePreset {
  const raw = params.get("range");
  const known = RANGE_PRESETS.some((p) => p.id === raw);
  return known ? (raw as RangePreset) : fallback;
}

/**
 * One setter for the whole console. `null` removes a param, so an emptied filter
 * leaves a clean URL rather than `&actor=&event=`.
 */
export type ParamPatch = Readonly<Record<string, string | readonly string[] | boolean | null>>;

export interface UrlFilterState {
  readonly params: URLSearchParams;
  readonly preset: RangePreset;
  readonly window: DateWindow;
  readonly patch: (next: ParamPatch) => void;
  readonly clearAll: () => void;
  /** True when anything beyond the default date window is applied (DR-07). */
  readonly hasActiveFilters: boolean;
}

/** Params that are NOT user-facing filters, so they don't count as "filtered". */
const NON_FILTER_PARAMS: ReadonlySet<string> = new Set(["range", "from", "to"]);

export function useAuditUrlFilters(defaultPreset: RangePreset = "d30"): UrlFilterState {
  const [params, setParams] = useSearchParams();

  const preset = readPreset(params, defaultPreset);
  const window = useMemo(
    () => resolveRange(preset, { from: params.get("from") ?? undefined, to: params.get("to") ?? undefined }),
    // `params` is a new object per navigation; keying on its string form keeps
    // the window referentially stable while the user types elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, params.get("from"), params.get("to")],
  );

  const patch = useCallback(
    (next: ParamPatch) => {
      const draft = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === false || value === "") {
          draft.delete(key);
          continue;
        }
        if (value === true) {
          draft.set(key, "1");
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) draft.delete(key);
          else draft.set(key, value.join(","));
          continue;
        }
        draft.set(key, String(value));
      }
      setParams(draft, { replace: true });
    },
    [params, setParams],
  );

  const clearAll = useCallback(() => {
    setParams(new URLSearchParams(), { replace: true });
  }, [setParams]);

  const hasActiveFilters = useMemo(() => {
    for (const key of params.keys()) if (!NON_FILTER_PARAMS.has(key)) return true;
    return false;
  }, [params]);

  return { params, preset, window, patch, clearAll, hasActiveFilters };
}
