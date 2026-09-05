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
import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { useLocationTrail } from "@/features/attendance/hooks/useLocationTrail";
import { useAppRealtime } from "@/shared/hooks/useAppRealtime";
import { InstallAppCard } from "@/shared/pwa/InstallAppCard";
import { useServiceWorker } from "@/shared/pwa/registerServiceWorker";
import {
  AI_FAB,
  FOOTER_ITEMS,
  MOBILE_ITEMS,
  navGroupsFor,
  type NavItem,
} from "./nav-model";
import { IstClock } from "./IstClock";
import { useNavBadges } from "./useNavBadges";
import { AttentionPopup } from "@/features/admin/components/AttentionPopup";
import { CommandPalette } from "./CommandPalette";

const RAIL_KEY = "tt_rail";

function initials(name: string | null): string {
  if (!name) return "TT";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "TT";
}

/** Nothing renders at 0 — see `useNavBadges` for why absence beats a zero here. */
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
    ── THE LOCATION TRAIL ────────────────────────────────────────────────────
    Mounted in the shell rather than on a page, because it has to survive navigation:
    an employee moving between My Attendance and Apply should not restart the watch and
    re-record a first fix each time.

    Gated on there being an employee record — a signed-in account with no employee row
    (an admin-only login) has no attendance to trail. It samples only while the app is
    visible, which is the ceiling for a web application: `watchPosition` is suspended
    when the page is hidden and the API is not available to service workers. Continuous
    background sampling needs a native app, which this product does not have.

    The venue holds signed consent for location tracking; this is the disclosed
    mechanism that consent covers.
  */
  useLocationTrail({ enabled: employee !== null });

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
  /*
    "Later" hides the update notice for THIS session only — deliberately not persisted. The
    waiting worker does not go away, and a new bundle usually exists because something was
    fixed; a permanent dismissal would leave somebody on a known-broken version indefinitely.
  */
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const serviceWorker = useServiceWorker();
  const sw = {
    updateReady: serviceWorker.updateReady && !updateDismissed,
    applyUpdate: serviceWorker.applyUpdate,
  };

  /* Was `useMemo(() => ({}), [])` — the badge machinery existed and was fed nothing, so no
     row has ever shown a count. See `useNavBadges`. */
  const counts = useNavBadges();

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

  /*
    THE RAIL'S WIDTH IS SPENT TWICE — here, and as the main column's left offset below.
    The two must stay equal or the result is either a strip of bare background or a
    header sliding under the rail, so the four literals are written out in both places
    and must be edited together. They cannot be shared through a constant: Tailwind
    generates classes by finding them as literal text in the source, so a class name
    built from a template string produces no CSS at all.

    `env(safe-area-inset-left)` is in all of them because the rail shows from `md:` up
    and a phone in landscape is wider than that — an iPhone 14 Pro is 852px on its side.
    With the notch on the left that inset is around 59px, over a 72px rail, which covers
    the icons completely. Widening by the inset and padding by the same amount leaves a
    full 72px of usable rail beside the notch.
  */
  const railWidth = collapsed
    ? "lg:w-[calc(72px_+_env(safe-area-inset-left))]"
    : "lg:w-[calc(264px_+_env(safe-area-inset-left))]";

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-dvh bg-background">
        {/* Desktop / tablet rail */}
        {/*
          The rail appears from `md:` up, and that includes an iPad added to the home
          screen — which has a status bar and a home indicator of its own. `inset-y-0`
          pins it to the display edges, so without these the monogram sat under the clock
          and Sign out sat under the home bar. `pl` is for landscape on a notched phone
          held with the notch on the left.
        */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-card md:flex",
            "md:w-[calc(72px_+_env(safe-area-inset-left))]",
            "pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]",
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
        <div className={cn(
          "flex min-h-dvh flex-col md:pl-[calc(72px_+_env(safe-area-inset-left))]",
          collapsed
            ? "lg:pl-[calc(72px_+_env(safe-area-inset-left))]"
            : "lg:pl-[calc(264px_+_env(safe-area-inset-left))]",
        )}>
          {/*
            ── THE HEADER PAINTS UNDER THE iOS STATUS BAR, SO IT HAS TO PAD FOR IT ───────

            REPORTED from an iPhone home-screen install: the clock and the battery were
            drawn on top of the search field.

            index.html sets `apple-mobile-web-app-status-bar-style: black-translucent`
            with `viewport-fit=cover`, which is deliberate — it is what makes the app fill
            the screen instead of sitting in a letterbox — and its consequence is that the
            web view's origin is the top of the DISPLAY, not the top of the usable area.
            The status bar is then the app's problem. index.html's own comment already
            claimed "the shell pads with env(safe-area-inset-*)"; the shell did not.

            THE HEIGHT IS ADDITIVE, WHICH IS THE WHOLE TRICK. `h-14` with `pt-[env(...)]`
            would be worse than nothing: `box-sizing: border-box` subtracts the padding
            from the 56px, so the row would shrink to 9px on a notched phone instead of
            moving down. So the inset is added to the height and applied as padding —
            56px of usable header, wherever it starts.

            Left and right insets too, for landscape, where the notch takes a bite out of
            one side and the first thing in the row would sit under it. `max()` keeps the
            old 12px gutter on every device that reports no inset at all.
          */}
          <header
            className={cn(
              "sticky top-0 z-20 flex items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
              "h-[calc(3.5rem_+_env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]",
              "pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]",
            )}
          >
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
          {/*
            AND THE HOME INDICATOR IS ADDED ON TOP OF ALL OF IT. Both figures below are
            measured from the viewport's bottom edge, which on a notched phone is BEHIND
            the home bar — so without the inset the last ~34px of reserved space is space
            the user cannot see, and the save button creeps back under the floating one.
          */}
          <main className="flex-1 pb-[calc(10rem_+_env(safe-area-inset-bottom))] md:pb-[calc(6rem_+_env(safe-area-inset-bottom))]">
            {children}
          </main>
        </div>

        {/*
          What is waiting, said once after signing in. Mounted in the shell rather than on the
          Command Centre so it finds an administrator wherever they land — most of them arrive
          on a deep link from an email, not on `/admin`. It renders nothing for anyone without
          `admin.access`, and nothing at all when no queue has anything in it.
        */}
        <AttentionPopup />

        {/*
          ── MOBILE BOTTOM BAR — 4 slots + More ────────────────────────────────────────

          REPORTED from an iPhone: "Tab on buttom doesn't give proper visibility" — the
          labels were sliced off along the bottom edge.

          THE CAUSE WAS THE FIX FOR THE HOME BAR EATING ITSELF. This was `h-14` with
          `pb-[env(safe-area-inset-bottom)]`, and Tailwind sets `box-sizing: border-box`,
          so the padding came OUT of the 56px rather than being added to it. On an iPhone
          with a 34px home indicator that leaves 22px of usable bar for a 20px icon and a
          line of 11px text — hence icons touching the border and labels cut in half. On
          an Android phone with no inset the same class read as a perfectly good bar,
          which is why it survived.

          Adding the inset to the height keeps 56px of real, tappable bar wherever the
          home indicator happens to be. Side insets are for landscape, where the notch
          would otherwise sit on top of the first tab.
        */}
        <nav
          className={cn(
            "fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t bg-card md:hidden",
            "h-[calc(3.5rem_+_env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]",
            "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
          )}
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
                    // `min-w-0`: a flex item is floored at its content width by default, so a
                    // long label made this bar wider than the phone — and being `inset-x-0`
                    // fixed, it stretched the document and every page scrolled sideways.
                    "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] min-[360px]:text-[11px]",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )
                }
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="w-full truncate px-0.5 text-center">
                  {t(item.mobileLabelKey ?? item.labelKey)}
                </span>
              </NavLink>
            );
          })}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground min-[360px]:text-[11px]"
              >
                <MoreHorizontal className="h-5 w-5" aria-hidden />
                <span className="w-full truncate px-0.5 text-center">{t("shell.nav.more")}</span>
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t("shell.nav.more")}</SheetTitle>
              </SheetHeader>
              {/*
                The install offer sits here rather than on the home screen: this is the one
                surface every employee on a phone already opens, and it is not on the critical
                path of any task. It renders nothing once the app IS installed.
              */}
              <div className="mt-3">
                <InstallAppCard />
              </div>
              <div className="mt-2">
                <NavGroups collapsed={false} counts={counts} onNavigate={() => setMoreOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
        </nav>

        {/*
          A NEW VERSION IS READY — offered, never applied behind the user's back. The worker
          waits (see `useServiceWorker`), so this is the only route by which an installed app
          moves to a new bundle. Positioned above the mobile bottom bar so it cannot cover the
          navigation, and it takes the FAB's place in the stacking order rather than fighting it.
        */}
        {sw.updateReady ? (
          <div
            role="status"
            className="fixed inset-x-3 bottom-[72px] z-[45] rounded-lg border border-primary/40 bg-card p-3 shadow-lg md:inset-x-auto md:bottom-6 md:left-6 md:max-w-sm"
          >
            <p className="text-sm font-medium">{t("pwa.update.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("pwa.update.body")}</p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={sw.applyUpdate}>
                {t("pwa.update.action")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setUpdateDismissed(true)}>
                {t("pwa.update.later")}
              </Button>
            </div>
          </div>
        ) : null}

        {/* AI FAB — hidden on the kiosk surface (which never renders this shell) */}
        {!location.pathname.startsWith("/me/ask") ? (
          <Button
            asChild
            size="lg"
            /*
              88px was chosen to clear a 56px tab bar with a 32px gap — but the bar is now
              56px PLUS the home indicator, so on an iPhone the button had crept down onto
              its top edge. Same inset, added to both offsets: `md:` still applies to an
              iPad in standalone, which has a home bar of its own.
            */
            className={cn(
              "fixed z-[40] h-14 rounded-full shadow-lg",
              "bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))] md:bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))]",
              "right-[max(1rem,env(safe-area-inset-right))]",
            )}
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
