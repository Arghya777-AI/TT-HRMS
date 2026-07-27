/**
 * KioskLinkCard — the gate link, ready to copy and send to whoever is on the door.
 *
 * WHY, IN THE CLIENT'S WORDS
 * -------------------------
 * "Some kiosk will have a link that will be deployed in a laptop or a mobile… I
 *  want to create it as a public link. Public link means that link will be
 *  available in the dashboard. They can copy it and send it to the security person
 *  or something like that."
 *
 * `/kiosk` already existed as a standalone route with no session requirement — but
 * nothing in the admin dashboard ever showed it, so the only way to hand it to a
 * guard was for somebody to know the path and type it. This card is that missing
 * step and nothing more: it composes the URL from the origin the admin is already
 * on, so it is correct in dev, on a LAN address and in production without anybody
 * configuring a base URL.
 *
 * WHAT "PUBLIC" DOES AND DOES NOT MEAN — the honest version, on screen too
 * ----------------------------------------------------------------------
 * Opening the link gives you a pairing prompt, not a gate. Before a single face
 * can be scanned the device must be PAIRED with a one-time activation code issued
 * from this very screen, and then a guard must sign in with their PIN. The link is
 * safe to send over WhatsApp precisely because on its own it can do nothing:
 *   * no activation code → the device cannot authenticate at all;
 *   * no guard PIN session → `sendPunch` refuses locally with NO_OPERATOR;
 *   * every request is HMAC-signed with the device secret and carries a single-use
 *     nonce, so a copied request cannot be replayed.
 * The card says this out loud, because "public link" and "anybody can mark
 * attendance" are very different claims and the difference matters.
 *
 * HTTPS IS NOT OPTIONAL, and this is the one thing that silently ruins a demo.
 * `getUserMedia` and `navigator.geolocation` both require a secure context, so a
 * kiosk opened at `http://192.168.x.x:5173` gets NO camera and NO location — the
 * screen looks fine and simply never sees a face. Localhost counts as secure; a
 * bare LAN IP over http does not. The warning below only appears when the page is
 * actually being served insecurely, so it is information rather than noise.
 */
import { useState } from "react";
import { Check, Copy, Link2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";

/** The standalone kiosk route (`@route-standalone /kiosk`). */
const KIOSK_PATH = "/kiosk";

/**
 * A secure context is what the camera and geolocation actually require. Read from
 * the browser rather than guessed from the protocol: `isSecureContext` already
 * knows that `localhost` is trusted while `http://192.168.1.9` is not, and
 * re-deriving that rule here would only be a second, worse copy of it.
 */
function isSecure(): boolean {
  return typeof window !== "undefined" && window.isSecureContext;
}

export function KioskLinkCard() {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? KIOSK_PATH : `${window.location.origin}${KIOSK_PATH}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Reverts on its own. A permanent tick would still read as "copied" long
      // after the clipboard has moved on to something else.
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permission, or a non-secure context).
      // The URL is on screen and selectable, so there is nothing to recover from
      // and nothing worth interrupting the admin about.
      setCopied(false);
    }
  };

  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-2">
        <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{t("admin.kiosk.link.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.kiosk.link.blurb")}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Selectable text, not just a copy button: a copy that silently fails
                on a refused clipboard permission must still leave the admin able
                to read the URL and type it. */}
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 text-xs">
              {url}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copy();
              }}
            >
              {copied ? (
                <Check className="mr-1.5 h-4 w-4" aria-hidden />
              ) : (
                <Copy className="mr-1.5 h-4 w-4" aria-hidden />
              )}
              {copied ? t("admin.kiosk.link.copied") : t("admin.kiosk.link.copy")}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={url} target="_blank" rel="noreferrer">
                {t("admin.kiosk.link.open")}
              </a>
            </Button>
          </div>

          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t("admin.kiosk.link.step1")}</li>
            <li>{t("admin.kiosk.link.step2")}</li>
            <li>{t("admin.kiosk.link.step3")}</li>
          </ol>

          {!isSecure() ? (
            <p
              className="mt-3 flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs"
              role="status"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t("admin.kiosk.link.insecure")}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
