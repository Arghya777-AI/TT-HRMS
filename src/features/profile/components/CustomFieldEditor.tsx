/**
 * CustomFieldEditor.tsx — ONE row of /me/profile/custom, in whichever of its
 * three shapes the definition dictates.
 *
 * Why a component per row rather than a loop in the page: each row needs its own
 * draft, its own error slot and its own in-flight flag, and hooks may not run
 * inside a loop. Extracting the row is the only correct way to give fifteen
 * fields fifteen independent save buttons.
 *
 * The control is chosen from `field_type`, never from the value: a
 * `single_select` is a select over its own `options` (so the employee cannot
 * type a value `trg_ecfv__validate` would reject), a `boolean` is a switch, a
 * `date` is a date input and a `number` is numeric. `text` with a
 * `validation_regex` says so before the save, not after.
 *
 * Local state is the RAW control value, not a parsed draft: "" in a number box
 * is a real intermediate state an employee passes through while retyping, and a
 * parsed-only model has to represent it as something it is not. Parsing happens
 * once, at submit, and produces either a draft or a problem.
 *
 * PII is shown, not hidden. `is_pii` restricts who ELSE may read the value — the
 * `v_team_*` views drop it from a manager's view — and the employee reading
 * their own blood group is the case the flag exists to protect, not to block.
 */
import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/admin/components/Notice";
import { SelectField, TextField } from "@/features/admin/components/Field";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isQueryErrorOfKind, mutationUserMessage } from "@/shared/api/query";
import { isRuleRejection } from "@/shared/api/write";
import { t } from "@/shared/i18n/en";
import { AuthorityBadge } from "./AuthorityBadge";
import {
  customFieldOptions,
  draftFromValue,
  draftKindFor,
  validateCustomFieldDraft,
  type CustomFieldDraft,
  type CustomFieldDraftProblem,
  type CustomFieldRow,
} from "../api/custom-fields.api";
import {
  useRequestCustomFieldChange,
  useSaveCustomFieldValue,
  type CustomFieldRequestState,
} from "../hooks/useCustomFieldEdit";

// -----------------------------------------------------------------------------
// Rendering a stored value
// -----------------------------------------------------------------------------

/**
 * The saved value as text — the read-only branch's whole output, and the one
 * place the six typed columns collapse into a string. Deliberately NOT exported:
 * one renderer, one file, so a second copy cannot drift.
 */
function renderCustomValue(row: CustomFieldRow): string {
  const v = row.value;
  if (v === null) return dash(null);
  if (v.value_text !== null) return v.value_text;
  if (v.value_number !== null) return formatNumber(v.value_number);
  if (v.value_date !== null) return fmtCivilDate(v.value_date);
  if (v.value_boolean !== null)
    return v.value_boolean ? t("profile.custom.yes") : t("profile.custom.no");
  if (v.value_json !== null) return t("profile.custom.employeeRef");
  if (v.value_document_id !== null) return t("profile.custom.fileAttached");
  return dash(null);
}

/** A change request's jsonb `new_value` as text, without trusting its shape. */
function renderJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? t("profile.custom.yes") : t("profile.custom.no");
  return dash(null);
}

function problemMessage(problem: CustomFieldDraftProblem): string {
  switch (problem.code) {
    case "empty":
      return t("profile.customEdit.error.empty");
    case "number":
      return t("profile.customEdit.error.number");
    case "min":
      return t("profile.customEdit.error.min", { min: formatNumber(problem.min) });
    case "max":
      return t("profile.customEdit.error.max", { max: formatNumber(problem.max) });
    case "date":
      return t("profile.customEdit.error.date");
    case "option":
      return t("profile.customEdit.error.option");
    case "pattern":
      return t("profile.customEdit.error.pattern");
  }
}

/** The notes under the control: what HR set, and who else may read it. */
function fieldHints(row: CustomFieldRow): string[] {
  const { def, authority } = row;
  const hints: string[] = [];
  if (def.help_text !== null && def.help_text.trim() !== "") hints.push(def.help_text);
  if (def.is_required) hints.push(t("profile.customEdit.hint.required"));
  if (def.field_type === "number") {
    if (def.min_value !== null && def.max_value !== null) {
      hints.push(
        t("profile.customEdit.hint.range", {
          min: formatNumber(def.min_value),
          max: formatNumber(def.max_value),
        }),
      );
    } else if (def.min_value !== null) {
      hints.push(t("profile.customEdit.hint.min", { min: formatNumber(def.min_value) }));
    } else if (def.max_value !== null) {
      hints.push(t("profile.customEdit.hint.max", { max: formatNumber(def.max_value) }));
    }
  }
  if (authority === "self") hints.push(t("profile.customEdit.hint.self"));
  if (authority === "maker_checker") hints.push(t("profile.customEdit.hint.approval"));
  if (authority === "admin_only") hints.push(t("profile.customEdit.hint.adminOnly"));
  if (def.is_pii) hints.push(t("profile.customEdit.hint.pii"));
  return hints;
}

/** Why a field an employee "may edit" still has no control on this screen. */
function unsupportedReason(row: CustomFieldRow): string | null {
  switch (row.def.field_type) {
    case "multi_select":
      return t("profile.customEdit.unsupported.multiSelect");
    case "employee_ref":
      return t("profile.customEdit.unsupported.employeeRef");
    case "file":
      return t("profile.customEdit.unsupported.file");
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Raw control state → draft
// -----------------------------------------------------------------------------

/** The saved value as the control would display it. */
function savedText(draft: CustomFieldDraft | null): string {
  if (draft === null) return "";
  switch (draft.as) {
    case "text":
    case "date":
      return draft.value;
    case "number":
      return String(draft.value);
    case "boolean":
      return "";
  }
}

type Parsed =
  | { readonly ok: true; readonly draft: CustomFieldDraft }
  | { readonly ok: false; readonly problem: CustomFieldDraftProblem };

/**
 * The one place a control's raw value becomes a typed draft. Both failure modes
 * a number box has — blank and non-numeric — are named here rather than being
 * smuggled through as an empty string in the wrong typed column.
 */
function parseRaw(
  kind: NonNullable<ReturnType<typeof draftKindFor>>,
  text: string,
  bool: boolean,
): Parsed {
  switch (kind) {
    case "boolean":
      return { ok: true, draft: { as: "boolean", value: bool } };
    case "number": {
      const trimmed = text.trim();
      if (trimmed === "") return { ok: false, problem: { code: "empty" } };
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { ok: false, problem: { code: "number" } };
      return { ok: true, draft: { as: "number", value } };
    }
    case "date": {
      const trimmed = text.trim();
      if (trimmed === "") return { ok: false, problem: { code: "empty" } };
      return { ok: true, draft: { as: "date", value: trimmed } };
    }
    case "text": {
      if (text.trim() === "") return { ok: false, problem: { code: "empty" } };
      return { ok: true, draft: { as: "text", value: text } };
    }
  }
}

// -----------------------------------------------------------------------------
// The switch (there is no components/ui/switch.tsx in this repo)
// -----------------------------------------------------------------------------

/**
 * A real `role="switch"` button rather than a styled checkbox: the accessible
 * name is the field label, `aria-checked` carries the state, and Space/Enter
 * work for free. Same hand-rolled-primitive precedent as `AuditFilterBar`'s
 * `role="checkbox"` rows and `admin/components/Field`'s native `<select>` —
 * this repo has no Radix wrappers beyond the fifteen in `components/ui`.
 */
function SwitchControl({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-primary bg-primary" : "border-input bg-muted",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
          aria-hidden
        />
      </button>
      <span className="text-sm">
        {checked ? t("profile.customEdit.booleanOn") : t("profile.customEdit.booleanOff")}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// The row
// -----------------------------------------------------------------------------

export interface CustomFieldEditorProps {
  row: CustomFieldRow;
  requests: CustomFieldRequestState;
  /**
   * The change-request read is still in flight, so `requests` is not yet known
   * to be empty. The database has NO unique index on (employee_id, field_name,
   * status) — "one open request per field" is this screen's rule alone — so
   * `[Send to HR]` must stay disabled until the answer has arrived, or a fast
   * click on first paint files a second request behind the one already pending.
   */
  requestsPending: boolean;
  /** Raised once per accepted write so the page can toast it. */
  onSaved: (label: string) => void;
  onRequested: (label: string) => void;
}

export function CustomFieldEditor({
  row,
  requests,
  requestsPending,
  onSaved,
  onRequested,
}: CustomFieldEditorProps) {
  const { def, authority } = row;
  const kind = draftKindFor(def.field_type);
  const saved = draftFromValue(def, row.value);
  const savedAsText = savedText(saved);
  const savedBool = saved?.as === "boolean" ? saved.value : null;

  // `null` means "untouched — show what the server holds". Deriving the display
  // value instead of syncing state in an effect is what stops a refetch after a
  // save from fighting local state.
  const [rawText, setRawText] = useState<string | null>(null);
  const [rawBool, setRawBool] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<CustomFieldDraftProblem | null>(null);
  const [refused, setRefused] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const save = useSaveCustomFieldValue();
  const request = useRequestCustomFieldChange();

  const text = rawText ?? savedAsText;
  const bool = rawBool ?? savedBool ?? false;
  const dirty = kind === "boolean" ? rawBool !== null && rawBool !== savedBool : rawText !== null && rawText !== savedAsText;
  const busy = save.isPending || request.isPending;
  // A direct write is idempotent per field (uq_ecfv__employee_field), so it does
  // not need to wait; a change request does, because nothing in the database
  // stops a second open one.
  const blocked =
    requests.open !== null || (requestsPending && (authority === "maker_checker" || refused));
  const unsupported = unsupportedReason(row);
  const hints = fieldHints(row);
  const options = def.field_type === "single_select" ? customFieldOptions(def) : [];

  function clearFeedback() {
    setProblem(null);
    setServerError(null);
    setRefused(false);
  }

  function changeText(next: string) {
    setRawText(next);
    clearFeedback();
  }

  function changeBool(next: boolean) {
    setRawBool(next);
    clearFeedback();
  }

  function reset() {
    setRawText(null);
    setRawBool(null);
    clearFeedback();
  }

  function failed(err: unknown) {
    // A guard's own RAISE message is written for a person to read ("custom
    // field UNIFORM_SIZE: XXXL is not one of the configured options"), so it is
    // shown verbatim. Everything else goes through the string catalogue.
    setServerError(isRuleRejection(err) ? err.message : mutationUserMessage(err));
  }

  /** Parse + pre-flight validate, or set the problem and return null. */
  function readyDraft(): CustomFieldDraft | null {
    if (kind === null) return null;
    const parsed = parseRaw(kind, text, bool);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return null;
    }
    const found = validateCustomFieldDraft(def, parsed.draft);
    if (found !== null) {
      setProblem(found);
      return null;
    }
    return parsed.draft;
  }

  function submitDirect() {
    const draft = readyDraft();
    if (draft === null) return;
    save.mutate(
      { def, valueRowId: row.value?.id ?? null, draft },
      {
        onSuccess: () => {
          reset();
          onSaved(def.label);
        },
        onError: (err) => {
          // 42501 means migration 20260801014000 is not on this project. The
          // value is not lost: a change request is legal for ANY
          // is_employee_editable def, and the notice offers exactly that.
          if (isQueryErrorOfKind(err, "no_permission")) {
            setRefused(true);
            setProblem(null);
            setServerError(null);
            return;
          }
          failed(err);
        },
      },
    );
  }

  function submitRequest() {
    const draft = readyDraft();
    if (draft === null) return;
    request.mutate(
      { def, draft, current: saved },
      {
        onSuccess: () => {
          reset();
          onRequested(def.label);
        },
        onError: failed,
      },
    );
  }

  // ── Read-only: HR owns the field, or its type has no control here ─────────
  if (authority === "admin_only" || kind === null || unsupported !== null) {
    return (
      <div className="py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {def.label}
            <AuthorityBadge authority={authority} compact />
          </span>
          <span className="text-sm">{renderCustomValue(row)}</span>
        </div>
        {unsupported !== null && authority !== "admin_only" ? (
          <p className="mt-1 text-xs text-muted-foreground">{unsupported}</p>
        ) : null}
        {hints.map((hint) => (
          <p key={hint} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        ))}
      </div>
    );
  }

  const errorText = problem !== null ? problemMessage(problem) : null;
  const primaryDisabled = !dirty || busy || blocked;

  return (
    <div className="py-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          {kind === "boolean" ? (
            <div className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-sm font-medium leading-none">
                {def.label}
                <AuthorityBadge authority={authority} compact />
              </span>
              <SwitchControl
                checked={bool}
                onChange={changeBool}
                label={t("profile.customEdit.editAria", { label: def.label })}
                disabled={busy || blocked}
              />
              {savedBool === null && rawBool === null ? (
                <p className="text-xs text-muted-foreground">{dash(null)}</p>
              ) : null}
              {errorText !== null ? (
                <p className="text-xs font-medium text-destructive" role="alert">
                  {errorText}
                </p>
              ) : null}
            </div>
          ) : def.field_type === "single_select" ? (
            <SelectField
              label={def.label}
              value={text}
              options={options}
              placeholder={t("profile.customEdit.selectPlaceholder")}
              onChange={changeText}
              disabled={busy || blocked}
              required={def.is_required}
              error={errorText}
            />
          ) : kind === "number" ? (
            <TextField
              label={def.label}
              type="number"
              inputMode="decimal"
              value={text}
              onChange={changeText}
              disabled={busy || blocked}
              required={def.is_required}
              error={errorText}
              {...(def.min_value !== null ? { min: String(def.min_value) } : {})}
              {...(def.max_value !== null ? { max: String(def.max_value) } : {})}
            />
          ) : kind === "date" ? (
            <TextField
              label={def.label}
              type="date"
              value={text}
              onChange={changeText}
              disabled={busy || blocked}
              required={def.is_required}
              error={errorText}
            />
          ) : (
            <TextField
              label={def.label}
              value={text}
              onChange={changeText}
              disabled={busy || blocked}
              required={def.is_required}
              error={errorText}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          {dirty ? (
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}>
              {t("profile.customEdit.undo")}
            </Button>
          ) : null}
          {authority === "self" && !refused ? (
            <Button type="button" size="sm" disabled={primaryDisabled} onClick={submitDirect}>
              {save.isPending ? t("profile.customEdit.saving") : t("profile.customEdit.save")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant={refused ? "outline" : "default"}
              disabled={primaryDisabled}
              onClick={submitRequest}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {request.isPending
                ? t("profile.customEdit.requesting")
                : t("profile.customEdit.request")}
            </Button>
          )}
        </div>
      </div>

      {hints.map((hint) => (
        <p key={hint} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ))}

      {saved !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("profile.customEdit.hint.noClear")}
        </p>
      ) : null}

      {requests.open !== null ? (
        <Notice tone="warning" className="mt-2">
          <p className="font-medium">{t("profile.customEdit.pending.title")}</p>
          <p className="mt-0.5">
            {t("profile.customEdit.pending.body", {
              value: renderJsonValue(requests.open.new_value),
              at: fmtDateTime(requests.open.requested_at),
            })}
          </p>
          <p className="mt-0.5 text-xs">{t("profile.customEdit.pending.blocked")}</p>
        </Notice>
      ) : null}

      {requests.failed !== null && requests.failed.apply_error !== null ? (
        <Notice tone="error" className="mt-2">
          {t("profile.customEdit.failed", { error: requests.failed.apply_error })}
        </Notice>
      ) : null}

      {/* The primary button has already become "Send to HR" (outline) above, so
          this notice explains and does not duplicate the control. */}
      {refused ? (
        <Notice tone="warning" className="mt-2">
          <p className="font-medium">{t("profile.customEdit.refused.title")}</p>
          <p className="mt-0.5">{t("profile.customEdit.refused.body")}</p>
        </Notice>
      ) : null}

      {serverError !== null ? (
        <Notice tone="error" className="mt-2">
          {serverError}
        </Notice>
      ) : null}
    </div>
  );
}
