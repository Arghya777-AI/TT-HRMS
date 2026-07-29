/**
 * RichText — the assistant's narrative, with its markdown-lite actually rendered.
 *
 * WHY IT EXISTS. The spec tells the model the narrative is "markdown-lite (**bold**,
 * *italic*, `code`)" and the screen rendered it as plain text, so answers arrived reading
 *
 *     only **1** person has clocked in today across the venue's **13** departments
 *
 * with the asterisks visible. The emphasis was landing on exactly the figures worth
 * emphasising, and showing them as punctuation made the product look unfinished.
 *
 * WHY NOT A MARKDOWN LIBRARY. This is model output. A general renderer accepts links,
 * images and raw HTML, and the narrative passes through `stripInjection` on the server but
 * is still the least trusted string on the page — the one place where an instruction
 * embedded in employee-authored data could surface. So this parses three inline forms and
 * nothing else, and produces React elements rather than HTML: there is no
 * `dangerouslySetInnerHTML` here, so there is no injection surface at all. Anything it does
 * not recognise stays literal text, which is the safe direction to fail.
 *
 * BLOCK STRUCTURE IS NOT SUPPORTED, deliberately. No headings, no lists, no tables — the
 * narrative is prose (≤900 characters) and the blocks beside it are where structure
 * belongs. Newlines are preserved, which is all the layout it needs.
 */
import { Fragment, type ReactNode } from "react";

/** `**bold**`, `*italic*`, `` `code` `` — in that order, so `**` is not read as two `*`. */
const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((piece, i) => {
    const key = `${keyPrefix}-${i}`;
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      // `font-semibold`, not `font-bold`: the narrative sits beside display-font headings
      // and full bold competes with them.
      return <strong key={key} className="font-semibold">{piece.slice(2, -2)}</strong>;
    }
    if (piece.startsWith("*") && piece.endsWith("*") && piece.length > 2) {
      return <em key={key}>{piece.slice(1, -1)}</em>;
    }
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
          {piece.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{piece}</Fragment>;
  });
}

export interface RichTextProps {
  readonly text: string;
  readonly className?: string;
}

export function RichText({ text, className }: RichTextProps) {
  // Newlines preserved as real breaks rather than by `whitespace-pre-wrap`, so a wrapped
  // line does not inherit the leading indentation of the source string.
  const lines = text.split("\n");
  return (
    <p className={className}>
      {lines.map((line, i) => (
        <Fragment key={`l-${i}`}>
          {i > 0 ? <br /> : null}
          {renderInline(line, `l${i}`)}
        </Fragment>
      ))}
    </p>
  );
}
