/**
 * StatusMixCard — the shape of a register, in one bar, in a card.
 *
 * Nearly every admin screen in this product is a filtered list above a row of
 * server counts: assets by state, notifications by delivery outcome, statutory
 * lines by head. The counts say how many are in each bucket. None of them says
 * the thing a person opening the screen wants first — which bucket dominates, and
 * whether the bad one is small or large.
 *
 * This is that bar, plus the card around it, so thirty screens do not each grow
 * their own heading, hint line, spacing and empty-state rule.
 *
 * ── THE ONE RULE A CALLER MUST HONOUR ───────────────────────────────────────
 *
 * THE SEGMENTS MUST BE DISJOINT. A stacked bar claims its parts add up to the
 * whole, and every share printed beside it is computed on that basis. Handing it
 * overlapping buckets — "pending" and "sensitive pending", "open" and "escalated"
 * — double-counts the rows in both, and then every percentage on the card is
 * wrong while looking authoritative.
 *
 * Overlap cannot be detected from a list of numbers, so it cannot be checked
 * here. What this component can do, and does, is refuse to draw at all until
 * every count has arrived: a bar assembled from three loaded counts and one
 * `undefined` treated as zero is a picture of a loading state, not of a register.
 */
import { SplitBar, type SplitSegment } from "./SplitBar";

export interface StatusMixSegment {
  readonly key: string;
  readonly label: string;
  /**
   * The server's count. `undefined` while its query is in flight — the card waits
   * rather than reading it as zero.
   */
  readonly value: number | undefined;
  readonly tone: SplitSegment["tone"];
}

export interface StatusMixCardProps {
  readonly title: string;
  /** One line saying what the reader is looking at, and what it is for. */
  readonly hint?: string;
  readonly segments: readonly StatusMixSegment[];
  /**
   * A line under the legend naming the whole. Called with the summed total, so
   * the caller words it ("42 assets on the register") without adding up twice.
   */
  readonly totalCaption?: (total: number) => string;
  readonly format?: (value: number) => string;
  readonly className?: string;
}

export function StatusMixCard({
  title,
  hint,
  segments,
  totalCaption,
  format = (v) => String(v),
  className,
}: StatusMixCardProps) {
  /*
    Every count, or nothing. See the header: a partial bar is a picture of the
    network, and it would settle into a different shape a moment later — which
    reads as the data having changed.
  */
  if (segments.some((s) => s.value === undefined)) return null;

  const resolved: SplitSegment[] = segments.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.value ?? 0,
    tone: s.tone,
  }));
  const total = resolved.reduce((sum, s) => sum + s.value, 0);

  /* An empty register has no shape. A card saying "0, 0, 0" over an empty grey
     track is furniture; the list's own empty state already says it better. */
  if (total === 0) return null;

  return (
    <section className={className ?? "rounded-lg border bg-card p-4"}>
      <h2 className="font-display text-sm font-semibold">{title}</h2>
      {hint === undefined ? null : (
        <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{hint}</p>
      )}
      <SplitBar
        title={title}
        segments={resolved}
        showShare
        height={12}
        format={format}
        {...(totalCaption === undefined ? {} : { totalCaption: totalCaption(total) })}
      />
    </section>
  );
}
