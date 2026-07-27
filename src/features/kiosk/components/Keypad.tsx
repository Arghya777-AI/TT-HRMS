/**
 * Keypad — the guard's PIN, entered with a thumb.
 *
 * A numeric `<input>` would be simpler, but a phone keyboard covers half the
 * screen and its layout changes per device; the guard needs the same four rows
 * every shift. Keys are 64 px tall (comfortably above the 44 px minimum) and the
 * digits never appear on screen — only the count of dots.
 */
import { Delete } from "lucide-react";
import { t } from "@/shared/i18n/en";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"] as const;

export function Keypad({
  onKey,
  onBackspace,
}: {
  onKey: (digit: string) => void;
  onBackspace: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("kiosk.keypad.label")}>
      {KEYS.map((digit, index) =>
        digit === "" ? (
          <span key={`gap-${index}`} aria-hidden />
        ) : (
          <button
            key={digit}
            type="button"
            onClick={() => onKey(digit)}
            className="min-h-16 rounded-xl border border-neutral-700 bg-neutral-900 font-display text-2xl font-semibold text-neutral-50 active:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            {digit}
          </button>
        ),
      )}
      <button
        type="button"
        onClick={onBackspace}
        aria-label={t("kiosk.keypad.backspace")}
        className="min-h-16 rounded-xl border border-neutral-700 bg-neutral-900 active:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        <Delete className="mx-auto size-6" aria-hidden />
      </button>
    </div>
  );
}

/** The PIN, shown as dots. `aria-live` so a screen reader confirms each press. */
export function PinDots({ length }: { length: number }) {
  return (
    <p
      className="num h-9 text-center font-display text-3xl tracking-[0.4em] text-neutral-50"
      aria-live="polite"
      aria-label={t("kiosk.gate.guard.pin")}
    >
      {"•".repeat(length)}
    </p>
  );
}
