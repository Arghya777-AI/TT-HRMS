/**
 * contrast.ts — WCAG 2.1 relative-luminance contrast, for the branding screen's
 * checker (spec-admin §15.1).
 *
 * This is presentation maths on two hex strings the admin just typed, not a
 * business figure: there is no server view of "is this colour readable", and the
 * whole point of the checker is to answer before the value is saved. The formula
 * is the published one (WCAG 2.1 §1.4.3) so the number matches any external
 * checker the client runs it past.
 */

export interface ContrastVerdict {
  /** Ratio rounded to one decimal, e.g. 4.6. */
  readonly ratio: number;
  /** ≥ 4.5:1 — usable for body text. */
  readonly passesAA: boolean;
  /** ≥ 3:1 — usable for large text and UI borders only. */
  readonly passesAALarge: boolean;
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** '#CE8F6F' → [206, 143, 111]; null when the string is not a 6-digit hex. */
export function parseHex(hex: string): readonly [number, number, number] | null {
  const match = HEX_RE.exec(hex.trim());
  if (match === null) return null;
  const body = match[1];
  if (body === undefined) return null;
  const int = Number.parseInt(body, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

function channelLuminance(value8Bit: number): number {
  const c = value8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb;
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
}

/** Contrast of two hex colours, or null when either is unparseable. */
export function contrastOf(foreground: string, background: string): ContrastVerdict | null {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (fg === null || bg === null) return null;
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  const raw = (lighter + 0.05) / (darker + 0.05);
  const ratio = Math.round(raw * 10) / 10;
  return { ratio, passesAA: raw >= 4.5, passesAALarge: raw >= 3 };
}
