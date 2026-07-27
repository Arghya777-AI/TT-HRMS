/**
 * AuditFilterBar — the filter chrome shared by all six list screens in the audit
 * console.
 *
 * This is what makes the console "genuinely searchable, not a raw dump":
 *  - Every control writes to the URL (see `url-state.ts`), so a filtered view is
 *    a citable link.
 *  - Every applied filter appears as a REMOVABLE CHIP (D-24), so nobody stares
 *    at three rows wondering which of nine dropdowns is hiding the rest.
 *  - The empty state can tell the difference between "no data" and "no results
 *    for these filters" because `hasActiveFilters` is derived from the URL, not
 *    guessed (DR-07).
 *  - Text filters DEBOUNCE before touching the URL: one keystroke per request
 *    against `audit_log` is how you make an append-only table feel slow.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Filter, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { RANGE_PRESETS, type DateWindow, type ParamPatch, type RangePreset } from "../url-state";

// -----------------------------------------------------------------------------
// Shell
// -----------------------------------------------------------------------------

export interface ActiveChip {
  readonly id: string;
  readonly label: string;
  readonly onRemove: () => void;
}

export function AuditFilterBar({
  children,
  chips,
  onClearAll,
  resultLabel,
}: {
  readonly children: ReactNode;
  readonly chips: readonly ActiveChip[];
  readonly onClearAll: () => void;
  /** "1–50 loaded" / "142 events" — the honest count of what is on screen. */
  readonly resultLabel?: string;
}) {
  return (
    <section
      className="mb-4 rounded-lg border bg-card p-3"
      aria-label={t("adminAudit.filters.region")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {children}
        {resultLabel !== undefined ? (
          <span className="num ml-auto text-xs text-muted-foreground">{resultLabel}</span>
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3">
          <span className="text-xs text-muted-foreground">{t("adminAudit.filters.applied")}</span>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={chip.onRemove}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {chip.label}
              <X className="h-3 w-3" aria-hidden />
              <span className="sr-only">{t("adminAudit.filters.remove")}</span>
            </button>
          ))}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClearAll}>
            {t("adminAudit.filters.clearAll")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Date window
// -----------------------------------------------------------------------------

export function RangeFilter({
  preset,
  window,
  patch,
}: {
  readonly preset: RangePreset;
  readonly window: DateWindow;
  readonly patch: (next: ParamPatch) => void;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="flex overflow-hidden rounded-md border" role="group" aria-label={t("adminAudit.range.region")}>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            onClick={() => patch({ range: p.id === "d30" ? null : p.id })}
            className={cn(
              "px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              preset === p.id
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-accent",
            )}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      {preset === "custom" ? (
        <span className="flex items-center gap-1">
          <label htmlFor={fromId} className="sr-only">
            {t("adminAudit.range.from")}
          </label>
          <Input
            id={fromId}
            type="date"
            value={window.from}
            max={window.to}
            onChange={(e) => patch({ range: "custom", from: e.target.value })}
            className="h-8 w-[9.5rem] text-xs"
          />
          <span className="text-xs text-muted-foreground">{t("adminAudit.range.to")}</span>
          <label htmlFor={toId} className="sr-only">
            {t("adminAudit.range.to")}
          </label>
          <Input
            id={toId}
            type="date"
            value={window.to}
            min={window.from}
            onChange={(e) => patch({ range: "custom", to: e.target.value })}
            className="h-8 w-[9.5rem] text-xs"
          />
        </span>
      ) : (
        <span className="num text-xs text-muted-foreground">
          {t("adminAudit.range.window", {
            from: fmtCivilDate(window.from),
            to: fmtCivilDate(window.to),
          })}
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Multi-select
// -----------------------------------------------------------------------------

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** Secondary line (an email, a code) — searched as well as the label. */
  readonly hint?: string;
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  searchable = false,
  loading = false,
  emptyHint,
}: {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly searchable?: boolean;
  readonly loading?: boolean;
  readonly emptyHint?: string;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? options
      : options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            (o.hint ?? "").toLowerCase().includes(needle),
        );

  function toggle(value: string) {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs">
          {label}
          {selected.length > 0 ? (
            <Badge variant="secondary" className="num ml-1 px-1.5 py-0 text-[0.65rem]">
              {selected.length}
            </Badge>
          ) : null}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {searchable ? (
          <div className="border-b p-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("adminAudit.filters.searchOptions")}
                className="h-8 pl-7 text-xs"
                aria-label={t("adminAudit.filters.searchOptions")}
              />
            </div>
          </div>
        ) : null}
        <div className="max-h-64 overflow-auto p-1" role="group" aria-label={label}>
          {loading ? (
            <p className="p-3 text-xs text-muted-foreground">{t("app.loading")}</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {emptyHint ?? t("adminAudit.filters.noOptions")}
            </p>
          ) : (
            visible.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      "mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                    aria-hidden
                  >
                    {on ? <Check className="h-2.5 w-2.5" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate">{o.label}</span>
                    {o.hint !== undefined && o.hint !== "" ? (
                      <span className="block truncate text-[0.7rem] text-muted-foreground">
                        {o.hint}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {selected.length > 0 ? (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => onChange([])}
            >
              {t("adminAudit.filters.clearOne", { label })}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// -----------------------------------------------------------------------------
// Debounced text
// -----------------------------------------------------------------------------

export function TextFilter({
  label,
  value,
  onChange,
  placeholder,
  widthClass = "w-44",
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder?: string;
  readonly widthClass?: string;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // An external change (chip removed, Clear all, back button) must win over the
  // local draft — otherwise the input keeps showing a filter that is no longer
  // applied, which is the worst kind of lie a filter bar can tell.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function push(next: string) {
    setDraft(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), 350);
  }

  return (
    <span className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        value={draft}
        onChange={(e) => push(e.target.value)}
        placeholder={placeholder ?? label}
        className={cn("h-8 pl-7 text-xs", widthClass)}
      />
    </span>
  );
}

// -----------------------------------------------------------------------------
// Boolean toggle
// -----------------------------------------------------------------------------

export function ToggleFilter({
  label,
  on,
  onChange,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <Button
      variant={on ? "default" : "outline"}
      size="sm"
      className="h-8 text-xs"
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {label}
    </Button>
  );
}
