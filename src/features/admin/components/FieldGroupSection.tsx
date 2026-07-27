/**
 * FieldGroupSection — renders one `FieldGroup` as a titled two-column block.
 *
 * WHY THIS EXISTS SEPARATELY FROM MasterFormSheet
 * -----------------------------------------------
 * `MasterFormSheet` renders the same field vocabulary, but it keeps its row and
 * control renderers private and it is shaped as a slide-over sheet: it owns its
 * own header, footer and save button. Add Employee is a five-step PAGE, and the
 * Employee 360 is a tabbed page — neither can live inside a sheet. Rather than
 * refactor a screen that twelve working lookup-master pages depend on, this adds
 * the one missing piece: a group renderer with no chrome and no opinion about
 * how it is submitted.
 *
 * It deliberately shares the field VOCABULARY and the coercion/validation path
 * (`../masters/fields`), so a value typed here is coerced exactly as it would be
 * on a master screen — empty box to NULL, checkbox to boolean, date to a plain
 * 'YYYY-MM-DD'. That single coercion path is the point; duplicating it would be
 * how '' ends up in a NOT NULL column.
 */
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { FieldErrors, FieldGroup, FieldSpec, FormValues } from "../masters/fields";
import { SelectField, TextField } from "./Field";

export interface FieldGroupSectionProps {
  group: FieldGroup;
  values: FormValues;
  errors: FieldErrors;
  /** "edit" hides create-only fields, matching coerceValues/validateFields. */
  mode: "create" | "edit";
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
}

function Control({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  // A derived column is the database's to compute; show it, never send it.
  if (field.derived === true) {
    return (
      <div className="min-w-0 space-y-1.5">
        <Label>{field.label}</Label>
        <p className="num rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {value === "" ? "—" : value}
        </p>
        {field.help !== undefined ? (
          <p className="text-xs text-muted-foreground">{field.help}</p>
        ) : null}
      </div>
    );
  }

  if (field.kind === "checkbox") {
    const checked = value === "true";
    return (
      <div className="min-w-0">
        <label className="flex items-start gap-3 rounded-md border bg-card p-3">
          {/* Native input, matching MasterFormSheet — there is no shadcn
              checkbox atom in this project and adding one for a single screen
              would fork the vocabulary. */}
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
            aria-describedby={field.help !== undefined ? `${field.name}-help` : undefined}
            className="mt-0.5 h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <span className="min-w-0 space-y-1">
            <span className="block text-sm font-medium leading-none">{field.label}</span>
            {field.help !== undefined ? (
              <span id={`${field.name}-help`} className="block text-xs text-muted-foreground">
                {field.help}
              </span>
            ) : null}
          </span>
        </label>
        {error !== undefined ? (
          <p className="mt-1 text-xs font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <SelectField
        label={field.label}
        value={value}
        options={field.options ?? []}
        onChange={onChange}
        placeholder={field.required === true ? undefined : "—"}
        disabled={disabled}
        {...(field.required === true ? { required: true } : {})}
        {...(field.help !== undefined ? { hint: field.help } : {})}
        {...(error !== undefined ? { error } : {})}
      />
    );
  }

  const type = field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text";
  return (
    <TextField
      label={field.label}
      value={value}
      onChange={onChange}
      type={type}
      disabled={disabled}
      {...(field.required === true ? { required: true } : {})}
      {...(field.help !== undefined ? { hint: field.help } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
      {...(field.min !== undefined ? { min: String(field.min) } : {})}
      {...(field.max !== undefined ? { max: String(field.max) } : {})}
      {...(field.kind === "number" ? { inputMode: "numeric" as const } : {})}
    />
  );
}

export function FieldGroupSection({
  group,
  values,
  errors,
  mode,
  onChange,
  disabled = false,
}: FieldGroupSectionProps) {
  const fields = group.fields.filter((f) => !(f.createOnly === true && mode === "edit"));
  if (fields.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="font-display text-sm font-semibold">{group.title}</h3>
      {group.hint !== undefined ? (
        <p className="mt-1 text-xs text-muted-foreground">{group.hint}</p>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.name} className={cn(field.wide === true && "sm:col-span-2")}>
            <Control
              field={field}
              value={values[field.name] ?? ""}
              error={errors[field.name]}
              disabled={disabled}
              onChange={(next) => onChange(field.name, next)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
