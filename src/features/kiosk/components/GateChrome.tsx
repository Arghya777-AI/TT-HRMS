/**
 * GateChrome — the shell every gate screen sits in, built for a phone in one hand.
 *
 * Layout contract, because "mobile-first" has to mean something specific:
 *   * `min-h-dvh` with `dvh` (not `vh`), so the browser's collapsing address bar
 *     cannot push the action off the bottom of the screen.
 *   * A single column, nothing wider than the viewport, and every tap target at
 *     least 56 px tall.
 *   * Near-black on white text with saturated 400-level accents: this is read in
 *     daylight at a gate, where a light theme on a phone screen is unreadable.
 *     The gate deliberately does NOT follow the app's theme — it is one fixed,
 *     high-contrast surface.
 *   * `pb-[env(safe-area-inset-bottom)]` so the last row clears the home bar.
 */
import type { ReactNode } from "react";
import { AlertTriangle, ScanFace } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/config/brand";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { useIstClock } from "../hooks/useIstClock";
import type { CameraFailure } from "../lib/camera";

export function IstClock({ className }: { className?: string }) {
  const clock = useIstClock();
  return (
    <p className={cn("num font-display tabular-nums", className)} aria-label={t("kiosk.header.clock")}>
      {clock}
      <span className="ml-1 text-[0.6em] text-neutral-400">IST</span>
    </p>
  );
}

/** The chrome for the two "form" screens (pairing, guard sign-in). */
export function GateFrame({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-neutral-950 text-neutral-50">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <ScanFace className="size-7 shrink-0 text-emerald-400" aria-hidden />
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold leading-tight">
              {BRAND.tradingName}
            </p>
            <p className="truncate text-xs text-neutral-400">{t("kiosk.gate.tagline")}</p>
          </div>
        </div>
        <IstClock className="shrink-0 text-xl" />
      </header>

      <main className="flex flex-1 flex-col gap-5 px-4 py-5">
        <div>
          <h1 className="font-display text-2xl font-semibold leading-tight">{title}</h1>
          {subtitle !== undefined ? (
            <p className="mt-1.5 text-base text-neutral-300">{subtitle}</p>
          ) : null}
        </div>
        {children}
      </main>

      {footer !== undefined ? (
        <footer className="border-t border-neutral-800 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm text-neutral-400">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}

const FAILURE_COPY: Record<CameraFailure, { title: string; hint: string }> = {
  denied: { title: t("kiosk.gate.camera.denied"), hint: t("kiosk.gate.camera.deniedHint") },
  no_camera: { title: t("kiosk.gate.camera.noCamera"), hint: t("kiosk.gate.camera.noCameraHint") },
  in_use: { title: t("kiosk.gate.camera.inUse"), hint: t("kiosk.gate.camera.inUseHint") },
  insecure_context: {
    title: t("kiosk.gate.camera.insecure"),
    hint: t("kiosk.gate.camera.insecureHint"),
  },
  unsupported: {
    title: t("kiosk.gate.camera.unsupported"),
    hint: t("kiosk.gate.camera.unsupportedHint"),
  },
  unavailable: {
    title: t("kiosk.gate.camera.unavailable"),
    hint: t("kiosk.gate.camera.unavailableHint"),
  },
};

/**
 * A camera that will not start, said plainly, with the one action that fixes it.
 * `denied` gets no retry button on purpose: `getUserMedia` will not re-prompt once
 * the permission is remembered, so offering a button that silently fails again is
 * a lie. The instruction is the fix.
 */
export function CameraProblem({
  failure,
  onRetry,
}: {
  failure: CameraFailure;
  onRetry: () => void;
}) {
  const copy = FAILURE_COPY[failure];
  return (
    <div className="rounded-xl border-2 border-red-500/70 bg-red-950/60 p-4" aria-live="polite">
      <p className="flex items-start gap-2 font-display text-lg font-semibold">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-300" aria-hidden />
        {copy.title}
      </p>
      <p className="mt-2 text-base leading-snug text-red-100">{copy.hint}</p>
      {failure === "denied" || failure === "insecure_context" || failure === "unsupported" ? null : (
        <Button
          size="lg"
          variant="outline"
          className="mt-3 min-h-14 w-full border-red-400/60 bg-transparent text-base text-red-50 hover:bg-red-900/50"
          onClick={onRetry}
        >
          {t("kiosk.gate.camera.retry")}
        </Button>
      )}
    </div>
  );
}
