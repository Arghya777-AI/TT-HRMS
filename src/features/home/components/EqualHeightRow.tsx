/**
 * EqualHeightRow — a row of cards all exactly as tall as the SHORTEST one, with the
 * rest scrolling inside.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT CSS
 * ─────────────────────────────────────────────────────────────────────────────
 * CSS grid already equalises a row, but always to the TALLEST card — that is what
 * `align-items: stretch` means, and there is no property that says "the shortest".
 * So the shortest card's height has to be measured, and measuring is the whole
 * difficulty: the moment you constrain a card, its height becomes the constraint and
 * "natural height" is gone. Measure, apply, re-measure, and the value collapses.
 *
 * THE WAY OUT is to measure `scrollHeight` of the SCROLL CONTAINER rather than its
 * height. A scroll container's `scrollHeight` is the height of its content, and it does
 * not change when the container's own box is resized. So the measurement is stable under
 * its own effect, and the loop converges on the first pass instead of oscillating.
 *
 * That is also why each card is wrapped rather than modified: the wrapper is the scroll
 * container, the card inside it lays out at its natural height, and `scrollHeight` reads
 * that natural height forever. The cards' own headers are `sticky top-0`, so scrolling a
 * capped card does not scroll its heading away.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO DO
 * ─────────────────────────────────────────────────────────────────────────────
 *   · IT DOES NOT SHRINK BELOW A FLOOR. "As short as the shortest" is right until the
 *     shortest card is nearly empty — a Today card with no punches yet is about 150px,
 *     and honouring that would crush the notification list into a slot showing one and a
 *     half rows. The floor keeps a bad day from making the row useless.
 *   · IT DOES NOT CAP ON A NARROW SCREEN. Below the two-column breakpoint the cards are
 *     stacked, so there is no row to equalise and nothing gained by making a full-width
 *     card scroll inside a page that already scrolls. Two nested scrollbars on a phone is
 *     the worst outcome available here.
 *   · IT DOES NOT TRAP THE CONTENT. `Expand` releases the cap entirely, because a capped
 *     card is a summary and sometimes somebody wants the whole list without a scroll
 *     wheel — which is what was asked for alongside the scrolling.
 */
import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";

/**
 * Never shorter than this, whatever the shortest card says. Enough for a card heading
 * plus roughly three rows of content — below that a scroll container stops being a
 * summary and becomes a peephole.
 */
const MIN_ROW_PX = 300;

/**
 * Never taller than this either. If every card in the row happens to be long, matching
 * the shortest could still mean a row taller than the window, and the point of the
 * exercise was to stop scrolling past one card to reach the next.
 */
const MAX_ROW_VH = 0.72;

/** The two-column breakpoint (Tailwind `sm`). Below it the cards stack. */
const STACK_BELOW_PX = 640;

export interface EqualHeightRowProps {
  /** The cards, as ordinary JSX children — one per column. */
  children: ReactNode;
  /** Grid classes for the row itself. */
  className?: string;
}

export function EqualHeightRow({ children, className }: EqualHeightRowProps) {
  // `toArray` so each card can be given its own scroll container, and so a `false`/`null`
  // child (a card that renders conditionally) does not claim a column.
  const items = Children.toArray(children);
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const [capPx, setCapPx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** True when at least one card has more content than the cap shows. */
  const [overflowing, setOverflowing] = useState(false);

  const register = useCallback((index: number) => (el: HTMLDivElement | null) => {
    boxes.current[index] = el;
  }, []);

  useEffect(() => {
    const measure = () => {
      const els = boxes.current.filter((el): el is HTMLDivElement => el !== null);
      if (els.length === 0) return;

      if (window.innerWidth < STACK_BELOW_PX) {
        // Stacked: no row to equalise. See the header.
        setCapPx(null);
        setOverflowing(false);
        return;
      }

      // `scrollHeight` is the CONTENT height and is unaffected by the cap we are about
      // to apply — that is what makes this stable rather than a feedback loop.
      const natural = els.map((el) => el.scrollHeight);
      const shortest = Math.min(...natural);
      const ceiling = Math.round(window.innerHeight * MAX_ROW_VH);
      const next = Math.min(Math.max(shortest, MIN_ROW_PX), ceiling);

      // Only commit a real change: a sub-pixel difference would re-render forever.
      setCapPx((prev) => (prev === null || Math.abs(prev - next) > 1 ? next : prev));
      setOverflowing(natural.some((h) => h > next + 4));
    };

    measure();

    /*
      OBSERVE THE CARD, NOT THE WRAPPER — and this was a real bug, not a nicety.

      The wrapper is the element whose height this effect FIXES. Once fixed it never
      resizes again, so a ResizeObserver watching it fires once, on the first paint, and
      then never again. The first paint is skeletons: the measured "shortest card" was a
      loading placeholder, the cap stuck at the 300px floor, and it stayed there after the
      real content arrived — every card 300px tall with no Show-everything button, because
      the overflow check had also run against the skeletons.

      The card INSIDE the wrapper is the thing that actually changes size as its query
      resolves. Watching that is what makes the cap follow the real content.
    */
    const observer = new ResizeObserver(measure);
    for (const el of boxes.current) {
      if (el === null) continue;
      const card = el.firstElementChild;
      if (card !== null) observer.observe(card);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [items.length]);

  const capped = capPx !== null && !expanded;

  return (
    <div>
      <div className={cn("grid items-start gap-4", className)}>
        {items.map((child, i) => (
          <div
            // `Children.toArray` has already given each child a stable key of its own;
            // this key is for the wrapper, and the set never reorders.
            key={i}
            ref={register(i)}
            className={cn(
              "min-w-0",
              // The scroll container. `overflow-y-auto` only once a cap is applied, so an
              // uncapped card never shows a scrollbar it does not need.
              capped && "overflow-y-auto rounded-lg",
            )}
            style={capped ? { height: `${capPx}px` } : undefined}
          >
            {child}
          </div>
        ))}
      </div>

      {/*
        Only offered when it would DO something: no button while every card already fits,
        because a control that changes nothing is worse than no control. It is also the
        only hint that a card has more in it than is showing.
      */}
      {overflowing || expanded ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronsDownUp className="mr-2 size-4" aria-hidden />
            ) : (
              <ChevronsUpDown className="mr-2 size-4" aria-hidden />
            )}
            {expanded ? t("home.row.collapse") : t("home.row.expand")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
