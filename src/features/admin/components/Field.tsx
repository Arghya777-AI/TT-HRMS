/**
 * Field.tsx — the three form/filter controls the admin leave & payroll screens
 * need, with label, hint, and a field-level error slot wired to `aria-invalid` +
 * `aria-describedby`.
 *
 * There is no `components/ui/select.tsx` in this repo (only button/input/label/
 * table/tabs/…), and DataGrid's own page-size control is a plain styled
 * `<select>`. These follow that precedent rather than pulling in a new primitive:
 * a native select is keyboard- and screen-reader-correct for free, and at 360px
 * it opens the platform picker instead of a cramped popover.
 */
import { useId, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface BaseProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

function Frame({
  label,
  hint,
  error,
  required,
  id,
  hintId,
  errorId,
  children,
  className,
}: BaseProps & {
  id: string;
  hintId: string;
  errorId: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required === true ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {hint != null && hint !== "" ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error != null && error !== "" ? (
        <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends BaseProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Leading option shown when nothing is chosen yet. */
  placeholder?: string;
}

export function SelectField({
  value,
  options,
  onChange,
  placeholder,
  ...base
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [base.hint ? hintId : null, base.error ? errorId : null]
    .filter((v): v is string => v !== null)
    .join(" ");
  return (
    <Frame {...base} id={id} hintId={hintId} errorId={errorId}>
      <select
        id={id}
        value={value}
        disabled={base.disabled ?? false}
        aria-invalid={base.error != null && base.error !== ""}
        {...(described !== "" ? { "aria-describedby": described } : {})}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          CONTROL_CLASS,
          base.error != null && base.error !== "" && "border-destructive",
        )}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export interface TextFieldProps extends BaseProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date" | "number";
  placeholder?: string;
  inputMode?: "text" | "decimal" | "numeric";
  min?: string;
  max?: string;
  step?: string;
}

export function TextField({
  value,
  onChange,
  type = "text",
  placeholder,
  inputMode,
  min,
  max,
  step,
  ...base
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [base.hint ? hintId : null, base.error ? errorId : null]
    .filter((v): v is string => v !== null)
    .join(" ");
  return (
    <Frame {...base} id={id} hintId={hintId} errorId={errorId}>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={base.disabled ?? false}
        aria-invalid={base.error != null && base.error !== ""}
        {...(described !== "" ? { "aria-describedby": described } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(inputMode !== undefined ? { inputMode } : {})}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        onChange={(event) => onChange(event.target.value)}
        className={cn(base.error != null && base.error !== "" && "border-destructive")}
      />
    </Frame>
  );
}
