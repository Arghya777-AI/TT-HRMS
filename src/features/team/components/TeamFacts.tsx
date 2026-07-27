/**
 * TeamFacts.tsx — the READ-ONLY field vocabulary of the manager surface.
 *
 * WHY THIS EXISTS RATHER THAN REUSING `features/profile/components/FieldRow`
 * -------------------------------------------------------------------------
 * `FieldRow` is the right shape, but it REQUIRES an `EditAuthority` marker on
 * every row — "you may edit this" / "ask HR" / "system-owned". On a manager
 * screen that badge would be a lie in every position: a manager may edit none of
 * these fields, and there is no change-request path from here. Rather than pass
 * a placeholder authority on twenty rows, the manager surface gets a vocabulary
 * with no edit affordance to explain away.
 *
 * The two shared components this surface DOES reuse are `PersonCell` and
 * `Notice` from the admin console, imported directly by the pages: those solve
 * name/code rendering (DR-23) and honest banner semantics once, and forking them
 * would fork the defect fixes with them.
 *
 * What is preserved here from `FieldRow`'s reasoning:
 *  - Field/value pairs are a `<dl>`, which is what a screen reader announces
 *    correctly once the grid collapses to one column at 360px.
 *  - A nullish value renders the em dash via `dash()` — never blank, and never a
 *    status sentence dumped in a value slot (DR-04).
 */
import type { ComponentType, ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * `| undefined` is spelled out on every optional prop on purpose. Under
 * `exactOptionalPropertyTypes` a bare `hint?: string` REFUSES an explicit
 * `hint={undefined}`, which is exactly what a conditional caller writes
 * (`hint={crossesMidnight ? t(…) : undefined}`). Widening the type here keeps
 * that natural expression legal instead of forcing a `...(x !== undefined ? …)`
 * spread at twenty call sites.
 */
export interface FactProps {
  label: string;
  /** Rendered as-is when a node; nullish or empty becomes '—'. */
  value?: ReactNode | undefined;
  /** One line under the value: a policy note, a caveat, where the fact came from. */
  hint?: string | undefined;
  /** Span the full row on wide screens (sentences, long lists). */
  wide?: boolean | undefined;
}

function isEmptyValue(value: ReactNode): boolean {
  return value === null || value === undefined || value === "";
}

/** One label / value pair inside a `<FactGrid>`. */
export function Fact({ label, value, hint, wide = false }: FactProps) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-3")}>
      <dt className="text-xs text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
      </dt>
      <dd className="mt-1 break-words text-sm">{isEmptyValue(value) ? dash(null) : value}</dd>
      {hint !== undefined && hint !== "" ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** 1 column at 360px, 2 at ≥640px, 3 at ≥1024px. */
export function FactGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
  );
}

export interface FactCardProps {
  icon?: ComponentType<{ className?: string }> | undefined;
  title: string;
  /** Must describe the ACTUAL content of the card (DR-08/DR-09). */
  description?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
}

/** A titled card holding one group of facts. */
export function FactCard({ icon: Icon, title, description, actions, children }: FactCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <div
              className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
              aria-hidden
            >
              <Icon className="h-4 w-4" />
            </div>
          ) : null}
          <div className="min-w-0">
            <CardTitle className="text-base">{title}</CardTitle>
            {description !== undefined ? (
              <CardDescription className="mt-1">{description}</CardDescription>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

/**
 * A boolean fact rendered as WORDS, not a tick. `is_ot_eligible: false` must
 * read "Not eligible for overtime", never an empty cell that a manager would
 * read as missing data.
 */
export function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return (
    <span className={value ? "text-foreground" : "text-muted-foreground"}>
      {value ? yes : no}
    </span>
  );
}
