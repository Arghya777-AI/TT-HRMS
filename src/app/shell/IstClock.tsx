/**
 * IstClock — the live IST wall clock in the top bar (spec-employee §2).
 * Ticks once a second; formatting is delegated to lib/datetime (the only place
 * allowed to format a date). Server-skew correction hooks in later via the
 * Server-Date header; the offset is applied here so every consumer inherits it.
 */
import { useEffect, useState } from "react";
import { nowIstClock } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";

export function IstClock({ skewMs = 0 }: { skewMs?: number }) {
  const [label, setLabel] = useState(() => nowIstClock(Date.now() + skewMs));

  useEffect(() => {
    const id = window.setInterval(() => setLabel(nowIstClock(Date.now() + skewMs)), 1000);
    return () => window.clearInterval(id);
  }, [skewMs]);

  return (
    <span
      className="hidden items-center gap-1 font-mono text-sm tabular-nums text-muted-foreground sm:inline-flex"
      aria-label={`${label} ${t("shell.topbar.clockSuffix")}`}
    >
      {label}
      <span className="text-xs">{t("shell.topbar.clockSuffix")}</span>
    </span>
  );
}
