/**
 * MasterFormSheet — the ONE form surface behind every lookup-master screen.
 *
 * It is deliberately presentational: the screen owns the values, the errors and
 * the mutation, so there is exactly one place that decides when a reason is
 * asked for and what gets sent.
 *
 * The parts that are not cosmetic:
 *  - Every field carries its `help` line, wired through `aria-describedby`. On
 *    these screens the help IS the product: `grace_in_minutes` means nothing,
 *    "arrive within this many minutes and the day is not late" means everything.
 *  - Derived fields (a shift's paid duration, a location's time zone) render as
 *    read-only values with a "set by the database" badge. They are never sent,
 *    so the DB and the screen cannot disagree about who owns them.
 *  - Field errors sit under their own field; the server's sentence sits above
 *    the buttons. A rejected save never clears the form.
 */
import { useId, type ReactNode } from "react";
import { Info, Lock } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  DOW_OPTIONS,
  weekLabel,
  type FieldErrors,
  type FieldGroup,
  type FieldSpec,
  type FormValues,
} from "../masters/fields";

const WEEK_VALUES = [1, 2, 3, 4, 5] as const;

export interface MasterFormSheetProps {
  open: boolean;
  mode: "create" | "edit";
  /** Singular, lower case: "department", "shift". */
  entityLabel: string;
  /** The row's name when editing — the dialog title reads it back. */
  rowName: string | null;
  groups: readonly FieldGroup[];
  values: FormValues;
  errors: FieldErrors;
  pending: boolean;
  /** Plain-English server rejection from `useAuditedMutation().userMessage`. */
  serverMessage: string | null;
  /** A cross-field problem (threshold order, window order). */
  formError?: string | null;
  /** Display strings for `derived` fields, keyed by column name. */
  derived?: Readonly<Record<string, string>>;
  /** Interpolations for a field's own help line, keyed by column name. */
  helpVars?: Readonly<Record<string, string>>;
  /** True when this admin may read but not write (tier S rows). */
  readOnly?: boolean;
  readOnlyNote?: string;
  /** Rendered above the first group — the "what this screen decides" note. */
  banner?: ReactNode;
  onChange: (name: string, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function MasterFormSheet({
  open,
  mode,
  entityLabel,
  rowName,
  groups,
  values,
  errors,
  pending,
  serverMessage,
  formError,
  derived,
  helpVars,
  readOnly = false,
  readOnlyNote,
  banner,
  onChange,
  onSubmit,
  onClose,
}: MasterFormSheetProps) {
  const idPrefix = useId();

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        <SheetHeader className="border-b p-5 text-left sm:p-6">
          <SheetTitle className="font-display">
            {mode === "create"
              ? t("admin.master.creating", { entity: entityLabel })
              : rowName ?? t("admin.master.editing", { entity: entityLabel })}
          </SheetTitle>
          <SheetDescription>
            {mode === "create"
              ? t("admin.master.new", { entity: entityLabel })
              : t("admin.master.editing", { entity: entityLabel })}
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly) onSubmit();
          }}
        >
          <div className="flex-1 space-y-6 p-5 sm:p-6">
            {banner}
            {readOnly ? (
              <p
                className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                role="status"
              >
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{readOnlyNote ?? t("admin.master.superOnly")}</span>
              </p>
            ) : null}

            {groups.map((group) => (
              <fieldset key={group.title} className="space-y-3" disabled={pending || readOnly}>
                <legend className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </legend>
                {group.hint ? <p className="text-sm text-muted-foreground">{group.hint}</p> : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  {group.fields.map((field) => (
                    <FieldRow
                      key={field.name}
                      idPrefix={idPrefix}
                      field={field}
                      mode={mode}
                      value={values[field.name] ?? ""}
                      error={errors[field.name]}
                      derivedValue={derived?.[field.name]}
                      helpVar={helpVars?.[field.name]}
                      onChange={onChange}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>

          <div className="sticky bottom-0 space-y-3 border-t bg-background p-5 sm:p-6">
            {formError ? (
              <p className="text-sm font-medium text-destructive" role="alert">
                {formError}
              </p>
            ) : null}
            {Object.keys(errors).length > 0 ? (
              <p className="text-sm font-medium text-destructive" role="alert">
                {t("admin.master.err.fix")}
              </p>
            ) : null}
            {serverMessage ? (
              <p className="text-sm font-medium text-destructive" role="alert">
                {serverMessage}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {readOnly ? t("admin.master.close") : t("admin.master.cancel")}
              </Button>
              {readOnly ? null : (
                <Button type="submit" disabled={pending}>
                  {pending ? t("admin.master.saving") : t("admin.master.save")}
                </Button>
              )}
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

interface FieldRowProps {
  idPrefix: string;
  field: FieldSpec;
  mode: "create" | "edit";
  value: string;
  error?: string;
  derivedValue?: string;
  helpVar?: string;
  onChange: (name: string, value: string) => void;
}

function FieldRow({
  idPrefix,
  field,
  mode,
  value,
  error,
  derivedValue,
  helpVar,
  onChange,
}: FieldRowProps) {
  const id = `${idPrefix}-${field.name}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const locked = field.derived === true || (field.createOnly === true && mode === "edit");
  const help = helpVar ?? field.help;
  const describedBy = [help ? helpId : null, error ? errorId : null]
    .filter((x): x is string => x !== null)
    .join(" ");

  const commonProps = {
    id,
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": error !== undefined,
  } as const;

  return (
    <div className={cn("space-y-1.5", (field.wide || field.kind === "textarea") && "sm:col-span-2")}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>
          {field.label}
          {field.required === true ? <span aria-hidden> *</span> : null}
        </Label>
        {field.derived === true ? (
          <span className="text-xs text-muted-foreground">{t("admin.master.derivedBadge")}</span>
        ) : null}
      </div>

      {renderControl(field, value, locked, commonProps, derivedValue, onChange)}

      {help ? (
        <p id={helpId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{help}</span>
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ControlAria {
  readonly id: string;
  readonly "aria-describedby": string | undefined;
  readonly "aria-invalid": boolean;
}

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function renderControl(
  field: FieldSpec,
  value: string,
  locked: boolean,
  aria: ControlAria,
  derivedValue: string | undefined,
  onChange: (name: string, value: string) => void,
): ReactNode {
  if (field.derived === true) {
    return (
      <p
        id={aria.id}
        className="num flex h-10 items-center rounded-md border border-dashed bg-muted/40 px-3 text-sm"
      >
        {derivedValue ?? value ?? "—"}
      </p>
    );
  }

  switch (field.kind) {
    case "textarea":
      return (
        <textarea
          {...aria}
          rows={3}
          value={value}
          disabled={locked}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          onChange={(event) => onChange(field.name, event.target.value)}
          className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      );

    case "checkbox":
      return (
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            {...aria}
            type="checkbox"
            checked={value === "true"}
            disabled={locked}
            onChange={(event) => onChange(field.name, event.target.checked ? "true" : "false")}
            className="h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <span>{value === "true" ? t("admin.master.yes") : t("admin.master.no")}</span>
        </label>
      );

    case "select":
    case "dow": {
      const options = field.kind === "dow" ? DOW_OPTIONS : field.options ?? [];
      return (
        <select
          {...aria}
          value={value}
          disabled={locked}
          onChange={(event) => onChange(field.name, event.target.value)}
          className={SELECT_CLASS}
        >
          {field.required === true && value !== "" ? null : (
            <option value="">{t("admin.master.selectNone")}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    case "weeks": {
      const picked = new Set(value === "" ? [] : value.split(",").map((v) => v.trim()));
      return (
        <div className="flex flex-wrap gap-3" id={aria.id}>
          {WEEK_VALUES.map((week) => {
            const key = String(week);
            return (
              <label key={key} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(key)}
                  disabled={locked}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(key);
                    else next.delete(key);
                    onChange(
                      field.name,
                      [...next].sort((a, b) => Number(a) - Number(b)).join(","),
                    );
                  }}
                  className="h-4 w-4 rounded border-input text-primary"
                />
                <span>{weekLabel(week)}</span>
              </label>
            );
          })}
        </div>
      );
    }

    case "multi": {
      const picked = new Set(value === "" ? [] : value.split(","));
      return (
        <div className="space-y-1.5 rounded-md border p-3" id={aria.id}>
          {(field.options ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
          ) : null}
          {(field.options ?? []).map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.has(option.value)}
                disabled={locked}
                onChange={(event) => {
                  const next = new Set(picked);
                  if (event.target.checked) next.add(option.value);
                  else next.delete(option.value);
                  onChange(field.name, [...next].join(","));
                }}
                className="h-4 w-4 rounded border-input text-primary"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      );
    }

    case "colour":
      return (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={/^#[0-9A-Fa-f]{6}$/.test(value) ? value : "#1F6F4A"}
            disabled={locked}
            aria-label={field.label}
            onChange={(event) => onChange(field.name, event.target.value.toUpperCase())}
            className="h-10 w-12 rounded-md border border-input bg-background"
          />
          <Input
            {...aria}
            value={value}
            disabled={locked}
            placeholder="#1F6F4A"
            onChange={(event) => onChange(field.name, event.target.value)}
            className="num"
          />
        </div>
      );

    default: {
      const type =
        field.kind === "date"
          ? "date"
          : field.kind === "time"
            ? "time"
            : field.kind === "number" || field.kind === "decimal" || field.kind === "rupees"
              ? "number"
              : "text";
      const numeric =
        field.kind === "number" || field.kind === "decimal" || field.kind === "rupees";
      return (
        <Input
          {...aria}
          type={type}
          value={value}
          disabled={locked}
          inputMode={numeric ? "decimal" : undefined}
          step={field.step ?? (field.kind === "decimal" || field.kind === "rupees" ? "any" : undefined)}
          min={field.min}
          max={field.max}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          onChange={(event) =>
            onChange(
              field.name,
              field.kind === "code" ? event.target.value.toUpperCase() : event.target.value,
            )
          }
          className={cn((numeric || field.kind === "code" || field.kind === "time") && "num")}
        />
      );
    }
  }
}
