/**
 * AttentionBar — one line that says whether anything needs you, and opens if it does.
 *
 * ── WHY IT IS NOT A CARD ANY MORE ────────────────────────────────────────────
 * "Needs your attention" was a third of the top row, and the row was the first screen. On a
 * laptop that meant Attendance and Today were each squeezed into a third; on a phone it meant
 * two full cards between the punch button and anything else. The list also has no natural end,
 * so the card was the tallest thing in the row and the other two were padded to match.
 *
 * A notification list is not a thing you DO on this page — it is a thing you check. So it is a
 * bar: one line, a count, the most urgent title, and a press to open the rest. The two cards
 * that ARE actions get half the row each.
 *
 * ── IT ABSORBS THE FACE-ENROLMENT ASK ────────────────────────────────────────
 * That ask was its own full-width block, which on a phone was a whole card of vertical space
 * for a sentence. It is a notification — "HR has asked you to do something" — so it belongs
 * here, at the top of the list, and the block is gone.
 *
 * It cannot come through `public.notifications` to get here: that table is partitioned and its
 * INSERT is revoked from `authenticated`, so no browser code can write the in-app row, and
 * most venue staff have no work email. It is therefore merged in on the client from the
 * request the employee can already read.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, CheckCircle2, ChevronDown, ScanFace } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { NotificationItem } from "../api/home.api";
import {
  internalLink,
  priorityBadge,
  rankAttentionItems,
  type AttentionBadgeVariant,
} from "../display";
import { useMyFaceEnrolmentAsk } from "../hooks/useFaceEnrolmentAsk";

export interface AttentionBarProps {
  readonly query: UseQueryResult<NotificationItem[], Error>;
  readonly nowMs: number;
}

/** One row, whichever list it came from. */
interface BarItem {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly at: string | null;
  readonly href: string | null;
  readonly badge: { label: string; variant: AttentionBadgeVariant } | null;
  readonly isFace: boolean;
}

export function AttentionBar({ query, nowMs }: AttentionBarProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ask = useMyFaceEnrolmentAsk();

  const ranked = rankAttentionItems(query.data ?? [], nowMs);
  const items: BarItem[] = ranked.map((item) => {
    const badge = priorityBadge(item.priority);
    return {
      id: item.id,
      title: item.title,
      body: item.body === "" ? null : item.body,
      at: item.recorded_at,
      href: internalLink(item.deep_link),
      badge: { label: badge.label, variant: badge.variant },
      isFace: false,
    };
  });

  /*
    The enrolment ask goes FIRST when it is actionable. It is the only item on this list the
    employee has to physically go and do something about, and a `pending` one is placed with
    the rest because there is nothing left for them to do.
  */
  if (ask.data !== undefined && ask.data !== null) {
    const awaiting = ask.data.status === "pending";
    const row: BarItem = {
      id: `face-${ask.data.id}`,
      title: awaiting ? t("me.faceAsk.pending.title") : t("me.faceAsk.draft.title"),
      body: awaiting ? t("me.faceAsk.pending.lead") : t("me.faceAsk.draft.lead"),
      at: ask.data.requested_at,
      // Not a face-capture screen: registration is admin-supervised, with the employee
      // present. What they CAN do from here is ask HR when to come.
      href: awaiting ? null : "/me/helpdesk",
      badge: null,
      isFace: true,
    };
    if (awaiting) items.push(row);
    else items.unshift(row);
  }

  // Nothing to say, and nothing loading: render nothing rather than an empty bar every visit.
  if (items.length === 0) {
    if (query.isPending || ask.isPending) return null;
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden />
        {t("home.attention.empty.title")}
      </div>
    );
  }

  const first = items[0] as BarItem;

  return (
    <section className="mb-4 overflow-hidden rounded-lg border bg-card" aria-label={t("home.attention.title")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {first.isFace ? (
          <ScanFace className="size-4 shrink-0 text-info" aria-hidden />
        ) : (
          <BellRing className="size-4 shrink-0 text-warning" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="text-sm font-medium">
            {t("home.attention.count", { n: String(items.length) })}
          </span>
          {/*
            The most urgent one, on the same line. A bar that only said "3 things need you"
            makes everybody open it to find out whether any of them matter.
          */}
          <span className="ml-2 text-sm text-muted-foreground">·</span>
          <span className="ml-2 text-sm text-muted-foreground">{first.title}</span>
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <ul className="divide-y border-t">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="min-w-0">{item.title}</span>
                  {item.badge !== null ? (
                    <Badge variant={item.badge.variant}>{item.badge.label}</Badge>
                  ) : null}
                </div>
                {item.body !== null ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                ) : null}
                {item.at !== null ? (
                  <p className="num mt-0.5 text-[11px] text-muted-foreground">
                    {fmtDateTime(item.at)}
                  </p>
                ) : null}
              </div>
              {item.href !== null ? (
                <Button asChild variant="outline" size="sm" className="shrink-0">
                  <Link to={item.href}>{t("home.attention.open")}</Link>
                </Button>
              ) : null}
            </li>
          ))}
          <li className="px-3 py-2">
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
              <Link to="/me/notifications">{t("home.attention.viewAll")}</Link>
            </Button>
          </li>
        </ul>
      ) : null}
    </section>
  );
}
