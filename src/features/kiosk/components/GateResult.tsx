/**
 * GateResult — the card that has to be unmistakable from two metres away, and the
 * short tail of recent scans under it.
 *
 * The whole verdict is FOUR things and nothing else: the name, the employee code,
 * IN or OUT, and the IST time. That is exactly what `kiosk-punch` is allowed to
 * return (its §11 allow-list), so the card cannot grow into an HR screen even by
 * accident — there is no other field to show.
 *
 * IN and OUT are decided by the SERVER from the ordinal of the punch in the
 * business day (first = in, last = out); this component only prints the word it
 * was given. It never guesses.
 */
import { ArrowDownLeft, ArrowUpRight, CircleSlash, Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { PunchOutcome } from "../lib/deviceAuth";

export type BannerTone = "idle" | "busy" | "warn" | "bad" | "good";

const TONE_CLASS: Record<BannerTone, string> = {
  idle: "border-neutral-600 bg-neutral-950/85",
  busy: "border-sky-400/70 bg-sky-950/80",
  warn: "border-amber-400/80 bg-amber-950/85",
  bad: "border-red-500/80 bg-red-950/85",
  good: "border-emerald-400 bg-emerald-950/90",
};

/** The prompt/guidance banner: one big line, one small line. */
export function GateBanner({
  tone,
  big,
  small,
}: {
  tone: BannerTone;
  big: string;
  small: string | null;
}) {
  return (
    <div
      className={cn("rounded-2xl border-2 p-4 text-center backdrop-blur-md", TONE_CLASS[tone])}
      aria-live="polite"
    >
      <p className="font-display text-2xl font-semibold leading-tight sm:text-3xl">{big}</p>
      {small !== null ? (
        <p className="mt-1.5 text-base leading-snug text-neutral-200">{small}</p>
      ) : null}
    </div>
  );
}

function kindWord(punchKind: string | undefined): string {
  if (punchKind === "out") return t("kiosk.gate.scan.kindOut");
  if (punchKind === "in") return t("kiosk.gate.scan.kindIn");
  return t("kiosk.gate.scan.kindScan");
}

/** The accepted-punch card. Name first, because that is what the guard checks. */
export function GateResultCard({ outcome }: { outcome: PunchOutcome }) {
  const out = outcome.punchKind === "out";
  const Icon = outcome.punchKind === "out"
    ? ArrowUpRight
    : outcome.punchKind === "in"
    ? ArrowDownLeft
    : Clock3;
  return (
    <div
      className={cn(
        "rounded-2xl border-2 p-4 backdrop-blur-md",
        out ? "border-sky-300 bg-sky-950/90" : "border-emerald-400 bg-emerald-950/90",
      )}
      aria-live="assertive"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display text-3xl font-bold leading-tight sm:text-4xl">
            {outcome.displayName ?? ""}
          </p>
          <p className="num mt-1 text-lg text-neutral-200">
            {t("kiosk.gate.scan.codeAt", {
              code: outcome.employeeCode ?? "",
              time: outcome.istTime ?? "",
            })}
          </p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 font-display text-2xl font-bold",
            out ? "bg-sky-400 text-sky-950" : "bg-emerald-400 text-emerald-950",
          )}
        >
          <Icon className="size-6" aria-hidden />
          {kindWord(outcome.punchKind)}
        </span>
      </div>
      <p className="mt-2 text-sm text-neutral-300">{t("kiosk.gate.scan.next")}</p>
    </div>
  );
}

/** One accepted scan, kept in memory for the guard's own confidence. */
export interface RecentScan {
  id: string;
  displayName: string;
  employeeCode: string;
  punchKind: string;
  istTime: string;
}

/**
 * The tail. Five rows, in memory only — a gate device holds no HR records, so
 * this is never written to storage and dies with the page (the note under it says
 * exactly that, because a guard who does not know that will assume otherwise).
 */
export function RecentScans({ scans }: { scans: readonly RecentScan[] }) {
  return (
    <section aria-label={t("kiosk.gate.recent.title")} className="space-y-1.5">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {t("kiosk.gate.recent.title")}
      </h2>
      {scans.length === 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-400">
          <CircleSlash className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("kiosk.gate.recent.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/60">
          {scans.map((scan) => (
            <li key={scan.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate text-base text-neutral-100">{scan.displayName}</span>
              <span className="num flex shrink-0 items-center gap-2 text-sm text-neutral-300">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-bold",
                    scan.punchKind === "out"
                      ? "bg-sky-400/20 text-sky-200"
                      : "bg-emerald-400/20 text-emerald-200",
                  )}
                >
                  {kindWord(scan.punchKind)}
                </span>
                {scan.istTime}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="px-1 text-xs leading-snug text-neutral-500">{t("kiosk.gate.recent.note")}</p>
    </section>
  );
}
