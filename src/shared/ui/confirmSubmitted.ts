/**
 * confirmSubmitted — tell the person their form went through, wherever they are looking.
 *
 * ── WHY A TOAST AND NOT THE BANNER ──────────────────────────────────────────
 *
 * Asked for: "when form is submitted across website then show somethings so user
 * will know form is submitted".
 *
 * Every apply form already rendered a success banner — at the TOP of the page,
 * while the button that submits it is at the bottom. On the resignation form that
 * is about a screen and a half apart, so the sequence was: press the button,
 * watch nothing happen, press it again. The banner is not wrong; it is simply
 * somewhere the person is not looking at the moment they need it.
 *
 * A toast appears over the viewport regardless of scroll position, which is the
 * only property that matters here. The banner stays too — it is the durable
 * record with the reference number, and it is still there when the toast has
 * gone.
 *
 * ── WHY IT TAKES A REFERENCE ────────────────────────────────────────────────
 *
 * "Submitted" answers a question nobody has. "Sent — HD-2026-000012" is the thing
 * somebody quotes when they ask about it later, and it is proof that the SERVER
 * minted something rather than that the button was pressed. Where a form has no
 * reference to show, the message says what happens next instead.
 */
import { toast } from "sonner";
import { t } from "@/shared/i18n/en";

export interface SubmittedOptions {
  /** The server-issued number, when there is one. Never invented client-side. */
  readonly reference?: string | null;
  /** One line on what happens next — who it went to. */
  readonly detail?: string;
}

export function confirmSubmitted(title: string, opts: SubmittedOptions = {}): void {
  const reference = opts.reference ?? null;
  const headline =
    reference !== null && reference !== ""
      ? t("form.submitted.withRef", { title, reference })
      : title;
  toast.success(headline, opts.detail !== undefined ? { description: opts.detail } : {});
}
