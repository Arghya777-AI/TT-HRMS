/**
 * AnalyticsCaveats — everything the data layer discovered while answering the
 * question, printed under the answer.
 *
 * `AnalyticsProvenance.caveats` is a list of i18n KEYS, deliberately: the api
 * module knows that a department id resolved to a name, that a row set hit its
 * cap, that the punch-source filter cannot reach the day grain — and it must not
 * also own the sentence. This component owns the sentence, and it is the only
 * place the three interpolated caveats get their values, so a screen cannot print
 * the location's name inside the department's warning.
 *
 * The closing line is not decoration either. The repo rule is that a displayed
 * number is traceable; these figures were added up IN THIS BROWSER from day
 * records the database computed, and the reader is told which of the two they are
 * looking at.
 */
import { formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice, type NoticeTone } from "./Notice";
import type { AnalyticsProvenance } from "../api/analytics.api";

/**
 * Keyed by string rather than `MessageKey`: a mapped type over the whole
 * catalogue (10k keys) is a real cost to typecheck for a five-entry lookup.
 * Anything unlisted reads as information rather than a warning.
 */
const CAVEAT_TONE: Readonly<Record<string, NoticeTone>> = {
  "analytics.caveat.truncated": "warning",
  "analytics.caveat.departmentUnknown": "warning",
  "analytics.caveat.locationUnknown": "warning",
  "analytics.caveat.departmentAmbiguous": "warning",
  "analytics.caveat.locationAmbiguous": "warning",
};

export interface AnalyticsCaveatsProps {
  readonly provenance: AnalyticsProvenance;
  /** The name the department id resolved to — the `{name}` in its caveat. */
  readonly departmentName?: string | null;
  readonly locationName?: string | null;
  readonly className?: string;
}

export function AnalyticsCaveats({
  provenance,
  departmentName,
  locationName,
  className,
}: AnalyticsCaveatsProps) {
  function sentence(key: MessageKey): string {
    switch (key) {
      case "analytics.caveat.truncated":
        return t(key, { cap: formatNumber(provenance.rowCap) });
      case "analytics.caveat.departmentAmbiguous":
        return t(key, { name: departmentName ?? "" });
      case "analytics.caveat.locationAmbiguous":
        return t(key, { name: locationName ?? "" });
      default:
        return t(key);
    }
  }

  return (
    <div className={className}>
      <div className="space-y-2">
        {provenance.caveats.map((key) => (
          <Notice key={key} tone={CAVEAT_TONE[key] ?? "info"}>
            {sentence(key)}
          </Notice>
        ))}
        <Notice tone="info">
          {provenance.computedBy === "server"
            ? t("analytics.provenance.serverCounted")
            : t("analytics.provenance.clientAggregated", {
                rows: formatNumber(provenance.rowsScanned),
              })}
        </Notice>
      </div>
    </div>
  );
}
