/**
 * EditableFieldRow.tsx — a field row that can be acted on, and a field row that
 * explains why it cannot be.
 *
 * `FieldRow` renders label + value + authority marker. This adds the two things
 * an employee actually needs on top of that:
 *
 *  1. THE AFFORDANCE. "Request change" for a maker-checker field, "Change" for
 *     one the database really lets the employee write. The verb differs because
 *     the promise differs, and `self-edit.ts` derives which from the migrations
 *     rather than from an opinion — the first cut of this screen marked
 *     `blood_group`, `marital_status`, `marriage_anniversary` and
 *     `preferred_name` as immediate self-edits, and a save on any of them would
 *     have been refused with 42501 because no column grant covers them.
 *
 *  2. THE STATE OF THE REQUEST, ON THE FIELD IT AFFECTS. "Change to X awaiting HR
 *     approval, submitted <IST>", with the reference, and a `Take it back`
 *     button when — and only when — a recallable approval exists. A pending
 *     request the employee cannot see on the field is the thing that generates
 *     the support ticket; a pending request that can never be cancelled is the
 *     thing that generates the second one.
 *
 * `ReadOnlyFieldRow` is the other half of the contract: a field outside
 * `public.employee_changeable_fields()` is never silently hidden and never shown
 * with a dead button. It renders with its `admin_only` marker AND a sentence
 * naming who does change it.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { Clock3, Info, Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { AuthorityBadge } from "./AuthorityBadge";
import { FieldEditSheet } from "./FieldEditSheet";
import {
  asDirectField,
  displayFieldValue,
  displayRequestValue,
  fieldSpec,
  readFieldValue,
  toControlValue,
  validateFieldInput,
  type EditableField,
} from "../self-edit";
import {
  selfEditErrorMessage,
  useFieldChangeState,
  useSubmitFieldChange,
  useUpdateSelfField,
  useWithdrawFieldChange,
  type FieldChangeState,
} from "../hooks/useSelfEdit";
import type { MyEmployeeProfile } from "../api/profile.api";

// -----------------------------------------------------------------------------
// Shared frame — the same dt/dd shape as FieldRow so the grid stays one grid
// -----------------------------------------------------------------------------

function RowFrame({
  label,
  marker,
  value,
  hint,
  wide,
  children,
}: {
  label: string;
  marker: ReactNode;
  value: ReactNode;
  hint?: string | undefined;
  wide: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2 lg:col-span-4")}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {marker}
      </dt>
      <dd className="mt-1 space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <span className="min-w-0 break-words text-sm">{value}</span>
          {children}
        </div>
        {hint !== undefined && hint !== "" ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </dd>
    </div>
  );
}

/** A muted explanatory line with an icon — used for both notes and refusals. */
export function FieldNote({
  tone = "muted",
  icon: Icon = Info,
  children,
}: {
  tone?: "muted" | "warn" | "danger";
  icon?: typeof Info;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warn" && "text-warning",
        tone === "danger" && "text-destructive",
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// -----------------------------------------------------------------------------
// Read-only rows — the fields outside the server whitelist
// -----------------------------------------------------------------------------

export interface ReadOnlyFieldRowProps {
  label: string;
  value: ReactNode;
  /** Who DOES change this, in a sentence. Never omitted — that is the point. */
  ownerNoteKey: MessageKey;
  hint?: string;
  wide?: boolean;
}

export function ReadOnlyFieldRow({
  label,
  value,
  ownerNoteKey,
  hint,
  wide = false,
}: ReadOnlyFieldRowProps) {
  return (
    <RowFrame
      label={label}
      marker={<AuthorityBadge authority="admin_only" compact />}
      value={value}
      wide={wide}
      hint={hint}
    >
      <div className="w-full">
        <FieldNote icon={Lock}>{t(ownerNoteKey)}</FieldNote>
      </div>
    </RowFrame>
  );
}

// -----------------------------------------------------------------------------
// The state note
// -----------------------------------------------------------------------------

function StateNote({
  column,
  state,
  onWithdraw,
  withdrawing,
  withdrawError,
}: {
  column: EditableField;
  state: FieldChangeState;
  onWithdraw: () => void;
  withdrawing: boolean;
  withdrawError: string | null;
}) {
  const value = displayRequestValue(column, state.requestedValue);
  const decidedAt = state.decidedAt;

  if (state.stage === "open") {
    return (
      <div className="w-full space-y-1">
        <FieldNote tone="warn" icon={Clock3}>
          {t("me.edit.state.open", { value, when: fmtDateTime(state.requestedAt) })}
        </FieldNote>
        {state.reference !== null ? (
          <p className="pl-5 text-xs text-muted-foreground">
            {t("me.edit.state.openRef", { reference: state.reference })}
          </p>
        ) : null}
        {state.canWithdraw && state.approvalRequestId !== null ? (
          <div className="pl-5">
            <Button
              variant="outline"
              size="sm"
              onClick={onWithdraw}
              disabled={withdrawing}
              aria-label={t("me.edit.action.withdrawAria", { field: t(fieldSpec(column).labelKey) })}
            >
              {withdrawing ? t("me.edit.action.withdrawing") : t("me.edit.action.withdraw")}
            </Button>
          </div>
        ) : (
          // No recallable approval behind this row — an HR-raised request, or one
          // whose approval never routed. `me.edit.note.noEdit` ("take it back and
          // send a new one") would name an action that is not on offer here, so
          // this branch names the route that IS: the Help Desk.
          <p className="pl-5 text-xs text-muted-foreground">
            {t("me.edit.state.openNoRecall")}
          </p>
        )}
        {withdrawError !== null ? (
          <p className="pl-5 text-xs font-medium text-destructive" role="alert">
            {withdrawError}
          </p>
        ) : null}
      </div>
    );
  }

  if (state.stage === "approved_not_applied") {
    return (
      <div className="w-full">
        <FieldNote tone="warn" icon={Clock3}>
          {t("me.edit.state.approved", {
            value,
            when: decidedAt === null ? fmtDateTime(state.requestedAt) : fmtDateTime(decidedAt),
          })}
        </FieldNote>
      </div>
    );
  }

  if (state.stage === "rejected") {
    return (
      <div className="w-full space-y-1">
        <FieldNote tone="danger" icon={TriangleAlert}>
          {t("me.edit.state.rejected", {
            value,
            when: decidedAt === null ? fmtDateTime(state.requestedAt) : fmtDateTime(decidedAt),
          })}
        </FieldNote>
        {state.comment !== null && state.comment !== "" ? (
          <p className="pl-5 text-xs text-muted-foreground">
            {t("me.edit.state.rejectedComment", { comment: state.comment })}
          </p>
        ) : null}
      </div>
    );
  }

  if (state.stage === "failed") {
    return (
      <div className="w-full space-y-1">
        <FieldNote tone="danger" icon={TriangleAlert}>
          {t("me.edit.state.failed", { value })}
        </FieldNote>
        {state.applyError !== null && state.applyError !== "" ? (
          <p className="pl-5 text-xs text-muted-foreground">
            {t("me.edit.state.failedDetail", { error: state.applyError })}
          </p>
        ) : null}
      </div>
    );
  }

  if (state.stage === "expired") {
    return (
      <div className="w-full">
        <FieldNote tone="warn" icon={Clock3}>
          {t("me.edit.state.expired", { value })}
        </FieldNote>
      </div>
    );
  }

  return (
    <div className="w-full">
      <FieldNote>{t("me.edit.state.withdrawn", { value })}</FieldNote>
    </div>
  );
}

// -----------------------------------------------------------------------------
// The editable row
// -----------------------------------------------------------------------------

export interface EditableFieldRowProps {
  /** A column inside `public.employee_changeable_fields()`. */
  column: EditableField;
  label: string;
  /** THE profile row — the same `qk.profile.me()` entry every tab reads. */
  profile: MyEmployeeProfile;
  /** Formatted display, when the default value rendering is not enough. */
  value?: ReactNode;
  hint?: string;
  wide?: boolean;
}

export function EditableFieldRow({
  column,
  label,
  profile,
  value,
  hint,
  wide = false,
}: EditableFieldRowProps) {
  const spec = fieldSpec(column);
  // A column is saved directly only if the spec says so AND this build knows how
  // to carry it. Anything else raises a change request, which the server accepts
  // for every whitelisted column — so a future `direct` field with no typed
  // writer degrades to maker-checker rather than to a button that does nothing.
  const directColumn = spec.mechanism === "direct" ? asDirectField(column) : null;
  const isDirect = directColumn !== null;
  const raw = readFieldValue(profile, column);
  const currentDisplay = displayFieldValue(column, raw);

  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<{ readonly reference: string | null } | null>(null);

  const { state, loading, unavailable } = useFieldChangeState(column);
  const submitRequest = useSubmitFieldChange();
  const saveDirect = useUpdateSelfField();
  const withdraw = useWithdrawFieldChange();

  const pending = submitRequest.isPending || saveDirect.isPending;
  const activeError = submitRequest.error ?? saveDirect.error;
  // A second pending request for one field cannot be cleaned up by the employee
  // (no UPDATE, no DELETE on the table), so one open request blocks the next.
  // A DIRECT column is never blocked: the employee writes it whatever else is in
  // flight, and blocking it would be a restriction the server does not impose.
  const blocked = !isDirect && state !== null && state.stage === "open";
  // …and the block has to hold while the check is still in flight. The table has
  // no uniqueness on (employee, field, status), so a click landing before the
  // read resolves is exactly how a field ends up with two pending rows the
  // employee cannot clean up. `loading` is false once either read settles — a
  // FAILED read re-enables the button and shows `me.edit.state.unknown`, so this
  // is a moment's wait, never a lockout.
  const checking = !isDirect && loading;

  function close() {
    setOpen(false);
    setDone(null);
    submitRequest.reset();
    saveDirect.reset();
  }

  function handleSubmit(input: string, reason: string) {
    const outcome = validateFieldInput(column, input, raw);
    if (!outcome.ok) return;

    if (directColumn !== null) {
      saveDirect.mutate(
        { column: directColumn, value: String(outcome.value), note: reason },
        { onSuccess: () => setDone({ reference: null }) },
      );
      return;
    }

    submitRequest.mutate(
      {
        column,
        newValue: outcome.value,
        oldValue: raw,
        oldDisplay: currentDisplay,
        newDisplay: displayFieldValue(column, outcome.value),
        reason,
      },
      { onSuccess: (result) => setDone({ reference: result.requestNumber }) },
    );
  }

  return (
    <RowFrame
      label={label}
      marker={<AuthorityBadge authority={isDirect ? "self" : "maker_checker"} compact />}
      value={value ?? currentDisplay}
      wide={wide}
      hint={hint}
    >
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={blocked || checking}
        onClick={() => {
          setDone(null);
          submitRequest.reset();
          saveDirect.reset();
          setOpen(true);
        }}
        aria-label={
          isDirect
            ? t("me.edit.action.editAria", { field: label })
            : t("me.edit.action.requestAria", { field: label })
        }
      >
        {isDirect ? t("me.edit.action.edit") : t("me.edit.action.request")}
      </Button>

      {blocked ? (
        <p className="w-full text-xs text-muted-foreground">{t("me.edit.state.openBlocks")}</p>
      ) : null}

      {state !== null ? (
        <StateNote
          column={column}
          state={state}
          withdrawing={withdraw.isPending}
          withdrawError={selfEditErrorMessage(withdraw.error)}
          onWithdraw={() => {
            if (state.approvalRequestId === null) return;
            withdraw.mutate({ approvalRequestId: state.approvalRequestId });
          }}
        />
      ) : unavailable ? (
        <div className="w-full">
          <FieldNote tone="warn" icon={TriangleAlert}>
            {t("me.edit.state.unknown")}
          </FieldNote>
        </div>
      ) : null}

      <FieldEditSheet
        open={open}
        column={column}
        label={label}
        currentDisplay={currentDisplay}
        initialValue={toControlValue(raw)}
        currentRaw={raw}
        pending={pending}
        serverMessage={selfEditErrorMessage(activeError)}
        done={done}
        validate={(input) => validateFieldInput(column, input, raw)}
        onSubmit={handleSubmit}
        onClose={close}
      />
    </RowFrame>
  );
}
