/**
 * AppShell — the chrome for every authenticated surface (spec-employee §2).
 *
 * Breakpoints:
 *  - ≥1024px: left rail 264px expanded / 72px collapsed, persisted in
 *    localStorage.tt_rail.
 *  - 768–1023px: 72px icon rail, tooltips, no bottom bar.
 *  - <768px: no rail; 5-slot bottom tab bar (4 nav + More sheet).
 * Top bar is 56px everywhere. /kiosk never renders this shell.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  Bell,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  MoreHorizontal,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ModeToggle } from "@/components/theme/mode-toggle";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import { useUnreadCount } from "@/features/notifications/hooks/useNotifications";
import { useMyPhoto } from "@/features/profile/hooks/useMyPhoto";
import { BRAND } from "@/config/brand";
import { BrandLogo } from "@/shared/ui/BrandLogo";
import { useAuth } from "@/app/auth/AuthProvider";
import { useAppRealtime } from "@/shared/hooks/useAppRealtime";
import {
  AI_FAB,
  FOOTER_ITEMS,
  MOBILE_ITEMS,
  navGroupsFor,
  type NavItem,
} from "./nav-model";
import { IstClock } from "./IstClock";
import { CommandPalette } from "./CommandPalette";

const RAIL_KEY = "tt_rail";

function initials(name: string | null): string {
  if (!name) return "TT";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "TT";
}

/** Badge counts arrive from the feature layer later; nothing renders at 0. */
type BadgeCounts = Partial<Record<NonNullable<NavItem["badge"]>, number>>;

function NavRow({
  item,
  collapsed,
  counts,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  counts: BadgeCounts;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const label = t(item.labelKey);
  const count = item.badge ? counts[item.badge] : undefined;

  const row = (
    <NavLink
      to={item.to}
      end={item.to === "/me" || item.to === "/team" || item.to === "/admin"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          collapsed && "justify-center px-2",
          isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )
      }
    >
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && count !== undefined && count > 0 ? (
        <Badge variant="secondary" className="ml-auto tabular-nums">
          {count > 9 ? "9+" : count}
        </Badge>
      ) : null}
      {collapsed && count !== undefined && count > 0 ? (
        <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
      ) : null}
    </NavLink>
  );

  if (!collapsed) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative">{row}</div>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavGroups({
  collapsed,
  counts,
  onNavigate,
}: {
  collapsed: boolean;
  counts: BadgeCounts;
  onNavigate?: () => void;
}) {
  const { caps } = useAuth();
  // Entitlement-derived: an unentitled group is absent, never a disabled teaser.
  // Admin-first for an admin — see `navGroupsFor`. The `caps` filter still decides
  // which groups exist for this reader; the helper only decides their order.
  const groups = navGroupsFor((cap) => caps.has(cap)).filter((g) => caps.has(g.cap));

  return (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-3">
      {groups.map((group) => (
        <div key={group.titleKey}>
          {!collapsed && (
            <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t(group.titleKey)}
            </p>
          )}
          <div className="space-y-0.5">
            {group.items
              .filter((i) => caps.has(i.cap))
              .map((item) => (
                <NavRow
                  key={item.to}
                  item={item}
                  collapsed={collapsed}
                  counts={counts}
                  onNavigate={onNavigate}
                />
              ))}
          </div>
        </div>
      ))}

      <div className="mt-auto">
        <Separator className="mb-2" />
        <div className="space-y-0.5">
          {FOOTER_ITEMS.filter((i) => caps.has(i.cap)).map((item) => (
            <NavRow
              key={item.to}
              item={item}
              collapsed={collapsed}
              counts={counts}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

/**
 * The bell, with the count that was missing.
 *
 * `useUnreadCount` already existed; nothing called it. So notifications WERE
 * arriving and updating — 400+ rows in the table — and the only way to find out was
 * to click a static icon on the off-chance. That is the whole of "notifications are
 * not getting updated" from the reader's side.
 *
 * THE BADGE IS ALSO THE ARIA LABEL. A screen reader must hear "Notifications, 3
 * unread", not just "Notifications" — a coloured dot is not information if you cannot
 * see it.
 *
 * A FAILED COUNT SHOWS NO BADGE rather than a zero. Zero is a claim ("you are up to
 * date") and we would not know it to be true; absence claims nothing.
 */
function NotificationBell() {
  const unread = useUnreadCount();
  const n = unread.data ?? 0;
  const show = unread.isSuccess && n > 0;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={show
        ? t("shell.topbar.notificationsUnread", { n: formatNumber(n) })
        : t("shell.topbar.notifications")}
      asChild
    >
      <Link to="/me/notifications">
        <Bell className="h-[18px] w-[18px]" />
        {show ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
          >
            {/* Past 9 the exact number stops mattering and starts breaking the layout. */}
            {n > 9 ? "9+" : formatNumber(n)}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { employee, session, signOut } = useAuth();

  /*
    THE APP'S ONE LIVE CONNECTION, mounted here so every screen inherits it.

    Realtime was inert for the life of this project — a signing-key rotation to ES256
    meant `postgres_changes` declined every binding silently — so only the home Today card
    and the analytics board had ever subscribed. With it working, the answer is one channel
    for the session rather than a channel per screen: each channel is a websocket join and
    a set of server-side bindings, and twenty screens with their own would be twenty joins,
    twenty teardowns per navigation, and twenty places for a table to be forgotten.

    A screen becomes live by doing nothing: it reads its data as before, and the
    invalidation arrives from here. RLS decides what arrives, per row, per subscriber.
  */
  useAppRealtime(session?.user.id ?? null, session?.access_token ?? null);
  const photo = useMyPhoto();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(RAIL_KEY) === "collapsed";
  });
  const [moreOpen, setMoreOpen] = useState(false);

  // Counts are wired by the feature layer; empty means "render no badges".
  const counts = useMemo<BadgeCounts>(() => ({}), []);

  const toggleRail = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(RAIL_KEY, next ? "collapsed" : "expanded");
      return next;
    });
  }, []);

  // ⌘K / Ctrl-K reserved for global search (spec-employee §2).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("tt:open-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const railWidth = collapsed ? "lg:w-[72px]" : "lg:w-[264px]";

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-dvh bg-background">
        {/* Desktop / tablet rail */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-card md:flex",
            "md:w-[72px]",
            railWidth,
          )}
        >
          <div className="flex h-14 items-center gap-2 border-b px-3">
            {/* The real monogram, not the "TT" square that used to stand in for it.
                `decorative` because the trading name is rendered beside it — a screen
                reader should not hear the brand twice. */}
            <Link to="/me" className="flex items-center gap-2 overflow-hidden" aria-label={t("app.name")}>
              <BrandLogo variant="mark" decorative className="h-8 w-8 shrink-0" />
              <span className={cn("truncate font-display text-sm font-semibold", collapsed && "lg:hidden", "hidden lg:inline")}>
                {BRAND.tradingName}
              </span>
            </Link>
          </div>

          <NavGroups collapsed={collapsed} counts={counts} />

          <div className="hidden border-t p-2 lg:block">
            <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={toggleRail}>
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
              {!collapsed && <span className="text-xs">{t("shell.topbar.toggleRail")}</span>}
            </Button>
          </div>
        </aside>

        {/* Main column */}
        <div className={cn("flex min-h-dvh flex-col md:pl-[72px]", collapsed ? "lg:pl-[72px]" : "lg:pl-[264px]")}>
          <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            {/* Mobile brand (rail is hidden below md) */}
            <Link to="/me" className="md:hidden" aria-label={t("app.name")}>
              <BrandLogo variant="mark" decorative className="h-8 w-8" />
            </Link>

            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("tt:open-search"))}
              className="flex h-9 flex-1 items-center gap-2 rounded-full border bg-muted/40 px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted sm:max-w-[360px]"
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{t("shell.topbar.search")}</span>
              <kbd className="ml-auto hidden rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] sm:inline">
                {t("shell.topbar.searchHint")}
              </kbd>
            </button>

            <div className="ml-auto flex items-center gap-1">
              <IstClock />
              <NotificationBell />
              <ModeToggle />
              {/*
                SIGN OUT, ALWAYS ON SCREEN. It already existed inside the avatar menu,
                which means it was two clicks away and invisible until you went looking —
                on a shared office machine or a kiosk tablet that is the difference
                between somebody signing out and somebody walking away still signed in.
                It stays in the menu too: muscle memory is worth more than tidiness.

                There is no LOGIN button here on purpose. This header only ever renders
                for somebody already signed in — `RequireAuth` sends everyone else to
                /login — so a login button in it could never be pressed by anybody who
                needed it.
              */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void signOut()}
                aria-label={t("shell.topbar.signOut")}
              >
                <LogOut className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">{t("shell.topbar.signOut")}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("shell.topbar.userMenu")}>
                    <Avatar className="h-7 w-7">
                      {/*
                        The uploaded photograph, when there is one. `AvatarImage` was
                        never rendered anywhere in this app — every avatar was initials,
                        so a person could upload their picture and never see it. The URL
                        is a short-lived signed link because the bucket is private; if it
                        fails for any reason the fallback below is what shows, which is
                        why nothing here reports an error.
                      */}
                      {photo.data?.url !== undefined ? (
                        <AvatarImage
                          src={photo.data.url}
                          alt={employee?.displayName ?? t("shell.topbar.userMenu")}
                        />
                      ) : null}
                      <AvatarFallback className="text-xs">{initials(employee?.displayName ?? null)}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="truncate">
                    {employee?.displayName ?? t("app.name")}
                    {employee?.employeeCode ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {employee.employeeCode}
                      </span>
                    ) : null}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/me/profile">{t("shell.nav.profile")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/me/settings/security">{t("shell.nav.security")}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void signOut()}>
                    <LogOut className="mr-2 h-4 w-4" />
                    {t("shell.topbar.signOut")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {/*
            THE BOTTOM PADDING CLEARS THE FLOATING BUTTON, and it is not cosmetic.

            The AI button is `fixed` at `bottom-6` with `h-14`, so it occupies the last
            ~80 px of the viewport on the right. `md:pb-0` meant a page's own content ran
            all the way to the bottom edge underneath it — and on Add Employee that put
            the SAVE BUTTON under the floating one, where it could not be clicked.

            It was always latent; renaming the button from "Ask TT" to "Regal Lab AI
            Assistant" made it about three times wider and turned a near miss into a
            direct hit.

            Sized from the button rather than guessed: 24 px offset + 56 px tall = 80 px,
            so `pb-24` (96 px) clears it with room. On small screens the button sits at
            `bottom-[88px]` to clear the mobile tab bar, so its top edge is 144 px up and
            the padding has to be larger again. Reserving the space in the SHELL fixes
            every page at once — the alternative is remembering to pad sixty pages, and
            the sixty-first would be wrong.
          */}
          <main className="flex-1 pb-40 md:pb-24">{children}</main>
        </div>

        {/* Mobile bottom bar — 4 slots + More */}
        <nav
          className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
          aria-label={t("shell.nav.group.me")}
        >
          {MOBILE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/me"}
                className={({ isActive }) =>
                  cn(
                    "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px]",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )
                }
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="truncate px-1">{t(item.labelKey)}</span>
              </NavLink>
            );
          })}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
              >
                <MoreHorizontal className="h-5 w-5" aria-hidden />
                <span>{t("shell.nav.more")}</span>
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t("shell.nav.more")}</SheetTitle>
              </SheetHeader>
              <div className="mt-2">
                <NavGroups collapsed={false} counts={counts} onNavigate={() => setMoreOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
        </nav>

        {/* AI FAB — hidden on the kiosk surface (which never renders this shell) */}
        {!location.pathname.startsWith("/me/ask") ? (
          <Button
            asChild
            size="lg"
            className="fixed bottom-[88px] right-4 z-[40] h-14 rounded-full shadow-lg md:bottom-6"
          >
            <Link to={AI_FAB.to} aria-label={t(AI_FAB.labelKey)}>
              <Sparkles className="h-5 w-5" aria-hidden />
              <span className="ml-2 hidden sm:inline">{t(AI_FAB.labelKey)}</span>
            </Link>
          </Button>
        ) : null}

        {/*
          Answers the `tt:open-search` event this file already dispatches — from the
          top-bar field and from ⌘K. Both were firing into a void: nothing in the app
          listened, so the most prominent control on every screen did nothing.

          Mounted here, inside the shell, so the palette is available on every
          signed-in screen. It is the general entrance to all 188 routes, which is
          what the rail cannot be at one entry per section.
        */}
        <CommandPalette />
      </div>
    </TooltipProvider>
  );
}
