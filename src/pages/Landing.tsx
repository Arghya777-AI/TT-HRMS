import { Link } from "react-router-dom";
import { ArrowRight, ScanFace, ShieldCheck, UserCog, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ModeToggle } from "@/components/theme/mode-toggle";
import { BRAND } from "@/config/brand";
import { fmtDateTime, nowInstantIso } from "@/lib/datetime";

const SURFACES = [
  {
    to: "/employee",
    icon: Users,
    title: "Employee",
    description: "My attendance, roster, leave, payslips and profile — own data only.",
    tint: "text-brand-terracotta",
  },
  {
    to: "/manager",
    icon: UserCog,
    title: "Manager",
    description: "Team presence, approvals inbox and rostering against the event calendar.",
    tint: "text-brand-gold",
  },
  {
    to: "/admin",
    icon: ShieldCheck,
    title: "Admin",
    description: "The control plane — every policy, payroll, documents, analytics and the full audit trail.",
    tint: "text-info",
  },
  {
    to: "/kiosk",
    icon: ScanFace,
    title: "Guard Kiosk",
    description: "One shared gate camera. Walk up, look, chime, walk on — 1:N face check-in.",
    tint: "text-success",
  },
] as const;

const SWATCHES = [
  { name: "Terracotta", cls: "bg-brand-terracotta" },
  { name: "Gold", cls: "bg-brand-gold" },
  { name: "Plum", cls: "bg-brand-plum" },
  { name: "Navy", cls: "bg-brand-navy" },
  { name: "Cream", cls: "bg-brand-cream border" },
] as const;

export default function Landing() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl font-bold tracking-tight">The Tamarind Tree</span>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
              HRMS
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/login">Sign in</Link>
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="container py-12 md:py-16">
        <section className="max-w-3xl">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {BRAND.combined}
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold leading-tight md:text-5xl">
            The venue's operational memory — in Indian Standard Time, for the record, forever.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            A guard's two-second face scan at the gate becomes the roster that was worked, the overtime
            that was earned, the comp-off that was credited, and the payslip that was paid — without a
            single re-entry of data.
          </p>
        </section>

        <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SURFACES.map(({ to, icon: Icon, title, description, tint }) => (
            <Card key={to} className="group transition-shadow hover:shadow-md">
              <CardHeader>
                <Icon className={`h-8 w-8 ${tint}`} aria-hidden />
                <CardTitle className="mt-2">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline" size="sm" className="w-full justify-between">
                  <Link to={to}>
                    Preview <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="mt-14 rounded-lg border bg-card p-6">
          <h2 className="font-display text-lg font-semibold">Design system</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Warm heritage, not generic SaaS. Serif display (Unna) over Poppins, on the venue's palette.
          </p>
          <div className="mt-5 flex flex-wrap gap-4">
            {SWATCHES.map((s) => (
              <div key={s.name} className="flex flex-col items-center gap-1.5">
                <div className={`h-12 w-12 rounded-md ${s.cls}`} aria-hidden />
                <span className="text-xs text-muted-foreground">{s.name}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-foreground">
          <strong>Foundation preview.</strong> Scaffold, design tokens and IST-native libraries are live.
          Auth-gating, RLS and live data land as the Supabase migrations are applied. Server clock right
          now: {fmtDateTime(nowInstantIso())}.
        </div>
      </main>

      <footer className="border-t">
        <div className="container flex flex-col gap-1 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{BRAND.combined}</span>
          <span>{BRAND.venueAddress}</span>
        </div>
      </footer>
    </div>
  );
}
