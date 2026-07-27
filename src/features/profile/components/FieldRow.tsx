/**
 * FieldRow.tsx — one label / value / authority row, and the card that holds them.
 *
 * A definition list rather than a table: these are field–value pairs, not tabular
 * data, and `<dl>` is what a screen reader announces correctly at 360px where the
 * layout collapses to one column.
 *
 * `value` is a ReactNode so a row can hold a `MaskedValue`, a `StatusChip` or a
 * plain string, but the DEFAULT for a nullish value is the universal em dash via
 * `dash()` — no row is ever blank (DR-04: "About is Not Available" dumped as a
 * value is a status masquerading as data).
 */
import type { ReactNode } from "react";
import type { ComponentType } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AuthorityBadge, AuthorityLegend } from "./AuthorityBadge";
import type { EditAuthority } from "../types";

export interface FieldRowProps {
  label: string;
  /** Rendered as-is when a node; nullish strings become '—'. */
  value?: ReactNode;
  authority: EditAuthority;
  /** One line under the value — a policy note, a caveat, a next step. */
  hint?: string;
  /** Span two columns on wide screens (addresses, long sentences). */
  wide?: boolean;
}

function isEmptyValue(value: ReactNode): value is null | undefined | "" {
  return value === null || value === undefined || value === "";
}

export function FieldRow({ label, value, authority, hint, wide = false }: FieldRowProps) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-4")}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        <AuthorityBadge authority={authority} compact />
      </dt>
      <dd className="mt-1 break-words text-sm">
        {isEmptyValue(value) ? dash(null) : value}
      </dd>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export interface ProfileCardProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** Show the three-marker legend in this card's header. */
  legend?: boolean;
  /** Right-aligned header slot (a reveal control, a report-lost button…). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A titled card. `description` must describe the ACTUAL content — DR-08 and
 * DR-09 exist because the reference product titled a field-change log "Historic
 * employment lifecycle events" and structure versions "Historic salary payout
 * records".
 */
export function ProfileCard({
  icon: Icon,
  title,
  description,
  legend = false,
  actions,
  children,
}: ProfileCardProps) {
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
            {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {legend ? <AuthorityLegend className="border-b pb-4" /> : null}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The field grid: 1 column at 360px, 2 at ≥640px, 4 at ≥1024px. The 4-up desktop
 * layout matches the reference product's density without its "label over value,
 * no separation" ambiguity.
 */
export function FieldGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">{children}</dl>
  );
}

/** A two-up grid for cards whose values are sentences rather than short fields. */
export function SentenceGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-4 lg:grid-cols-2">{children}</dl>;
}
