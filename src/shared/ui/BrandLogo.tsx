/**
 * BrandLogo — the real Tamarind Tree mark, in the three shapes the app needs.
 *
 * WHY THIS EXISTS
 *
 * `public/logo.png` — the gold monogram over "the tamarind tree / live the heritage…" —
 * was in the repository and referenced by NOTHING. Every place the brand appeared drew a
 * terracotta square with the letters "TT" in it instead: the rail, the collapsed rail,
 * and the sign-in page. A placeholder that ships is indistinguishable from a decision.
 *
 * THREE ASSETS, CROPPED FROM THE ONE FILE
 *
 * The source is a single image containing a monogram and two lines of type, so it cannot
 * serve a 32 px square and a sign-in page from the same file — scaled down whole, the
 * wordmark turns to mud. `public/brand/` holds three derivatives cut from it at the ink
 * boundaries (measured, not eyeballed):
 *
 *   logo-mark.png      the monogram alone, squared and padded — for small chrome
 *   logo-lockup.png    monogram + both lines, whitespace trimmed — for the sign-in page
 *   logo-wordmark.png  the two lines without the monogram — for wide, short spaces
 *
 * ALWAYS `alt=""` WITH AN ADJACENT NAME, OR A REAL LABEL — NEVER BOTH. Where the brand
 * name is already beside the mark (the rail), the image is decorative and a screen
 * reader must not hear "The Tamarind Tree" twice; where the mark stands alone (the
 * collapsed rail), it carries the name itself. `decorative` selects which.
 */
import { BRAND } from "@/config/brand";

export type BrandLogoVariant = "mark" | "lockup" | "wordmark";

const SRC: Readonly<Record<BrandLogoVariant, string>> = {
  mark: "/brand/logo-mark.png",
  lockup: "/brand/logo-lockup.png",
  wordmark: "/brand/logo-wordmark.png",
};

export interface BrandLogoProps {
  variant?: BrandLogoVariant;
  /**
   * True when the brand name appears in text next to the mark, so the image adds
   * nothing for a screen reader and is hidden from it.
   */
  decorative?: boolean;
  className?: string;
}

export function BrandLogo({ variant = "mark", decorative = false, className }: BrandLogoProps) {
  return (
    <img
      src={SRC[variant]}
      // The gold is on transparency, so it sits on any surface without a plate behind
      // it. `select-none` because a dragged logo looks like a broken UI.
      className={`select-none object-contain ${className ?? ""}`}
      alt={decorative ? "" : BRAND.tradingName}
      {...(decorative ? { "aria-hidden": true } : {})}
      draggable={false}
      // Eager, not lazy: it is above the fold on every screen that uses it, and a
      // brand mark that fades in after the page reads as a loading fault.
      loading="eager"
      decoding="async"
    />
  );
}
