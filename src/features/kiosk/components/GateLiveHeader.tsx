/**
 * GateLiveHeader — the standing header on a wall-mounted gate terminal.
 *
 * A gate screen is read from two metres away by somebody deciding whether to walk up,
 * and it is on the wall all day with nobody attending it. Two questions have to be
 * answerable at a glance and without touching it:
 *
 *   "Is this thing actually working?"   → the LIVE lamp, and a clock that visibly moves.
 *   "What did it just record me as?"    → the date and day, spelled out, not inferred.
 *
 * ── WHY THE SECONDS MATTER MORE THAN THEY LOOK ───────────────────────────────
 * A clock reading `09:14` is indistinguishable from a frozen screenshot of a clock
 * reading `09:14`. A gate that has silently wedged — camera lost, tab suspended by the
 * OS, network gone — looks exactly like a working one until somebody scans and nothing
 * happens. The ticking second is the cheapest possible liveness signal for the DEVICE
 * itself, which is why it is rendered large and monospaced rather than tucked away.
 *
 * ── WHY THE LAMP IS NOT JUST A COLOUR ────────────────────────────────────────
 * `online` and `offline` are also words, and offline additionally states what will
 * happen ("saved here, will sync"). A green dot on its own tells a colour-blind guard
 * nothing, and tells nobody at all what the machine intends to do about it.
 *
 * The clock is IST via `lib/datetime`, never the tablet's own zone: a gate terminal is
 * a shared device whose timezone nobody owns, and a punch is stamped by the server
 * regardless of what this shows.
 */
import { useEffect, useState } from "react";
import { ScanFace, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate, fmtWeekday, nowInstantIso, nowIstClock } from "@/lib/datetime";

export interface GateLiveHeaderProps {
  deviceName: string;
  /** Present only on an attended gate; hidden entirely when unattended. */
  operatorName?: string;
  /** False once the queue has anything in it, or the network is gone. */
  online: boolean;
  /** How many scans are held on the device awaiting sync. */
  pendingCount?: number;
  /** Rendered on the right — normally the end-shift button, absent when unattended. */
  action?: React.ReactNode;
}

/**
 * One state, one interval, one re-render per second.
 *
 * Date and weekday are recomputed on the same tick rather than on their own timer:
 * a separate daily timer is a second thing to get wrong at midnight, and formatting
 * two extra strings once a second costs nothing measurable.
 */
function useGateNow(): { clock: string; date: string; weekday: string } {
  const build = () => {
    // `nowInstantIso()` rather than `new Date()`: the lint rule bans the constructor for
    // exactly the reason this component cares about — every clock in this product reads
    // IST through lib/datetime, and one raw Date is how a screen quietly starts showing
    // the tablet's own zone. All three formatters take an Instant, and a string is one.
    const now = nowInstantIso();
    return { clock: nowIstClock(now), date: fmtDate(now), weekday: fmtWeekday(now) };
  };
  const [value, setValue] = useState(build);
  useEffect(() => {
    const id = window.setInterval(() => setValue(build()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return value;
}

export function GateLiveHeader({
  deviceName,
  operatorName,
  online,
  pendingCount = 0,
  action,
}: GateLiveHeaderProps): React.JSX.Element {
  const { clock, date, weekday } = useGateNow();

  return (
    <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <ScanFace className="size-6 shrink-0 text-emerald-400" aria-hidden />
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-semibold leading-tight">{deviceName}</p>
          {/* Only an attended gate has a guard to name. */}
          {operatorName !== undefined && operatorName !== "" ? (
            <p className="truncate text-xs text-neutral-400">{operatorName}</p>
          ) : (
            <p className="truncate text-xs text-neutral-500">Unattended gate</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* ── The LIVE lamp ─────────────────────────────────────────────────── */}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wider",
            online
              ? "bg-emerald-500/12 text-emerald-300 ring-1 ring-emerald-500/30"
              : "bg-amber-500/12 text-amber-300 ring-1 ring-amber-500/30",
          )}
          // The whole lamp is one label, so a screen reader hears the state and its
          // consequence together rather than a colour followed by a word.
          aria-label={
            online
              ? "Live — connected to the server"
              : `Offline — ${pendingCount} scan${pendingCount === 1 ? "" : "s"} saved on this device, will sync when the network returns`
          }
        >
          {online ? (
            <>
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              <Wifi className="size-3.5" aria-hidden />
              Live
            </>
          ) : (
            <>
              <span className="inline-flex size-2 rounded-full bg-amber-400" />
              <WifiOff className="size-3.5" aria-hidden />
              Offline
              {pendingCount > 0 ? (
                <span className="tabular-nums font-normal normal-case tracking-normal">
                  · {pendingCount} saved here
                </span>
              ) : null}
            </>
          )}
        </span>

        {/* ── Clock, then the day it belongs to ─────────────────────────────── */}
        <div className="text-right leading-tight">
          <p className="font-mono text-2xl font-semibold tabular-nums text-neutral-50">
            {clock}
            <span className="ml-1 align-baseline text-[11px] font-normal text-neutral-400">IST</span>
          </p>
          <p className="text-[11px] tabular-nums text-neutral-400">
            {weekday} · {date}
          </p>
        </div>

        {action}
      </div>
    </header>
  );
}
