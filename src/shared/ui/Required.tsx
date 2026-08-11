/**
 * Required — the star beside a field that genuinely has to be filled in.
 *
 * ASKED FOR: "if somethings is mandatory then star mark it..." — and in the same
 * breath, that the cover field must NOT be mandatory. Those two go together: a
 * star is only worth anything if it appears on exactly the fields that will stop
 * a submission, and nowhere else.
 *
 * So the rule for using this: put it on a field that appears in that form's
 * `blockers` list, and nowhere else. A starred field that submits fine teaches
 * people to ignore stars; an unstarred field that refuses teaches them the form
 * cannot be trusted.
 *
 * The `*` is `aria-hidden` with a visually-hidden word beside it, because a screen
 * reader announcing "asterisk" tells nobody anything. The input itself should also
 * carry `required` or `aria-required` — this is the visual half.
 */
import { t } from "@/shared/i18n/en";

export function Required() {
  return (
    <>
      <span aria-hidden className="ml-0.5 text-destructive">
        *
      </span>
      <span className="sr-only"> {t("form.required")}</span>
    </>
  );
}
