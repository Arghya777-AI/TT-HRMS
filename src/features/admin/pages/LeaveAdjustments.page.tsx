/**
 * /admin/leave/adjustments — manual credit or debit of a leave balance
 * (spec-admin §7.2).
 *
 * This screen ALWAYS asks for a reason. Not a default sentence, not an inferred
 * one: a manual adjustment is a human decision to move somebody's entitlement,
 * so `reason_category` is a required field AND `<ReasonDialog>` collects ≥15
 * free-text characters (D-21) that land in the ledger row and the audit trail.
 *
 * HONEST LIMIT — read the banner, it is not a placeholder. On this backend there
 * is no write path for a manual adjustment:
 *   * `leave_ledger` grants INSERT to `service_role` only (019 grants),
 *   * `leave_ledger_guard_mutation` refuses client UPDATE/DELETE outright
 *     (the ledger is append-only by construction), and
 *   * no `leave-adjust` edge function is deployed (28 functions, none of them
 *     this one).
 * So `submitLeaveAdjustment` refuses in the client with that sentence instead of
 * posting a request that is certain to come back 42501 after an admin has typed
 * a justification. The form is still real — fields, validation, balance impact
 * and the reason prompt are the finished article, and the day the endpoint ships
 * only `leave.api.ts` changes.
 *
 * The balance panel reads `v_leave_balance_current`; the "after" figure is NOT
 * computed here — showing a locally-arithmetic projected balance is precisely the
 * defect class (DR-29/DR-32) this build refuses to reproduce.
 *
 * @route /admin/leave/adjustments
 */
import { useState } from "react";
import { Scale, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { SENSITIVE_REASON_LENGTH, isMutationErrorOfKind } from "@/shared/api/query";
import { nowIstDate } from "@/lib/datetime";
import { formatDays } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/app/auth/AuthProvider";
import type { LeaveAdjustmentInput } from "../api/leave.api";
import { Notice } from "../components/Notice";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  useAdminLeaveTypes,
  useLeaveAdjustment,
  useOneLeaveBalance,
} from "../hooks/useAdminLeave";
import { useReasonPrompt } from "../hooks/useReasonPrompt";

/** `reason_category` vocabulary, spec-admin §7.2. */
const CATEGORIES = [
  "policy_exception",
  "data_correction",
  "management_grant",
  "statutory_requirement",
  "system_error_fix",
  "settlement",
] as const;

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  policy_exception: t("admin.leaveAdj.category.policy_exception"),
  data_correction: t("admin.leaveAdj.category.data_correction"),
  management_grant: t("admin.leaveAdj.category.management_grant"),
  statutory_requirement: t("admin.leaveAdj.category.statutory_requirement"),
  system_error_fix: t("admin.leaveAdj.category.system_error_fix"),
  settlement: t("admin.leaveAdj.category.settlement"),
};

interface FormState {
  employeeId: string;
  leaveTypeId: string;
  direction: "credit" | "debit" | "opening";
  days: string;
  effectiveDate: string;
  category: string;
}

/**
 * Field key → message. A plain Record (not optional properties) because
 * `exactOptionalPropertyTypes` refuses an explicit `undefined` on an optional
 * property, and clearing one error as the user types is exactly that.
 */
type FieldErrors = Record<string, string | undefined>;

/** Whole or half days only — `allow_half_day` is the finest grain leave has. */
function parseDays(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,3}(\.\d)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 365) return null;
  if (Math.round(value * 2) !== value * 2) return null;
  return value;
}

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (form.employeeId === "") errors.employeeId = t("admin.leaveAdj.error.employee");
  if (form.leaveTypeId === "") errors.leaveTypeId = t("admin.leaveAdj.error.type");
  if (parseDays(form.days) === null) errors.days = t("admin.leaveAdj.error.days");
  if (form.effectiveDate === "") errors.effectiveDate = t("admin.leaveAdj.error.date");
  if (form.category === "") errors.category = t("admin.leaveAdj.error.category");
  return errors;
}

export default function AdminLeaveAdjustmentsPage() {
  const { employee } = useAuth();
  const labels = useEmployeeLabels();
  const employeeChoices = useEmployeeOptions(labels.data);
  const types = useAdminLeaveTypes();

  /*
    `?emp=<uuid>` PRE-SELECTS THE PERSON. The employee record now links here to adjust one
    person's balance, and a screen that ignored the scope would drop the admin on an empty
    picker with 78 names in it — which is how the wrong employee gets adjusted.
  */
  const [params] = useSearchParams();
  const [form, setForm] = useState<FormState>({
    employeeId: params.get("emp") ?? "",
    leaveTypeId: "",
    direction: "credit",
    days: "",
    effectiveDate: nowIstDate(),
    category: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState<string | null>(null);

  const balance = useOneLeaveBalance(
    form.employeeId === "" ? null : form.employeeId,
    form.leaveTypeId === "" ? null : form.leaveTypeId,
  );
  const balanceRow = (balance.data ?? [])[0] ?? null;

  const prompt = useReasonPrompt<LeaveAdjustmentInput>();
  const { ask, close: closePrompt, target, isOpen } = prompt;

  const adjust = useLeaveAdjustment((input) => {
    closePrompt();
    setDone(t("admin.leaveAdj.done", { days: formatDays(Math.abs(input.days)) }));
  });

  const typeChoices: SelectOption[] = (types.data ?? []).map((type) => ({
    value: type.id,
    label: type.name,
  }));

  const categoryChoices: SelectOption[] = CATEGORIES.map((value) => ({
    value,
    label: CATEGORY_LABEL[value] ?? value,
  }));

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    setDone(null);
  }

  function submit(): void {
    const found = validate(form);
    setErrors(found);
    if (Object.values(found).some((value) => value !== undefined)) return;
    const days = parseDays(form.days);
    if (days === null) return;
    adjust.reset();
    ask({
      employeeId: form.employeeId,
      leaveTypeId: form.leaveTypeId,
      /*
        A POSITIVE MAGNITUDE PLUS A KIND, not a signed number.

        This used to send `-days` for a debit and let the sign carry the meaning. The RPC
        now takes the magnitude and the kind separately, because the sign cannot express
        the third case: an OPENING BALANCE is positive like a credit but is a different
        ledger entry type. `adjust_leave_balance` negates a debit server-side, so the sign
        convention lives in exactly one place.
      */
      days,
      kind: form.direction,
      effectiveDate: form.effectiveDate,
      reasonCategory: form.category,
    });
  }

  const chosenEmployee =
    form.employeeId === "" ? null : labels.data?.get(form.employeeId) ?? null;

  /**
   * The generic "ask a super admin" sentence would be a lie here: no privilege
   * unlocks a table whose only writer is the server, so a refusal on this path is
   * reported as the missing endpoint it actually is. Any OTHER failure keeps its
   * own plain-English message.
   */
  const failure =
    adjust.error === null || adjust.error === undefined
      ? null
      : isMutationErrorOfKind(adjust.error, "permission_denied")
        ? t("admin.leaveAdj.noEndpoint.body")
        : adjust.userMessage;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Scale}
        title={t("admin.leaveAdj.title")}
        subtitle={t("admin.leaveAdj.subtitle")}
      />

      {/*
        The old banner said adjustments could not be saved, which was true until migration
        039300 deployed `adjust_leave_balance`. It is replaced rather than deleted, because
        the thing worth saying has changed rather than gone away: the ledger is still
        append-only and the authority rules are still the server's.
      */}
      <Notice tone="info" className="mb-5">
        <p className="font-medium">{t("admin.leaveAdj.rules.title")}</p>
        <p className="mt-1">{t("admin.leaveAdj.rules.body")}</p>
      </Notice>

      {done !== null ? (
        <Notice tone="success" className="mb-5">
          {done}
        </Notice>
      ) : null}

      {failure !== null && !isOpen ? (
        <Notice tone="error" className="mb-5">
          {failure}
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="rounded-lg border bg-card p-5">
          <h2 className="font-display text-lg font-semibold">
            {t("admin.leaveAdj.form.heading")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.leaveAdj.form.hint")}</p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t("admin.leaveAdj.field.employee")}
              required
              value={form.employeeId}
              options={employeeChoices}
              placeholder={t("admin.leaveAdj.field.employeePlaceholder")}
              onChange={(value) => set("employeeId", value)}
              disabled={labels.isLoading}
              {...(errors.employeeId !== undefined ? { error: errors.employeeId } : {})}
            />
            <SelectField
              label={t("admin.leaveAdj.field.type")}
              required
              value={form.leaveTypeId}
              options={typeChoices}
              placeholder={t("admin.leaveAdj.field.typePlaceholder")}
              onChange={(value) => set("leaveTypeId", value)}
              disabled={types.isLoading}
              {...(errors.leaveTypeId !== undefined ? { error: errors.leaveTypeId } : {})}
            />
            <SelectField
              label={t("admin.leaveAdj.field.direction")}
              required
              value={form.direction}
              options={[
                { value: "credit", label: t("admin.leaveAdj.direction.credit") },
                { value: "debit", label: t("admin.leaveAdj.direction.debit") },
                /* Its own ledger entry type, not a credit with a note — see
                   LeaveAdjustmentInput.kind. */
                { value: "opening", label: t("admin.leaveAdj.direction.opening") },
              ]}
              onChange={(value) =>
                set(
                  "direction",
                  value === "debit" ? "debit" : value === "opening" ? "opening" : "credit",
                )
              }
              hint={t("admin.leaveAdj.field.directionHint")}
            />
            <TextField
              label={t("admin.leaveAdj.field.days")}
              required
              value={form.days}
              onChange={(value) => set("days", value)}
              inputMode="decimal"
              placeholder="1.5"
              hint={t("admin.leaveAdj.field.daysHint")}
              {...(errors.days !== undefined ? { error: errors.days } : {})}
            />
            <TextField
              label={t("admin.leaveAdj.field.effectiveDate")}
              required
              type="date"
              value={form.effectiveDate}
              onChange={(value) => set("effectiveDate", value)}
              {...(errors.effectiveDate !== undefined ? { error: errors.effectiveDate } : {})}
            />
            <SelectField
              label={t("admin.leaveAdj.field.category")}
              required
              value={form.category}
              options={categoryChoices}
              placeholder={t("admin.leaveAdj.field.categoryPlaceholder")}
              onChange={(value) => set("category", value)}
              {...(errors.category !== undefined ? { error: errors.category } : {})}
            />
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button onClick={submit} disabled={adjust.isPending}>
              {adjust.isPending
                ? t("admin.leaveAdj.action.saving")
                : t("admin.leaveAdj.action.continue")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("admin.leaveAdj.action.hint", { min: SENSITIVE_REASON_LENGTH })}
            </p>
          </div>
        </section>

        <aside className="rounded-lg border bg-card p-5">
          <h2 className="font-display text-base font-semibold">
            {t("admin.leaveAdj.balance.heading")}
          </h2>
          {form.employeeId === "" || form.leaveTypeId === "" ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("admin.leaveAdj.balance.pick")}
            </p>
          ) : (
            <StateBoundary
              loading={balance.isLoading}
              error={balance.error ?? undefined}
              onRetry={() => void balance.refetch()}
              isEmpty={balance.isSuccess && balanceRow === null}
              empty={
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("admin.leaveAdj.balance.none")}
                </p>
              }
              skeletonRows={2}
            >
              {balanceRow !== null ? (
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {t("admin.leaveAdj.balance.person")}
                    </dt>
                    <dd className="text-right">{chosenEmployee?.name ?? "—"}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t("admin.leaveAdj.balance.type")}</dt>
                    <dd className="text-right">{balanceRow.leave_type_name}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {t("admin.leaveAdj.balance.available")}
                    </dt>
                    <dd className="num text-right font-semibold">
                      {formatDays(balanceRow.available_days)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {t("admin.leaveAdj.balance.spendable")}
                    </dt>
                    <dd className="num text-right">
                      {formatDays(balanceRow.available_after_pending)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">
                      {t("admin.leaveAdj.balance.adjustedSoFar")}
                    </dt>
                    <dd className="num text-right">{formatDays(balanceRow.adjusted_days)}</dd>
                  </div>
                </dl>
              ) : null}
              <p className="mt-4 text-xs text-muted-foreground">
                {t("admin.leaveAdj.balance.noProjection")}
              </p>
            </StateBoundary>
          )}
        </aside>
      </div>

      <ReasonDialog
        open={isOpen}
        title={t("admin.leaveAdj.dialog.title")}
        description={
          target === null
            ? t("admin.leaveAdj.dialog.description")
            : t("admin.leaveAdj.dialog.diff", {
                direction:
                  target.days < 0
                    ? t("admin.leaveAdj.direction.debit")
                    : t("admin.leaveAdj.direction.credit"),
                days: formatDays(Math.abs(target.days)),
                name: chosenEmployee?.name ?? "—",
                category: CATEGORY_LABEL[target.reasonCategory] ?? target.reasonCategory,
              })
        }
        actorName={employee?.displayName ?? null}
        minLength={SENSITIVE_REASON_LENGTH}
        confirmLabel={t("admin.leaveAdj.dialog.confirm")}
        pending={adjust.isPending}
        errorMessage={failure}
        onConfirm={(reason) => {
          if (target !== null) adjust.save(target, reason);
        }}
        onCancel={() => {
          adjust.reset();
          closePrompt();
        }}
      />

      <p className="mt-6 flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("admin.leaveAdj.footnote")}
      </p>
    </div>
  );
}
