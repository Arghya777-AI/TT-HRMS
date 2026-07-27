/**
 * PersonCell — a person in a grid cell: name on its own line, employee code as a
 * separate chip.
 *
 * This exists because of DR-23: the reference product renders
 * `Monisha K[SSSRC018]`, `ARGHYA GHOSH(SSSRC062)` and `Mrunalini-MIDCC001` —
 * three different concatenations of the same two facts. Name and code are never
 * glued into one string here, and names are never CSS-uppercased (DR-14).
 *
 * An unresolved id renders the honest "not on this list" line rather than the
 * uuid — a raw id on screen is the same defect class as a raw enum.
 */
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";

export interface PersonCellProps {
  name: string | null | undefined;
  code: string | null | undefined;
  /** Optional second line, e.g. department · designation. */
  secondary?: string | null;
}

export function PersonCell({ name, code, secondary }: PersonCellProps) {
  if (name == null && code == null) {
    return <span className="text-muted-foreground">{t("admin.common.unknownPerson")}</span>;
  }
  return (
    <span className="flex flex-col leading-tight">
      <span className="font-medium normal-case">{dash(name)}</span>
      <span className="num text-xs text-muted-foreground">{dash(code)}</span>
      {secondary != null && secondary !== "" ? (
        <span className="truncate text-xs text-muted-foreground">{secondary}</span>
      ) : null}
    </span>
  );
}
