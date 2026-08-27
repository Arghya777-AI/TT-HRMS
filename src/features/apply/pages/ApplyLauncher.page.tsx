/**
 * E-10 · /me/apply — start a request, and see everything already in flight.
 *
 * The tiles are the JOIN of two sources of truth, and invent neither:
 *   - `request_types` (what HR switched on, with its own SLA hours and
 *     attachment rule) — the server decides which requests exist;
 *   - `src/app/route-manifest.ts` (where each one lives, and its rollout phase)
 *     — the router decides which of them has a screen.
 * A request type with no screen in this release is NOT rendered as a dead tile;
 * it is counted, and the count is stated. That is the DR-48 "no dead chrome"
 * rule applied to a launcher.
 *
 * Below the tiles, "My open requests" is the shared `OpenRequestsGrid` — the same
 * component and the same query key E-12's Tracking section uses.
 *
 * @route /me/apply
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, Paperclip } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { ROUTES, type RouteMeta } from "@/app/route-manifest";
import type { RequestType } from "../api/apply.api";
import { useMyOpenRequests, useRequestTypes } from "../hooks/useApply";
import { OpenRequestsGrid } from "../components/OpenRequestsGrid";

/**
 * `request_types.code` → the route that actually collects that request.
 *
 * Codes absent from this map have no employee-facing screen in the spec (shift
 * swap, overtime pre-approval and salary revision are manager/admin surfaces;
 * salary advance has no screen yet). They are counted, not rendered.
 */
const CODE_TO_PATH: Readonly<Record<string, string>> = {
  LEAVE: "/me/leave/apply",
  ATT_REGULARIZATION: "/me/regularizations/new",
  COMP_OFF: "/me/comp-off",
  WEB_LOGIN: "/me/apply/web-punch",
  LOCAL_CLAIM: "/me/apply/claim",
  /*
    TRAVEL_REQUISITION is back.

    It was hidden after "when i click to travel requisition then it redirect to
    local claim so no need of local claim" — not a redirect, but fair: the screen
    could offer nothing except a link to the claim form, because the type had no
    detail table and no approval chain, so no requisition could be filed at all.
    Two tiles where one is a signpost to the other waste a choice.

    Migrations 041100 (the `travel_requisitions` table) and its AC-TRAVEL chain
    changed that. The screen now files a real requisition, which is a DIFFERENT
    act from claiming the money back: one is permission to travel, asked for
    beforehand; the other is the spend, claimed after. Both belong on the menu
    now that both work.
  */
  TRAVEL_REQUISITION: "/me/apply/travel",
  ASSET_REQUEST: "/me/apply/asset",
  RESIGNATION: "/me/apply/resignation",
  IT_DECLARATION: "/me/apply/tax",
  PROFILE_CHANGE: "/me/profile/basic",
  BANK_CHANGE: "/me/profile/payment",
  PAYSLIP_REQUEST: "/me/helpdesk",
  DOCUMENT_REQUEST: "/me/helpdesk",
  FACE_ENROLMENT: "/me/settings/security",
};

/**
 * Types HR has switched on, and which DO have a screen, that this build
 * deliberately does not offer as a tile.
 *
 * A SEPARATE LIST FROM `CODE_TO_PATH`, ON PURPOSE. Deleting a code from that map
 * would hide its tile too — that is how TRAVEL_REQUISITION was hidden above — but
 * it would also fold the type into the `hidden` count, and that count is rendered
 * as "N of these arrive in a later phase". These four are not late; they are
 * withdrawn. So they are dropped BEFORE the count is taken, and the map goes on
 * recording where each one lives for whenever one comes back.
 *
 * None of them loses its screen. Where each screen now stands:
 *   COMP_OFF        → /me/comp-off, which still has its own rail row.
 *   PAYSLIP_REQUEST → /me/helpdesk, where the request is actually raised.
 *   IT_DECLARATION  → /me/apply/tax, no tile, palette-only.
 *   BANK_CHANGE     → /me/profile/payment, whose Payment TAB is itself now hidden
 *                     in `ProfileTabs`, so this one has no employee entrance left
 *                     at all. That is deliberate and the two changes are a pair:
 *                     a bank-change tile leading to a withdrawn tab would be the
 *                     worse of the two states.
 *
 * TO RESTORE one: delete its line here. Nothing else needs changing.
 */
const SUPPRESSED_CODES: ReadonlySet<string> = new Set([
  "COMP_OFF",
  "IT_DECLARATION",
  "PAYSLIP_REQUEST",
  "BANK_CHANGE",
]);

const ROUTE_BY_PATH: Readonly<Record<string, RouteMeta>> = Object.fromEntries(
  ROUTES.map((r) => [r.path, r]),
);

interface Tile {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: RouteMeta["icon"];
  readonly slaHours: number;
  readonly requiresAttachment: boolean;
  readonly phase: RouteMeta["phase"];
}

function buildTiles(types: readonly RequestType[]): { tiles: Tile[]; hidden: number } {
  const tiles: Tile[] = [];
  let hidden = 0;
  for (const type of types) {
    // Withdrawn, not pending — so it is not rendered AND not counted as "later phase".
    if (SUPPRESSED_CODES.has(type.code)) continue;
    const path = CODE_TO_PATH[type.code];
    const route = path === undefined ? undefined : ROUTE_BY_PATH[path];
    if (path === undefined || route === undefined) {
      hidden += 1;
      continue;
    }
    tiles.push({
      key: type.id,
      path,
      // The request type names the request; the route names the screen. The
      // request type wins — it is what the approver will see.
      label: type.name,
      hint: type.description ?? route.hint,
      icon: route.icon,
      slaHours: type.sla_hours,
      requiresAttachment: type.requires_attachment,
      phase: route.phase,
    });
  }
  return { tiles, hidden };
}

function TileCard({ tile }: { tile: Tile }) {
  const Icon = tile.icon;
  return (
    <Link
      to={tile.path}
      className={cn(
        "group flex h-full min-h-24 flex-col rounded-lg border bg-card p-4 transition-colors",
        "hover:border-primary/40 hover:bg-muted/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <span className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium leading-snug">{tile.label}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{tile.hint}</span>
        </span>
      </span>
      <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t("apply.tile.sla", { hours: tile.slaHours })}</span>
        {tile.requiresAttachment ? (
          <span className="inline-flex items-center gap-1">
            <Paperclip className="h-3 w-3" aria-hidden />
            {t("apply.tile.attachment")}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

export default function ApplyLauncherPage() {
  const types = useRequestTypes();
  const open = useMyOpenRequests();

  const { tiles, hidden } = useMemo(() => buildTiles(types.data ?? []), [types.data]);

  return (
    <div className="container py-6">
      <PageHeader icon={ClipboardList} title={t("apply.title")} subtitle={t("apply.subtitle")} />

      <section className="mb-8" aria-labelledby="apply-tiles-heading">
        <h2 id="apply-tiles-heading" className="mb-3 font-display text-lg font-semibold">
          {t("apply.tiles.title")}
        </h2>
        <StateBoundary
          loading={types.isLoading}
          error={types.error ?? undefined}
          onRetry={() => void types.refetch()}
          isEmpty={types.data !== undefined && tiles.length === 0}
          empty={
            <EmptyState
              icon={ClipboardList}
              title={t("apply.tiles.empty.title")}
              hint={t("apply.tiles.empty.hint")}
            />
          }
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map((tile) => (
              <li key={tile.key}>
                <TileCard tile={tile} />
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t("apply.tiles.notLive", { count: hidden })}
            </p>
          ) : null}
        </StateBoundary>
      </section>

      <section aria-labelledby="apply-open-heading">
        <h2 id="apply-open-heading" className="font-display text-lg font-semibold">
          {t("apply.open.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("apply.open.hint")}</p>
        <StateBoundary
          loading={open.isLoading}
          error={open.error ?? undefined}
          onRetry={() => void open.refetch()}
        >
          <OpenRequestsGrid
            rows={open.data?.rows ?? []}
            approvers={open.data?.approvers ?? {}}
            emptyTitle={t("apply.open.empty.title")}
            emptyHint={t("apply.open.empty.hint")}
          />
        </StateBoundary>
      </section>
    </div>
  );
}
