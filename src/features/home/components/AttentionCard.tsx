/**
 * Region C — "Needs your attention", max 5 (spec-employee §5 E-02).
 *
 * Source: the `notifications` feed the server writes. Spec names
 * `rpc_my_pending_actions()`; that function is not in the deployed schema, so
 * rather than re-deriving ten item types in the browser (each one a chance to
 * disagree with the server), this ranks what the server already decided:
 * `priority` DESC, then oldest first, exactly as the spec orders the region.
 *
 * Severity → colour is the documented map (DR-45): nothing negative is calm blue.
 */
import { Link } from "react-router-dom";
import { BellRing, CheckCircle2 } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import type { NotificationItem } from "../api/home.api";
import { internalLink, priorityBadge, rankAttentionItems } from "../display";
import { HomeCard, RegionBody, RowsSkeleton } from "./HomeCard";

export interface AttentionCardProps {
  query: UseQueryResult<NotificationItem[], Error>;
  nowMs: number;
}

export function AttentionCard({ query, nowMs }: AttentionCardProps) {
  return (
    <HomeCard
      icon={BellRing}
      title={t("home.attention.title")}
      action={
        <Button asChild variant="ghost" size="sm">
          <Link to="/me/notifications">{t("home.attention.viewAll")}</Link>
        </Button>
      }
    >
      <RegionBody
        query={query}
        skeleton={<RowsSkeleton rows={3} />}
        isEmpty={(items) => rankAttentionItems(items, nowMs).length === 0}
        empty={
          <EmptyState
            icon={CheckCircle2}
            title={t("home.attention.empty.title")}
            hint={t("home.attention.empty.hint")}
          />
        }
      >
        {(items) => (
          <ul className="divide-y">
            {rankAttentionItems(items, nowMs).map((item) => {
              const badge = priorityBadge(item.priority);
              const href = internalLink(item.deep_link);
              return (
                <li key={item.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="min-w-0">{item.title}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    {item.body !== null && item.body !== "" ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">{item.body}</p>
                    ) : null}
                    <p className="num mt-0.5 text-xs text-muted-foreground">
                      {fmtDateTime(item.recorded_at)}
                    </p>
                  </div>
                  {href !== null ? (
                    <Button asChild variant="outline" size="sm" className="shrink-0">
                      <Link to={href}>{t("home.attention.open")}</Link>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </RegionBody>
    </HomeCard>
  );
}
