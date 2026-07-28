/**
 * AuthLayout — shared chrome for the four unauthenticated screens: sign-in, forgot
 * password, reset password and first run (spec-employee E-01).
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE BRAND, AT LAST
 *
 * This screen used to open with a terracotta square containing the letters "TT" — a
 * placeholder that had outlived its purpose while the real gold monogram sat unused in
 * the repository. It now leads with the actual lockup, and the surface behind it is the
 * venue's own colours: deep canopy green, the olive of the water, and the logo's gold.
 *
 * TWO COLUMNS ON A LARGE SCREEN, ONE ON A SMALL ONE
 *
 * The left panel is decoration with a job: it is the only place in the product with room
 * to show the full lockup — monogram, wordmark and "live the heritage…" — at a size
 * where the script line is legible. It is `hidden lg:flex`, so a phone gets the mark
 * above the card instead and pays nothing for the panel.
 *
 * The form column keeps a hard `max-w` and stays centred: a sign-in form stretched
 * across a 27-inch monitor is the most common way this pattern is got wrong.
 *
 * WHAT THE FOOTER SAYS, AND WHY THAT IS DELIBERATE
 *
 * It states that the system is built and maintained IN-HOUSE, and names no vendor,
 * agency or tool. That was an explicit instruction and it is also the honest line: the
 * employer of record is already on the plate, so somebody signing in to see their own
 * attendance and salary can tell who is accountable for it, and no outside party is
 * implied to be holding their data.
 */
import type { ReactNode } from "react";
import { ModeToggle } from "@/components/theme/mode-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandLogo } from "@/shared/ui/BrandLogo";
import { BRAND } from "@/config/brand";
import { t } from "@/shared/i18n/en";

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* ── The heritage panel ──────────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden bg-brand-bark lg:flex lg:flex-col lg:justify-between">
        {/*
          Layered gradients rather than a photograph: the venue's own greens, with no
          image to download, nothing to go stale, and no risk of type landing on a busy
          part of a picture. The radial pools read as light coming through a canopy.
        */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(120%_90%_at_15%_10%,hsl(var(--brand-water)/0.95),transparent_60%),radial-gradient(90%_70%_at_85%_0%,hsl(var(--brand-moss)/0.35),transparent_55%),linear-gradient(180deg,hsl(var(--brand-foliage)/0.85),hsl(var(--brand-bark)))]"
        />
        {/* One hairline of gold down the inner edge, the way heritage signage is edged.
            Kept to a single pixel so it reads as craft rather than as chrome. */}
        <div aria-hidden className="absolute inset-y-0 right-0 w-px bg-brand-gold/40" />

        <div className="relative flex flex-1 flex-col items-center justify-center px-12 py-16 text-center">
          <BrandLogo variant="lockup" className="w-[19rem] max-w-full" />
          <p className="mt-10 max-w-sm text-sm leading-relaxed text-brand-cream/70">{BRAND.tagline}</p>
        </div>

        <p className="relative px-12 pb-10 text-center text-xs text-brand-cream/45">
          {BRAND.combined}
        </p>
      </aside>

      {/* ── The form column ────────────────────────────────────────────────── */}
      <main className="flex min-h-dvh flex-col bg-gradient-to-b from-brand-cream to-background px-4 py-8 dark:from-background dark:to-background">
        <div className="flex justify-end">
          <ModeToggle />
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-6">
          {/* The mark, for the screens too narrow to show the panel. NOT decorative
              here: it is the only brand identification present. */}
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <BrandLogo variant="mark" className="h-14 w-14" />
            <div className="text-center">
              <p className="font-display text-lg font-semibold leading-none">{BRAND.tradingName}</p>
              <p className="mt-1 text-xs text-muted-foreground">{BRAND.legalName}</p>
            </div>
          </div>

          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-1.5">
              {/* A short gold rule above the title — the one flourish on the card. It
                  answers the panel's edge line without tinting the card itself. */}
              <span aria-hidden className="block h-0.5 w-10 rounded-full bg-brand-gold" />
              <CardTitle className="font-display text-2xl">{title}</CardTitle>
              {description ? <CardDescription>{description}</CardDescription> : null}
            </CardHeader>
            <CardContent>{children}</CardContent>
          </Card>

          {footer ? (
            <div className="mt-5 text-center text-sm text-muted-foreground">{footer}</div>
          ) : null}
        </div>

        {/* Built in-house, and nothing else claimed. See the file header. */}
        <p className="mt-auto text-center text-xs text-muted-foreground/70">
          {t("auth.builtInHouse")}
        </p>
      </main>
    </div>
  );
}
