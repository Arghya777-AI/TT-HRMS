/**
 * §2 · /admin/people/new — Add Employee. Five steps, one INSERT.
 *
 * The three rules that shape this screen:
 *
 *  1. THE EMPLOYEE CODE IS NEVER ASKED FOR. `employee_code` is allocated by a
 *     database trigger from `employee_code_seq` and is immutable afterwards
 *     (D-02). `insertEmployee` throws if a caller supplies one. The Review step
 *     says so in plain language, and the success screen shows the code the
 *     database actually chose — the first moment it exists.
 *  2. VALIDATION MIRRORS THE CONSTRAINTS, IT DOES NOT INVENT THEM. Every rule
 *     enforced here is a real `ck_employees__*` from migration 008 or a
 *     lifecycle rule from `employeeFormError` — the mobile regex, the email
 *     shapes, probation 0–24, notice 0–180, a joining date that cannot precede
 *     a birth date, a future joining date forcing Pre-joining status. Catching
 *     them in the browser spends the round trip on real work; the database is
 *     still the authority.
 *  3. ONE COERCION PATH. Values are held as strings and converted by
 *     `coerceValues` from the shared field vocabulary, so an empty box becomes
 *     NULL rather than '' on one of the 30 NOT NULL columns.
 *
 * The write goes through `useAuditedMutation`, so creating a person carries a
 * typed reason and lands in the audit log with the actor, their role and the
 * reason attached — the same path every other admin write uses.
 *
 * @route /admin/people/new
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Notice } from "../components/Notice";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { useAuditedMutation } from "@/shared/hooks/useAuditedMutation";
import { qk } from "@/shared/api/keys";
import { nowIstDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { FieldGroupSection } from "../components/FieldGroupSection";
import {
  coerceValues,
  validateFields,
  withDefaults,
  type FieldErrors,
  type FormValues,
} from "../masters/fields";
import {
  NEW_EMPLOYEE_DEFAULTS,
  WIZARD_STEPS,
  allWizardGroups,
  employeeFormError,
  withDerivedDisplayName,
  wizardStepGroups,
  wizardStepHint,
  wizardStepTitle,
  type WizardStepId,
} from "../people/fields";
import { usePeopleRefs } from "../hooks/usePeople";
import { insertEmployee } from "../api/employees.api";
import { useDefaultCompanyId } from "../hooks/useMasters";

const MIN_REASON = 10;

export default function AddEmployeePage() {
  const navigate = useNavigate();
  const refs = usePeopleRefs();
  const companyId = useDefaultCompanyId();

  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<FormValues>(() => withDefaults({}, NEW_EMPLOYEE_DEFAULTS));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [reasonOpen, setReasonOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; employee_code: string } | null>(null);

  const step: WizardStepId = WIZARD_STEPS[stepIndex] ?? "identity";
  const isReview = step === "review";
  const groups = useMemo(() => wizardStepGroups(step, refs), [step, refs]);
  const everyGroup = useMemo(() => allWizardGroups(refs), [refs]);

  const create = useAuditedMutation<{ id: string; employee_code: string }, Record<string, unknown>>({
    mutationFn: (input, reason) => insertEmployee(input, reason),
    invalidate: [qk.admin.employeesAll()],
    minReasonLength: MIN_REASON,
    onSuccess: (row) => {
      setCreated(row);
      setReasonOpen(false);
    },
  });

  const setValue = (name: string, value: string) => {
    setValues((prev) => withDerivedDisplayName({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  /** Field errors for the CURRENT step only — never scold about a later step. */
  const validateStep = (): boolean => {
    const found = validateFields(groups, values, "create");
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  /** Cross-field lifecycle rules, checked against the IST business date. */
  const crossFieldError = useMemo(
    () => employeeFormError(values, nowIstDate()),
    [values],
  );

  const goNext = () => {
    if (!validateStep()) return;
    setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  };

  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0));

  const openReason = () => {
    // The review step submits everything, so validate everything.
    const found = validateFields(everyGroup, values, "create");
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Jump back to the first step that actually has a problem.
      const failing = WIZARD_STEPS.findIndex((s) =>
        wizardStepGroups(s, refs).some((g) => g.fields.some((f) => found[f.name] !== undefined)),
      );
      if (failing >= 0) setStepIndex(failing);
      return;
    }
    if (crossFieldError !== null) return;
    setReasonOpen(true);
  };

  const submit = (reason: string) => {
    const payload = coerceValues(everyGroup, values, "create", null);
    // company_id is NOT NULL and is not a field the admin picks — there is one
    // employing entity per install and the wizard must not offer a wrong one.
    if (companyId !== null) payload["company_id"] = companyId;
    create.save(payload, reason);
  };

  // ---------------------------------------------------------------------------
  // Success — the first moment the employee code exists
  // ---------------------------------------------------------------------------
  if (created !== null) {
    return (
      <div className="container py-6">
        <PageHeader
          icon={CheckCircle2}
          title={t("admin.people.add.done.title")}
          subtitle={t("admin.people.add.done.subtitle", { code: created.employee_code })}
        />
        <div className="mt-4 rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">{t("admin.people.add.done.codeLabel")}</p>
          <p className="num mt-1 font-display text-3xl font-semibold">{created.employee_code}</p>
          <p className="mt-4 max-w-prose text-sm text-muted-foreground">
            {t("admin.people.add.done.next")}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => void navigate(`/admin/people/${created.employee_code}`)}>
              {t("admin.people.add.done.open")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setCreated(null);
                setValues(withDefaults({}, NEW_EMPLOYEE_DEFAULTS));
                setErrors({});
                setStepIndex(0);
              }}
            >
              {t("admin.people.add.done.another")}
            </Button>
            <Button variant="ghost" onClick={() => void navigate("/admin/people")}>
              {t("admin.people.add.done.directory")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={UserPlus}
        title={t("admin.people.add.title")}
        subtitle={t("admin.people.add.subtitle")}
        actions={
          <Button variant="ghost" onClick={() => void navigate("/admin/people")}>
            {t("admin.people.add.cancel")}
          </Button>
        }
      />

      {/* Step rail */}
      <ol className="mt-4 flex flex-wrap gap-2" aria-label={t("admin.people.add.stepsLabel")}>
        {WIZARD_STEPS.map((s, i) => {
          const state = i === stepIndex ? "current" : i < stepIndex ? "done" : "todo";
          return (
            <li key={s}>
              <button
                type="button"
                onClick={() => {
                  // Only allow going back, so a step is never skipped forwards.
                  if (i < stepIndex) setStepIndex(i);
                }}
                disabled={i > stepIndex}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  state === "current" && "border-primary bg-primary text-primary-foreground",
                  state === "done" && "border-primary/40 bg-primary/10 text-foreground",
                  state === "todo" && "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                <span className="num mr-1.5">{i + 1}</span>
                {wizardStepTitle(s)}
              </button>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-sm text-muted-foreground">{wizardStepHint(step)}</p>

      {companyId === null ? (
        <div className="mt-4">
          <Notice tone="warning">{t("admin.people.add.noCompany.body")}</Notice>
        </div>
      ) : null}

      {/* Steps 1–4 collect; step 5 reviews. */}
      {!isReview ? (
        <div className="mt-4 space-y-4">
          {groups.map((group) => (
            <FieldGroupSection
              key={group.title}
              group={group}
              values={values}
              errors={errors}
              mode="create"
              onChange={setValue}
              disabled={create.isPending}
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <Notice tone="info">{t("admin.people.add.review.codeNotice.body")}</Notice>

          {everyGroup.map((group) => {
            const filled = group.fields.filter(
              (f) => (values[f.name] ?? "").trim() !== "" && f.derived !== true,
            );
            if (filled.length === 0) return null;
            return (
              <section key={group.title} className="rounded-lg border bg-card p-4">
                <h3 className="font-display text-sm font-semibold">{group.title}</h3>
                <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {filled.map((f) => {
                    const raw = (values[f.name] ?? "").trim();
                    const display =
                      f.kind === "checkbox"
                        ? raw === "true"
                          ? t("admin.master.yes")
                          : t("admin.master.no")
                        : f.kind === "select"
                          ? (f.options?.find((o) => o.value === raw)?.label ?? raw)
                          : raw;
                    return (
                      <div key={f.name} className="flex min-w-0 justify-between gap-4 border-b py-1.5">
                        <dt className="text-sm text-muted-foreground">{f.label}</dt>
                        <dd className="truncate text-sm font-medium">{display}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            );
          })}
        </div>
      )}

      {crossFieldError !== null ? (
        <div className="mt-4">
          <Notice tone="error">{crossFieldError}</Notice>
        </div>
      ) : null}

      {/* A failure while the dialog is closed still has to be visible. */}
      {create.userMessage !== null && !reasonOpen ? (
        <div className="mt-4">
          <Notice tone="error">{create.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="outline" onClick={goBack} disabled={stepIndex === 0 || create.isPending}>
          <ArrowLeft className="mr-2 size-4" aria-hidden />
          {t("admin.people.add.back")}
        </Button>

        {!isReview ? (
          <Button onClick={goNext}>
            {t("admin.people.add.next")}
            <ArrowRight className="ml-2 size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            onClick={openReason}
            disabled={create.isPending || companyId === null || crossFieldError !== null}
          >
            {create.isPending ? t("admin.people.add.creating") : t("admin.people.add.submit")}
          </Button>
        )}
      </div>

      <ReasonDialog
        open={reasonOpen}
        title={t("admin.people.add.reason.title")}
        description={t("admin.people.add.reason.description", {
          name: (values["display_name"] ?? "").trim() || t("admin.people.add.reason.thisPerson"),
        })}
        confirmLabel={t("admin.people.add.reason.confirm")}
        minLength={MIN_REASON}
        pending={create.isPending}
        errorMessage={create.userMessage}
        onConfirm={submit}
        onCancel={() => setReasonOpen(false)}
      />
    </div>
  );
}
