/**
 * PersonChip.tsx — a person rendered as a person (DR-23).
 *
 * The reference product printed `Mrunalini Neelamraju-MIDCC001`,
 * `Monisha K[SSSRC018]` and `ARGHYA GHOSH(SSSRC062)` — three different
 * concatenations of the same two facts, none of them selectable, sortable or
 * translatable. Here the name and the code are separate elements, the name keeps
 * its stored natural case (no CSS uppercase — DR-14), and the code is a chip.
 */
import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import type { PersonRef } from "../api/profile.api";

/** First letters of the first and last word — no locale-specific assumptions. */
function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((w) => w.length > 0);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

export interface PersonChipProps {
  person: PersonRef | null;
  /** True when the record holds an id but the directory has no row for it. */
  unresolved?: boolean;
  className?: string;
}

export function PersonChip({ person, unresolved = false, className }: PersonChipProps) {
  if (person === null) {
    return (
      <span className="text-sm text-muted-foreground">
        {unresolved ? t("profile.person.notInDirectory") : t("common.empty")}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Avatar className="h-7 w-7 shrink-0">
        <AvatarFallback className="text-[11px]">
          {initials(person.display_name) || <UserRound className="h-3.5 w-3.5" aria-hidden />}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="truncate text-sm font-medium">{person.display_name}</span>
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
            {person.employee_code}
          </span>
        </span>
        {person.designation_name !== null ? (
          <span className="block truncate text-xs text-muted-foreground">
            {person.designation_name}
          </span>
        ) : null}
      </span>
    </span>
  );
}
