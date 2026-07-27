/**
 * CommandPalette — the search box that did nothing.
 *
 * WHAT WAS WRONG
 * --------------
 * `AppShell` has a search field and a ⌘K/Ctrl-K handler, and both do exactly this:
 *
 *     window.dispatchEvent(new CustomEvent("tt:open-search"))
 *
 * Nothing anywhere in `src` listened for that event. So the most prominent control
 * on every screen — a search box in the top bar, with a ⌘K hint printed in it —
 * was inert. Clicking it did nothing, and the keyboard shortcut did nothing.
 *
 * WHY THAT MATTERED MORE THAN A DEAD BUTTON
 * ----------------------------------------
 * An adversarial audit of all 188 routes found 35 screens with NO way in: the rail
 * carries roughly one entry per section, and whole spec sections — every
 * `/admin/org/*` screen, every `/admin/time/*` screen, most of documents, comms,
 * payroll and settings — had no rail entry and no inbound link from anywhere
 * reachable. `/admin/org/locations` was among them, which is where the venue's
 * coordinates are entered; the instruction "go to Admin → Org → Locations" was
 * impossible to follow.
 *
 * Every one of those verifications ended at the same place: the palette would have
 * been the entrance, and the palette did not exist. Building it makes all 188
 * routes reachable from every screen in the product, which is a better answer than
 * hand-adding links to 35 pages and hoping the 36th gets one.
 *
 * WHAT IT DOES NOT DO — deliberately, because guessing here would be worse
 * -----------------------------------------------------------------------
 * It searches SCREENS, not data. It does not find an employee by name or a payslip
 * by month: that needs server queries, debouncing, and permission filtering per
 * result type, and a half-built version that silently misses records is worse than
 * one that is honestly scoped. The placeholder says "screens", so nobody is misled.
 *
 * CAPABILITY FILTERING IS UX ONLY. A screen the current user's capability does not
 * cover is not offered, because sending somebody to a route guard that will refuse
 * them is not navigation. RLS remains the actual boundary — as everywhere else in
 * this app, `can()` decides what to SHOW and the server decides what is allowed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, Search } from "lucide-react";
import { type RouteMeta } from "@/app/route-manifest";
import { useAuth } from "@/app/auth/AuthProvider";
import { OPEN_SEARCH_EVENT, SEARCHABLE_ROUTES, rankRoutes } from "./commandSearch";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

export function CommandPalette() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Only what this user could actually open, computed once per capability change.
  const available = useMemo(() => SEARCHABLE_ROUTES.filter((route) => can(route.cap)), [can]);
  const results = useMemo(() => rankRoutes(available, query), [available, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (route: RouteMeta | undefined) => {
      if (route === undefined) return;
      close();
      void navigate(route.path);
    },
    [close, navigate],
  );

  // The listener that was missing. `AppShell` keeps ownership of the trigger — the
  // field and the shortcut are already there — and this only answers it.
  useEffect(() => {
    const onOpen = () => {
      setQuery("");
      setActive(0);
      setOpen(true);
    };
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, []);

  // Focus AFTER the dialog exists, or the caret lands nowhere.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Keep the highlight inside the list when the query shortens it.
  useEffect(() => {
    setActive((prev) => (prev >= results.length ? 0 : prev));
  }, [results.length]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("shell.search.label")}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        // Backdrop only: a mousedown inside the panel must not close it.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((prev) =>
                  results.length === 0 ? 0 : (prev - 1 + results.length) % results.length,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              }
            }}
            placeholder={t("shell.search.placeholder")}
            aria-label={t("shell.search.label")}
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border px-1.5 py-0.5 text-xs text-muted-foreground sm:inline">
            esc
          </kbd>
        </div>

        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t("shell.search.empty", { query: query.trim() })}
          </p>
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto py-1">
            {results.map((route, i) => {
              const Icon = route.icon;
              return (
                <li key={route.path}>
                  <button
                    type="button"
                    // `onMouseDown`, not `onClick`: the backdrop handler runs on
                    // mousedown, and a click would fire after the panel unmounted.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      go(route);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors",
                      i === active ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{route.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {route.hint}
                      </span>
                    </span>
                    {i === active ? (
                      <CornerDownLeft
                        className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t("shell.search.footer")}
        </p>
      </div>
    </div>
  );
}
