/**
 * CommsFields — the two controls the `/admin/comms/*` compose surfaces need and
 * `components/Field.tsx` does not have: a multi-line body and a checkbox.
 *
 * They follow Field.tsx's precedent deliberately: a native `<textarea>` and a
 * native `<input type="checkbox">`, label wired with `htmlFor`, hint and error
 * wired through `aria-describedby` + `aria-invalid`. There is no shadcn textarea
 * or checkbox atom in this repo and the frontend contract forbids adding one
 * here, so the platform control — which is keyboard- and screen-reader-correct
 * for free — is what ships.
 *
 * `counter` on the textarea is not decoration: `notification_templates`
 * constrains SMS copy to 160 characters (`ck_notification_templates__sms_length`,
 * the TRAI/DLT registered-copy rule) and an admin must see the limit while
 * typing rather than discover it as a rejected save.
 */
import { useId } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  /** Rendered under the field as "n / max" once a max is given. */
  maxLength?: number;
  className?: string;
  /** Monospace body — for template copy with `{{tokens}}` in it. */
  mono?: boolean;
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required = false,
  disabled = false,
  rows = 5,
  placeholder,
  maxLength,
  className,
  mono = false,
}: TextAreaFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const countId = `${id}-count`;
  const hasError = error != null && error !== "";
  const hasHint = hint != null && hint !== "";
  const described = [hasHint ? hintId : null, hasError ? errorId : null, maxLength !== undefined ? countId : null]
    .filter((v): v is string => v !== null)
    .join(" ");

  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        disabled={disabled}
        aria-invalid={hasError}
        {...(described !== "" ? { "aria-describedby": described } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
          "ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          mono && "font-mono text-xs leading-relaxed",
          hasError && "border-destructive",
        )}
      />
      {maxLength !== undefined ? (
        <p
          id={countId}
          className={cn(
            "num text-xs",
            value.length > maxLength ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {value.length} / {maxLength}
        </p>
      ) : null}
      {hasHint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
  className,
}: CheckboxFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hasHint = hint != null && hint !== "";
  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        {...(hasHint ? { "aria-describedby": hintId } : {})}
        onChange={(event) => onChange(event.target.checked)}
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0 rounded border-input text-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
      <div className="min-w-0">
        <Label htmlFor={id} className="leading-snug">
          {label}
        </Label>
        {hasHint ? (
          <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
