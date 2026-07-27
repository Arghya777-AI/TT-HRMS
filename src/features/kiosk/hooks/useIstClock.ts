/**
 * The gate clock. IST always, and from `src/lib/datetime.ts` only — the tablet's
 * own zone is never trusted for anything a human reads, and `punched_at` is the
 * server's `now()` regardless of what this shows.
 */
import { useEffect, useState } from "react";
import { nowIstClock } from "@/lib/datetime";

export function useIstClock(): string {
  const [clock, setClock] = useState(() => nowIstClock());
  useEffect(() => {
    const id = window.setInterval(() => setClock(nowIstClock()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return clock;
}
