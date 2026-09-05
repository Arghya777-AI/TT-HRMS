/**
 * AttentionPopup — the small card that says what is waiting, once, after signing in.
 *
 * "Show a small pop-up when the admin logs in saying a notification has come. It should show
 * what the notification is. They can cross it, but they should still be able to see that a
 * notification has come."
 *
 * So: it names the queues rather than saying "you have notifications", it closes on a cross,
 * and closing it loses nothing — the red banner on the Command Centre and the bell's own
 * count are both still there. This is a nudge towards them, not the only copy of the fact.
 *
 * ── ONCE PER SIGN-IN, NOT ONCE PER PAGE ──────────────────────────────────────
 * Dismissal is held in `sessionStorage` under the signed-in user's id. Per-tab and cleared
 * when the tab closes, which is the closest thing to "per login" available on the client
 * without inventing a login event: navigating around the console will not bring it back, a
 * fresh tab tomorrow morning will, and a different account in the same tab gets its own key.
 *
 * A storage that throws (private windows, blocked site data) must not take the popup with it
 * — every access is wrapped, and the failure mode is "shows every time", not "crashes".
 *
 * ── WHY IT IS NOT THE NOTIFICATION FEED ──────────────────────────────────────
 * Because that feed currently holds 39,572 unread `KIOSK_OFFLINE` rows, and a popup reporting
 * it would say "17,890 notifications" to the administrator who most needs to read it. See
 * `attention.ts`. This counts work with a verb attached.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BellRing, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import { ADMIN_ROUTES } from "../command-vocab";
import { headlineKey, popupItems } from "../attention";
import { useAdminAttention } from "../hooks/useAdminAttention";

const SEEN_PREFIX = "tt_attention_seen:";

function seenKey(userId: string): string {
  return `${SEEN_PREFIX}${userId}`;
}

/** Both wrapped: a browser that refuses session storage must still show the popup. */
function readSeen(userId: string): boolean {
  try {
    return window.sessionStorage.getItem(seenKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeSeen(userId: string): void {
  try {
    window.sessionStorage.setItem(seenKey(userId), "1");
  } catch {
    /* Nothing to do. The popup reappearing is a smaller harm than a thrown render. */
  }
}

/**
 * Mounted for every reader; renders for administrators only.
 *
 * The capability test is here rather than at the call site so the seven counts behind
 * `useAdminAttention` are never issued for an employee who would not be shown the result.
 * Hooks cannot be conditional, so the gate is a component boundary.
 */
export function AttentionPopup(): React.JSX.Element | null {
  const { caps, session } = useAuth();
  const userId = session?.user.id ?? null;
  if (!caps.has("admin.access") || userId === null) return null;
  return <AttentionPopupInner userId={userId} />;
}

function AttentionPopupInner({ userId }: { readonly userId: string }): React.JSX.Element | null {
  const attention = useAdminAttention();
  const [dismissed, setDismissed] = useState(() => readSeen(userId));

  /* A different account in the same tab is a different question. */
  useEffect(() => {
    setDismissed(readSeen(userId));
  }, [userId]);

  const dismiss = useCallback(() => {
    writeSeen(userId);
    setDismissed(true);
  }, [userId]);

  if (dismissed || attention.isPending || attention.items.length === 0) return null;

  const { shown, more } = popupItems(attention);

  return (
    <div
      role="status"
      aria-live="polite"
      /* Above the content, clear of the mobile bottom bar and of the floating action button. */
      className="fixed bottom-20 right-4 z-50 w-[min(20rem,calc(100vw-2rem))] sm:bottom-4"
    >
      <div
        className={cn(
          "rounded-lg border p-3 shadow-lg",
          attention.urgent
            ? "border-destructive/50 bg-card"
            : "border-warning/50 bg-card",
        )}
      >
        <div className="flex items-start gap-2">
          <BellRing
            className={cn(
              "mt-0.5 h-4 w-4 shrink-0",
              attention.urgent ? "text-destructive" : "text-warning",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "font-display text-sm font-semibold",
                attention.urgent ? "text-destructive" : "text-warning",
              )}
            >
              {t(headlineKey(attention), { n: formatNumber(attention.headline) })}
            </p>

            <ul className="mt-2 space-y-1">
              {shown.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.href}
                    onClick={dismiss}
                    className="block truncate text-xs text-foreground underline-offset-2 hover:underline"
                  >
                    {t(item.labelKey, { n: formatNumber(item.count) })}
                  </Link>
                </li>
              ))}
              {more > 0 ? (
                <li className="text-xs text-muted-foreground">
                  {t("admin.attention.popupMore", { n: formatNumber(more) })}
                </li>
              ) : null}
            </ul>

            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                <Link to={ADMIN_ROUTES.command} onClick={dismiss}>
                  {t("admin.attention.popupOpen")}
                </Link>
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {t("admin.attention.stillThere")}
              </span>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={dismiss}
            aria-label={t("admin.attention.popupDismiss")}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
