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
import { ScanFace, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { chimeReady, chimeSupported, isMuted, playChime, primeChime, setMuted } from "@/shared/audio/chime";
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

/**
 * SoundButton — mute toggle, and the thing that unlocks audio on iOS.
 *
 * Two jobs in one control, because they are the same tap.
 *
 * Safari refuses to produce sound until the page has been interacted with, and a wall-mounted
 * gate is interacted with by nobody: the person who walks up is recognised without touching
 * it. So a terminal that was reloaded and then left alone would be permanently, silently mute
 * — and "the sound does not work" is indistinguishable, from across a foyer, from "the sound
 * is off". This button says which, and fixes it: while audio is locked it reads ENABLE SOUND,
 * and tapping it is the gesture that unlocks the context.
 *
 * It plays the confirmation tone on unlock, so whoever tapped it knows it worked without
 * waiting for the next person to arrive.
 */
function SoundButton(): React.JSX.Element | null {
  const [muted, setMutedState] = useState(isMuted);
  const [ready, setReady] = useState(chimeReady);

  /*
    The context can be unlocked by ANY tap on the page — the unlock listeners in `chime.ts`
    are global — so this button's label cannot be driven by its own clicks alone. Polling is
    the honest way to notice: the AudioContext has no state-change event that is reliable
    across Safari versions, and one check a second costs nothing next to a camera loop.
  */
  useEffect(() => {
    const id = window.setInterval(() => setReady(chimeReady()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Nothing to offer on a browser with no Web Audio at all; a dead control is worse than none.
  if (!chimeSupported()) return null;

  const locked = !muted && !ready;

  return (
    <button
      type="button"
      onClick={() => {
        if (muted) {
          setMuted(false);
          setMutedState(false);
          // Unmuting is itself a gesture, so take the chance to unlock as well.
          primeChime();
          playChime("recorded");
          setReady(chimeReady());
          return;
        }
        if (locked) {
          primeChime();
          playChime("recorded");
          setReady(chimeReady());
          return;
        }
        setMuted(true);
        setMutedState(true);
      }}
      aria-label={
        muted
          ? "Sound is off. Turn the attendance chime on."
          : locked
            ? "Tap to enable the attendance chime on this device."
            : "Sound is on. Turn the attendance chime off."
      }
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider",
        locked
          ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40"
          : muted
            ? "bg-neutral-800 text-neutral-400"
            : "bg-neutral-800/70 text-neutral-300",
      )}
    >
      {muted ? (
        <VolumeX className="size-4" aria-hidden />
      ) : (
        <Volume2 className="size-4" aria-hidden />
      )}
      {locked ? "Enable sound" : null}
    </button>
  );
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

        <SoundButton />

        {action}
      </div>
    </header>
  );
}
