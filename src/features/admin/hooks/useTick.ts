/**
 * useTick — a one-second clock, running only while something needs it.
 *
 * Extracted from `BucketDrillDown`, which had the only copy. A second copy in the roster would
 * be two answers to "what time is it" on one screen, and they would drift apart the first time
 * one of them grew a condition the other did not.
 *
 * `anyRunning` is what keeps it honest: a timer that keeps firing after everybody has scanned
 * out re-renders a table every second forever for no visible change. `nowEpochMs()` is read here
 * rather than inside the pure `elapsedOnSite`, which is what keeps that function testable
 * without waiting for real seconds to pass.
 */
import { useEffect, useState } from "react";
import { nowEpochMs } from "@/lib/datetime";

export function useTick(anyRunning: boolean): number {
  const [nowMs, setNowMs] = useState<number>(nowEpochMs);
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => setNowMs(nowEpochMs()), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);
  return nowMs;
}
