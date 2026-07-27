/**
 * AuditValue — one side of a field change, rendered in the type the field is.
 *
 * The redaction contract matters here and is worth stating: when `is_redacted`
 * is true, `old_value` / `new_value` on the wire are the literal string `***`
 * plus a hash. The browser has never held the real value, so there is nothing
 * for a client-side "reveal" to un-hide — the reveal §13.3 describes is a
 * SERVER round trip (`data_access.audit_value.revealed`). Rendering `•••` here
 * is therefore the truth, not a CSS mask over live data (DR-22: the mask keeps a
 * fixed shape and leaks no magnitude).
 */
import { EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  auditValueKind,
  fmtAuditValue,
  type AuditValueKind,
} from "../display";

export interface AuditValueProps {
  readonly fieldName: string | null;
  readonly value: unknown;
  readonly redacted?: boolean;
  /** `old` renders muted with a strike-through affordance; `new` renders solid. */
  readonly side?: "old" | "new" | "plain";
  readonly className?: string;
}

const NUMERIC_KINDS: ReadonlySet<AuditValueKind> = new Set([
  "money",
  "duration",
  "number",
  "date",
  "instant",
]);

export function AuditValue({
  fieldName,
  value,
  redacted = false,
  side = "plain",
  className,
}: AuditValueProps) {
  if (redacted) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-muted-foreground", className)}
        title={t("adminAudit.value.redactedHint")}
      >
        <EyeOff className="h-3.5 w-3.5" aria-hidden />
        <span className="num tracking-widest">{t("adminAudit.value.redacted")}</span>
      </span>
    );
  }

  const kind = auditValueKind(fieldName, value);
  const text = fmtAuditValue(fieldName, value);

  if (kind === "json") {
    return (
      <pre
        className={cn(
          "max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-relaxed",
          className,
        )}
      >
        {text}
      </pre>
    );
  }

  if (kind === "empty") {
    return (
      <span className={cn("text-muted-foreground", className)}>{t("adminAudit.value.notSet")}</span>
    );
  }

  return (
    <span
      className={cn(
        NUMERIC_KINDS.has(kind) && "num",
        // Long ids (account numbers, UANs, hashes) are monospace, never numeric
        // (frontend-contract §6) — `text` covers them because they are strings.
        kind === "text" && /^[0-9A-Z]{8,}$/.test(text) && "font-mono text-xs",
        side === "old" && "text-muted-foreground",
        side === "new" && "font-medium",
        className,
      )}
    >
      {text}
    </span>
  );
}

/**
 * `old → new` on one line, with the derived delta §13.3 asks for. Used in the
 * timeline grid and in the diff viewer's compact rows.
 */
export function AuditChange({
  fieldName,
  oldValue,
  newValue,
  redacted = false,
  delta,
}: {
  readonly fieldName: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly redacted?: boolean;
  /** Pre-computed by the caller from `moneyDelta` / `dayDelta`. */
  readonly delta?: string | null;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-1.5">
      <AuditValue fieldName={fieldName} value={oldValue} redacted={redacted} side="old" />
      <span className="text-muted-foreground" aria-label={t("adminAudit.diff.becomes")}>
        →
      </span>
      <AuditValue fieldName={fieldName} value={newValue} redacted={redacted} side="new" />
      {delta !== null && delta !== undefined && delta !== "" ? (
        <span className="num rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {delta}
        </span>
      ) : null}
    </span>
  );
}
