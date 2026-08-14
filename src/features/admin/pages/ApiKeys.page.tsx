/**
 * A-SET-05 · /admin/settings/api — "Machine credentials, shown once" (route
 * manifest), spec-admin §15.5.
 *
 * THIS SCREEN HAS NO GRID BECAUSE THERE IS NO READ. Not a narrow one — none. The
 * table exists (`secure.api_keys`, migration 012 §9, with `key_prefix`,
 * `key_hash`, `scopes`, `rate_limit_per_min`, `expires_at`, `revoked_at`) and is
 * locked away at two independent levels:
 *
 *  1. `REVOKE ALL ON TABLE secure.api_keys FROM PUBLIC, anon, authenticated`, and
 *     RLS is enabled with no policy for `authenticated` at all.
 *  2. The `secure` SCHEMA never grants USAGE to a client role (migration 001:
 *     `REVOKE ALL ON SCHEMA secure, util, app, audit, analytics FROM PUBLIC`, plus
 *     a per-role revoke loop and matching DEFAULT PRIVILEGES). Without schema
 *     USAGE, no PostgREST request can reach the relation whatever the RLS says.
 *
 * Migration 012's own comment says these rows are "managed by the admin-api-keys
 * edge function only" — and that function is NOT deployed: `supabase/functions/`
 * contains thirty functions and no `admin-api-keys`. So there is no issue path, no
 * rotate path, no revoke path and no list path from this browser today. Rendering
 * an empty grid with a disabled "Issue key" button would imply a feature that
 * cannot fail because it does not exist; this screen names the missing pieces
 * instead.
 *
 * WEBHOOKS ARE ABSENT ENTIRELY. There is no `webhooks`, `webhook_endpoints` or
 * `webhook_deliveries` table anywhere in `supabase/migrations`, so §15.5's
 * endpoint register, HMAC secret, delivery log and replay button have no backing
 * store to be honest about. `integrations.webhook_secret_name` names a Function
 * secret for INBOUND provider callbacks; it is not an outbound webhook register.
 *
 * WHAT IS TRUE AND USEFUL: machine credentials DO exist in this system today —
 * they are kiosk device keys, issued by the `kiosk-provision` and
 * `kiosk-device-activate` edge functions and managed on /admin/kiosk/devices
 * ("The gate tablets, their health and their secrets"). Provider credentials are
 * Supabase Function secrets, named — never valued — on /admin/settings/integrations.
 * So this page routes the admin to the two places the work can actually be done.
 *
 * @route /admin/settings/api
 */
import { KeyRound, Plug, ScanFace, Webhook } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";

/** One "the database does not expose this" card, with the reason and the fix. */
interface CapabilityCard {
  readonly key: string;
  readonly icon: typeof KeyRound;
  readonly title: string;
  readonly body: string;
  readonly evidence: string;
  readonly to?: string;
  readonly linkLabel?: string;
}

const CARDS: readonly CapabilityCard[] = [
  {
    key: "api-keys",
    icon: KeyRound,
    title: t("admin.apiKeys.card.keys.title"),
    body: t("admin.apiKeys.card.keys.body"),
    evidence: t("admin.apiKeys.card.keys.evidence"),
  },
  {
    key: "webhooks",
    icon: Webhook,
    title: t("admin.apiKeys.card.webhooks.title"),
    body: t("admin.apiKeys.card.webhooks.body"),
    evidence: t("admin.apiKeys.card.webhooks.evidence"),
  },
  {
    key: "kiosk",
    icon: ScanFace,
    title: t("admin.apiKeys.card.kiosk.title"),
    body: t("admin.apiKeys.card.kiosk.body"),
    evidence: t("admin.apiKeys.card.kiosk.evidence"),
    to: "/admin/kiosk/devices",
    linkLabel: t("admin.apiKeys.card.kiosk.link"),
  },
  {
    key: "providers",
    icon: Plug,
    title: t("admin.apiKeys.card.providers.title"),
    body: t("admin.apiKeys.card.providers.body"),
    evidence: t("admin.apiKeys.card.providers.evidence"),
    to: "/admin/settings/integrations",
    linkLabel: t("admin.apiKeys.card.providers.link"),
  },
];

export default function ApiKeysPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={KeyRound}
        title={t("admin.apiKeys.title")}
        subtitle={t("admin.apiKeys.subtitle")}
      />

      <Notice tone="note">{t("admin.apiKeys.notice.noClientPath")}</Notice>

      <EmptyState
        icon={KeyRound}
        title={t("admin.apiKeys.empty.title")}
        hint={t("admin.apiKeys.empty.hint")}
      />

      <section className="mt-8">
        <h2 className="mb-1 font-display text-base font-semibold">
          {t("admin.apiKeys.cards.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("admin.apiKeys.cards.subtitle")}</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <article key={card.key} className="flex flex-col rounded-lg border bg-card p-4">
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                    aria-hidden
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-sm font-semibold">{card.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{card.body}</p>
                  </div>
                  <Badge variant={card.to === undefined ? "warning" : "info"}>
                    {card.to === undefined
                      ? t("admin.apiKeys.badge.missing")
                      : t("admin.apiKeys.badge.elsewhere")}
                  </Badge>
                </div>
                <p className="mt-3 border-t pt-3 font-mono text-xs text-muted-foreground">
                  {card.evidence}
                </p>
                {card.to !== undefined && card.linkLabel !== undefined ? (
                  <div className="mt-3">
                    <Button asChild variant="outline" size="sm">
                      <Link to={card.to}>{card.linkLabel}</Link>
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">{t("admin.apiKeys.footnote")}</p>
    </div>
  );
}
