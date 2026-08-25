/**
 * LocalLogSheet — what this device is holding, and what it has already handed over.
 *
 * ── WHY A GATE NEEDS THIS ────────────────────────────────────────────────────
 * During an outage the terminal is the only place a morning's attendance exists. Until now it
 * reported that as a number — "3 saved here" — and nothing more. Nobody could see WHICH scans
 * were held, whether they had cleared, or when. A venue is being asked to trust that a tablet
 * will hand over records it cannot show, and "it synced" is not something anybody should have
 * to take on faith.
 *
 * So: two lists, in one sheet.
 *
 *   WAITING   every scan still on the device, oldest first, with the time it was captured and
 *             how many times it has been tried. Parked items are called out, because they are
 *             the ones that need a person.
 *   SENT      the sync history — what reached the server and WHEN it did, newest first. This is
 *             the audit trail: it survives the queue entry being deleted, which is the moment
 *             the evidence used to disappear.
 *
 * ── WHAT IT DELIBERATELY DOES NOT SHOW ───────────────────────────────────────
 * No descriptors and no photographs. The names shown are the DEVICE's own offline guesses,
 * labelled as such — the server re-matches on replay, so a name here is what the terminal
 * thought at the time, not what the record says. Presenting it as authoritative would make this
 * screen a second, disagreeing source of truth.
 *
 * A gate is a public screen, so this is behind a deliberate tap rather than on the wall.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { t } from "@/shared/i18n/en";
import { fmtDate, nowInstantIso, nowIstClock } from "@/lib/datetime";
import {
  MAX_ATTEMPTS,
  allQueued,
  syncedPunches,
  type QueuedPunch,
  type SyncedPunch,
} from "../lib/punchQueue";

/** IST clock for an instant, with the date only when it is not today. */
function stamp(iso: string, today: string): string {
  const date = fmtDate(iso);
  const clock = nowIstClock(iso);
  return date === today ? clock : `${date} ${clock}`;
}

export interface LocalLogSheetProps {
  /** True while a flush is in flight, so the sheet can show it live. */
  syncing: boolean;
  onClose: () => void;
  /** Ask the caller to flush now — the button people will press first. */
  onSyncNow: () => void;
}

export function LocalLogSheet({
  syncing,
  onClose,
  onSyncNow,
}: LocalLogSheetProps): React.JSX.Element {
  const [waiting, setWaiting] = useState<QueuedPunch[] | null>(null);
  const [sent, setSent] = useState<SyncedPunch[] | null>(null);
  // `nowInstantIso()` rather than the Date constructor: every clock in this product reads
  // IST through lib/datetime, and the lint rule bans the constructor for exactly that reason.
  const today = fmtDate(nowInstantIso());

  const load = useCallback(() => {
    void allQueued().then(setWaiting).catch(() => setWaiting([]));
    void syncedPunches(100).then(setSent).catch(() => setSent([]));
  }, []);

  useEffect(() => {
    load();
    /*
      Re-read while a flush is running, so somebody watching the sheet sees the waiting list
      shrink rather than a frozen snapshot. Two seconds is slow enough to cost nothing and fast
      enough to look live.
    */
    const timer = window.setInterval(load, 2_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const parked = (waiting ?? []).filter((w) => w.parked === true);
  const pending = (waiting ?? []).filter((w) => w.parked !== true);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-neutral-950/97 backdrop-blur">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-neutral-50">
            {t("kiosk.gate.log.title")}
          </h2>
          <p className="text-xs text-neutral-400">{t("kiosk.gate.log.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onSyncNow}
            disabled={syncing || pending.length === 0}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-4" aria-hidden />
            )}
            {syncing ? t("kiosk.gate.log.syncing") : t("kiosk.gate.log.syncNow")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("kiosk.gate.log.close")}
            className="min-h-11 rounded-lg px-3 py-2 text-neutral-400 hover:text-neutral-100"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* ── Waiting ──────────────────────────────────────────────────────── */}
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {t("kiosk.gate.log.waitingHeading", { count: String(pending.length) })}
        </h3>
        {waiting === null ? (
          <p className="text-sm text-neutral-500">{t("kiosk.gate.log.reading")}</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("kiosk.gate.log.nothingWaiting")}</p>
        ) : (
          <ul className="mb-4 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {pending.map((item) => (
              <li key={item.clientEventId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm text-neutral-200">
                  {item.localName ?? t("kiosk.gate.log.unnamed")}
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums text-neutral-400">
                  {stamp(item.capturedAt, today)}
                  {item.attempts > 0 ? (
                    <span className="ml-2 text-amber-400">
                      {t("kiosk.gate.log.attempts", {
                        n: String(item.attempts),
                        max: String(MAX_ATTEMPTS),
                      })}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* ── Parked: the ones that need a person ──────────────────────────── */}
        {parked.length > 0 ? (
          <>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-400">
              {t("kiosk.gate.log.parkedHeading", { count: String(parked.length) })}
            </h3>
            <ul className="mb-4 divide-y divide-amber-900/40 rounded-lg border border-amber-900/40">
              {parked.map((item) => (
                <li key={item.clientEventId} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-neutral-200">
                      {item.localName ?? t("kiosk.gate.log.unnamed")}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                      {stamp(item.capturedAt, today)}
                    </span>
                  </div>
                  {/* The server's own reason, verbatim — this is the one place it is readable. */}
                  {item.lastError !== undefined ? (
                    <p className="mt-0.5 text-[11px] text-amber-300">{item.lastError}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {/* ── Sent ─────────────────────────────────────────────────────────── */}
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          {t("kiosk.gate.log.sentHeading")}
        </h3>
        {sent === null ? (
          <p className="text-sm text-neutral-500">{t("kiosk.gate.log.reading")}</p>
        ) : sent.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("kiosk.gate.log.nothingSent")}</p>
        ) : (
          <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
            {sent.map((item) => (
              <li key={item.clientEventId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-sm text-neutral-300">
                  {item.localName ?? t("kiosk.gate.log.unnamed")}
                </span>
                {/* Both instants, because the GAP is the interesting number during an outage. */}
                <span className="shrink-0 text-right text-xs tabular-nums text-neutral-500">
                  {t("kiosk.gate.log.capturedSynced", {
                    captured: stamp(item.capturedAt, today),
                    synced: stamp(item.syncedAt, today),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-[11px] leading-snug text-neutral-500">
          {t("kiosk.gate.log.footnote")}
        </p>
      </div>
    </div>
  );
}
