/**
 * InstallAppCard — the "get the app" offer, on the phone where it makes sense.
 *
 * WHERE IT LIVES AND WHY. At the top of the mobile "More" sheet. That is the one surface every
 * employee on a phone already opens, it is not on the critical path of any task, and it is not a
 * banner interrupting the home screen — a permanent nag for something you either want once or
 * never is worse than a line in a menu you chose to open.
 *
 * IT SHOWS NOTHING ONCE THE APP IS INSTALLED, and only then. An "Install app" button inside the
 * installed app is the detail that makes software feel abandoned.
 *
 * THERE IS ALWAYS A WAY IN, AND IT NEVER LIES. When the browser has offered a real prompt the
 * card installs directly. Otherwise — iOS Safari, which has no install API at all, and Chrome
 * before `beforeinstallprompt` has fired — it shows the actual steps, quoting the real menu
 * wording. What it never does is render a button that silently does nothing, and it never hides
 * the offer entirely just because the event has not arrived: an employee who opens the menu
 * looking for the app has to find something there.
 */
import { useState } from "react";
import { Download, Share, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { useInstallApp } from "./useInstallApp";

export function InstallAppCard(): React.JSX.Element | null {
  const { mode, isIos, install } = useInstallApp();
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);

  if (mode === "unavailable") return null;

  return (
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

          {mode === "prompt" ? (
            <Button
              size="sm"
              className="mt-2.5"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void install().finally(() => setBusy(false));
              }}
            >
              <Download className="size-4" aria-hidden />
              {t("pwa.install.action")}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="mt-2.5"
                aria-expanded={showSteps}
                onClick={() => setShowSteps((open) => !open)}
              >
                <Share className="size-4" aria-hidden />
                {t("pwa.install.howTo")}
              </Button>
              {showSteps ? (
                <div className="mt-2 rounded-md border bg-background/70 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium">
                      {isIos ? t("pwa.install.iosTitle") : t("pwa.install.otherTitle")}
                    </p>
                    <button
                      type="button"
                      aria-label={t("common.close")}
                      onClick={() => setShowSteps(false)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                  <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                    {(isIos
                      ? ([
                          "pwa.install.ios1",
                          "pwa.install.ios2",
                          "pwa.install.ios3",
                        ] as const)
                      : ([
                          "pwa.install.other1",
                          "pwa.install.other2",
                        ] as const)
                    ).map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
