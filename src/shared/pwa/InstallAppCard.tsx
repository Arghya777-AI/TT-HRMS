/**
 * InstallAppCard — one big button that installs the app.
 *
 * ── ONE TAP WHERE THE PLATFORM ALLOWS IT ─────────────────────────────────────
 * On Android and Chrome the button calls the browser's own install prompt: tap, confirm, done.
 * That path is the default and it is what most of the staff here will meet. It only works
 * because `index.html` catches `beforeinstallprompt` before React exists — see `useInstallApp`.
 *
 * ── AND ON iPHONE, WHICH ALLOWS NOTHING ──────────────────────────────────────
 * Safari exposes no install API. A web page on iOS cannot install itself, cannot ask to, and
 * cannot detect whether the person did it; Apple reserves that to the Share menu. So on iOS the
 * same button opens a full-screen picture of where to tap — a large Share glyph, an arrow
 * pointing at the bottom of the screen where the real one sits, and two short lines.
 *
 * Chosen over two worse alternatives:
 *   * a button that says "Install" and does nothing on iOS — the worst outcome, because the
 *     person concludes the app is broken;
 *   * the paragraph of numbered instructions this replaced. Staff here are not reading a list
 *     on a phone. A picture of the button they must press is a different thing.
 *
 * ── IT IS BIG ON PURPOSE ─────────────────────────────────────────────────────
 * Full width, `size="lg"`, one instruction, same wording everywhere. This is used once per
 * employee, by people who do not spend their day in software; a discreet secondary button
 * would not be found. It disappears entirely once the app is installed.
 */
import { useEffect, useState } from "react";
import { ArrowDown, Check, Download, Plus, Share, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { t } from "@/shared/i18n/en";
import { useInstallApp } from "./useInstallApp";

/** Remembers that the iPhone guide has been shown, so it opens itself exactly once. */
const GUIDE_SEEN_KEY = "tt.pwa.guideSeen";

function guideAlreadySeen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_SEEN_KEY) === "1";
  } catch {
    // Private mode, or storage disabled. Treat as seen: showing the sheet on every single
    // visit would be worse than never showing it.
    return true;
  }
}

export interface InstallAppCardProps {
  /**
   * Open the guide by itself, once, on a device where no button can install anything.
   *
   * Set on the home-screen instance only. On iPhone there is no install API at all, so an
   * employee who never opens the "More" menu would never learn the app exists — and these are
   * people who will not go looking. On Android nothing auto-opens, because the button there
   * does the job on its own.
   */
  readonly autoOpenGuideOnIos?: boolean;
}

export function InstallAppCard({
  autoOpenGuideOnIos = false,
}: InstallAppCardProps = {}): React.JSX.Element | null {
  const { mode, isIos, install } = useInstallApp();
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (!autoOpenGuideOnIos || !isIos || mode !== "guide") return;
    if (guideAlreadySeen()) return;
    try {
      window.localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch {
      return;
    }
    // A beat after load, so it does not fight the page painting for attention.
    const timer = window.setTimeout(() => setGuideOpen(true), 1200);
    return () => window.clearTimeout(timer);
  }, [autoOpenGuideOnIos, isIos, mode]);

  if (mode === "unavailable") return null;

  return (
    <>
      <section
        aria-label={t("pwa.install.title")}
        className="rounded-lg border border-primary/30 bg-primary/5 p-3"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
          >
            <Smartphone className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("pwa.install.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("pwa.install.body")}</p>
          </div>
        </div>

        {/* One button, same wording on every device. What it DOES differs, because the
            platforms differ; what the employee has to decide does not. */}
        <Button
          size="lg"
          className="mt-3 w-full"
          disabled={busy}
          onClick={() => {
            if (mode === "prompt") {
              setBusy(true);
              void install()
                .then((accepted) => setDeclined(!accepted))
                .finally(() => setBusy(false));
              return;
            }
            setGuideOpen(true);
          }}
        >
          <Download className="size-4" aria-hidden />
          {t("pwa.install.action")}
        </Button>

        {/* Only after a refusal. A browser prompt cannot be reopened from the same event, so
            saying nothing would leave the button looking broken on the second tap. */}
        {declined ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("pwa.install.declined")}</p>
        ) : null}
      </section>

      {/* ── The picture ──────────────────────────────────────────────────────
          A sheet rather than a page, so it dismisses with a swipe and nothing is navigated away
          from. Two steps, one line each, each carrying the glyph the person is hunting for. */}
      <Sheet open={guideOpen} onOpenChange={setGuideOpen}>
        <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto">
          <div className="mx-auto max-w-sm pb-2">
            <h2 className="text-center font-display text-lg font-semibold">
              {t("pwa.guide.title")}
            </h2>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              {isIos ? t("pwa.guide.iosLead") : t("pwa.guide.otherLead")}
            </p>

            <ol className="mt-5 space-y-4">
              <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <span
                  aria-hidden
                  className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
                >
                  {isIos ? <Share className="size-6" /> : <MoreGlyph />}
                </span>
                <p className="min-w-0 text-sm font-medium">
                  {isIos ? t("pwa.guide.iosStep1") : t("pwa.guide.otherStep1")}
                </p>
              </li>
              <li className="flex items-center gap-3 rounded-lg border bg-card p-3">
                <span
                  aria-hidden
                  className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
                >
                  <Plus className="size-6" />
                </span>
                <p className="min-w-0 text-sm font-medium">
                  {isIos ? t("pwa.guide.iosStep2") : t("pwa.guide.otherStep2")}
                </p>
              </li>
            </ol>

            {/* Points at the real Share button, which on an iPhone is at the BOTTOM of the
                screen — the single most common thing people get wrong, because on an iPad and
                on older iOS it sits at the top. */}
            {isIos ? (
              <div className="mt-5 flex flex-col items-center text-primary">
                <p className="text-xs font-medium">{t("pwa.guide.iosWhere")}</p>
                <ArrowDown className="mt-1 size-8 animate-bounce" aria-hidden />
              </div>
            ) : null}

            <Button size="lg" className="mt-6 w-full" onClick={() => setGuideOpen(false)}>
              <Check className="size-4" aria-hidden />
              {t("pwa.guide.done")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The ⋮ browser-menu glyph, drawn rather than imported so it reads at this size. */
function MoreGlyph(): React.JSX.Element {
  return (
    <span aria-hidden className="text-2xl font-bold leading-none">
      ⋮
    </span>
  );
}
