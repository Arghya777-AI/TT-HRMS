/**
 * ProgressRing — "how much of this is left", as a ring.
 *
 * For a leave balance, a probation period, an acknowledgement deadline: one
 * number against a total, where the RATIO is the thing being asked about. A
 * number alone answers "how many"; the ring answers "is that a lot", which is
 * the question somebody actually has in front of their leave balance.
 *
 * ── PLAIN SVG, NOT RECHARTS ────────────────────────────────────────────────
 *
 * Recharts is ~90 kB and already loaded on the analytics screens. This is two
 * circles and an arc — pulling a charting library onto the employee's home page
 * to draw them would cost more than everything else on the page put together.
 *
 * ── IT NEVER FILLS PAST FULL ───────────────────────────────────────────────
 *
 * `used` above `total` is clamped for the DRAWING only; the caption still shows
 * the real numbers. An over-drawn ring reads as a rendering bug, while "12 of 10
 * used" reads as the overdraft it is.
 */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "./chartTokens";

export interface ProgressRingProps {
  /** How much is used/taken/elapsed. */
  readonly value: number;
  /** The whole. Zero or absent means there is nothing to be a fraction OF. */
  readonly total: number | null;
  /** Big text inside the ring, already formatted. */
  readonly centre: string;
  /** One line under it. */
  readonly caption: string;
  /** Accessible name for the figure. */
  readonly title: string;
  /** Any CSS colour; defaults to the primary token. */
  readonly color?: string;
  readonly size?: number;
  readonly className?: string;
}

export function ProgressRing({
  value,
  total,
  centre,
  caption,
  title,
  color = "hsl(var(--primary))",
  size = 112,
  className,
}: ProgressRingProps) {
  const titleId = useId();
  const stroke = Math.max(6, Math.round(size * 0.09));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  /*
    No total means no fraction. The ring renders as an empty track rather than a
    full or empty one, both of which would be a claim.
  */
  const fraction =
    total === null || total <= 0 ? 0 : Math.min(1, Math.max(0, value / total));
  const dash = circumference * fraction;

  return (
    <figure
      className={cn("flex flex-col items-center", className)}
      aria-labelledby={titleId}
      role="img"
    >
      <figcaption id={titleId} className="sr-only">
        {title}: {centre} {caption}
      </figcaption>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${String(size)} ${String(size)}`} aria-hidden>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${String(dash)} ${String(circumference - dash)}`}
            /* From twelve o'clock, clockwise — how every dial anybody has read
               since childhood behaves. */
            transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
            style={
              prefersReducedMotion()
                ? undefined
                : { transition: "stroke-dasharray 600ms cubic-bezier(0.22, 1, 0.36, 1)" }
            }
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="num font-display text-xl font-semibold leading-none">{centre}</span>
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">{caption}</p>
    </figure>
  );
}
