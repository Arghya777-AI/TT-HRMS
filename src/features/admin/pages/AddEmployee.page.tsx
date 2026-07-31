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
import { useQueryClient } from "@tanstack/react-query";
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
import {
  OTHER_FIELDS,
  OTHER_VALUE,
  OtherFieldError,
  applyResolvedOthers,
  resolveOtherMasters,
} from "../people/orgOther";
import { createEmployeeAccount, type AccountCreated } from "../api/account-create.api";
import { mutationUserMessage } from "@/shared/api/query";
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
  /**
   * The login provisioned alongside the employee, or the reason it could not be.
   *
   * SEPARATE FROM `created` ON PURPOSE. The employee row is committed by the time this is
   * attempted, so a provisioning failure must never look like a failed creation — the person
   * exists either way, and telling somebody "creation failed" when it did not is how a
   * duplicate gets added.
   */
  const [account, setAccount] = useState<AccountCreated | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  /** A failure creating an "Other" master, before any employee exists. */
  const [otherError, setOtherError] = useState<string | null>(null);
  const qc = useQueryClient();

  const step: WizardStepId = WIZARD_STEPS[stepIndex] ?? "identity";
  const isReview = step === "review";
  const groups = useMemo(() => wizardStepGroups(step, refs), [step, refs]);
  const everyGroup = useMemo(() => allWizardGroups(refs), [refs]);

  const create = useAuditedMutation<{ id: string; employee_code: string }, Record<string, unknown>>({
    /*
      ── THE ACCOUNT IS CREATED WITH THE EMPLOYEE ──────────────────────────────────

      Adding somebody used to write the master row and stop, because nothing ever called
      `employee-account-create`. The result was live confirmed employees with no profile, no
      email and no roles — unable to sign in, unable to be granted a role (the role screen
      lists ACCOUNTS), and unable to be face-enrolled, since consent and templates both hang
      off a profile. TT0016 was that, and it is what this removes.

      THE PROVISIONING IS DELIBERATELY NOT ALLOWED TO FAIL THE CREATION. By the time it runs
      the employee row is committed and cannot be rolled back from here, so a failure is
      CAPTURED and reported beside the new employee code rather than thrown. Throwing would
      show "could not be saved" over an employee who exists, and the next thing somebody does
      with that message is add the person again.

      It is attempted for anyone with an address to log in with. `employee-account-create`
      falls back to work email then personal email, so the address is passed only when the
      form supplied one — and when there is none at all the wizard says so and points at
      People › Access level, where the same action can be run with an email typed in.

      The role is `employee` by default: that is the function's own behaviour, not a choice
      made here.
    */
    mutationFn: async (input, reason) => {
      const row = await insertEmployee(input, reason);
      const loginEmail = String(input["work_email"] ?? input["personal_email"] ?? "").trim();
      try {
        const provisioned = await createEmployeeAccount({
          employeeId: row.id,
          ...(loginEmail !== "" ? { loginEmail } : {}),
          reason: `provisioning the portal login for ${row.employee_code}`,
        });
        setAccount(provisioned);
        setAccountError(null);
      } catch (err) {
        // The employee exists. Say what stopped the login and where to finish it.
        setAccount(null);
        setAccountError(mutationUserMessage(err));
      }
      return row;
    },
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

  /*
    "Other" on the four org lookups is resolved BEFORE the employee is inserted.

    Order is deliberate. `department_id` and friends are foreign keys, so the master row
    has to exist first — and resolving it first also means a failure (a duplicate code,
    a section with no department) leaves NOTHING created: the employee has not been
    written yet, so the wizard can put the message against the field and let the admin
    fix it. Doing it the other way round would give us an employee with a dangling
    placeholder and a message about a department.

    On success the org lookups are invalidated, which is what makes the new entry appear
    in every other screen's dropdown without a reload.
  */
  const submit = (reason: string) => {
    setOtherError(null);
    void (async () => {
      let resolved: Record<string, string> = {};
      if (OTHER_FIELDS.some((spec) => values[spec.field] === OTHER_VALUE)) {
        if (companyId === null) return;
        try {
          resolved = await resolveOtherMasters(
            { values, companyId, existingGradeCount: refs.grades.length },
            reason,
          );
        } catch (error) {
          if (error instanceof OtherFieldError) {
            setErrors((prev) => ({ ...prev, [error.field]: error.message }));
            // Placement is step 2; send them back to the field that failed.
            const failing = WIZARD_STEPS.findIndex((step) =>
              wizardStepGroups(step, refs).some((g) =>
                g.fields.some((f) => f.name === error.field),
              ),
            );
            if (failing >= 0) setStepIndex(failing);
          } else {
            setOtherError(mutationUserMessage(error));
          }
          return;
        }
        // What makes the new entry appear in every other dropdown without a reload.
        await qc.invalidateQueries({ queryKey: ["admin", "org"] });
      }

      const merged = applyResolvedOthers(values, resolved);
      const payload = coerceValues(everyGroup, merged, "create", null);
      // company_id is NOT NULL and is not a field the admin picks — there is one
      // employing entity per install and the wizard must not offer a wrong one.
      if (companyId !== null) payload["company_id"] = companyId;
      create.save(payload, reason);
    })();
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

          {/*
            THE LOGIN, beside the code, because this is the only moment the temporary password
            exists to be read. The function returns it once and nulls it on replay, so there is
            no screen to come back to — only a password reset.
          */}
          {account !== null ? (
            <div className="mt-5 rounded-lg border border-success/40 bg-success/5 p-4">
              <p className="text-sm font-medium">
                {t("admin.people.add.done.loginCreated", { email: account.account.email ?? "" })}
              </p>
              {account.tempPassword !== null ? (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.people.add.done.tempLabel")}
                  </p>
                  <code className="num mt-1 inline-block select-all rounded bg-muted px-2 py-1 text-lg">
                    {account.tempPassword}
                  </code>
                  <p className="mt-2 max-w-prose text-xs text-warning">
                    {t("admin.people.add.done.tempOnce")}
                  </p>
                </>
              ) : null}
            </div>
          ) : accountError !== null ? (
            <div className="mt-5 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="text-sm font-medium">{t("admin.people.add.done.loginPending")}</p>
              <p className="mt-1 max-w-prose text-xs text-muted-foreground">{accountError}</p>
              <p className="mt-2 max-w-prose text-xs text-muted-foreground">
                {t("admin.people.add.done.loginWhere")}
              </p>
            </div>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => void navigate(`/admin/people/${created.employee_code}`)}>
              {t("admin.people.add.done.open")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setCreated(null);
                setAccount(null);
                setAccountError(null);
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

      {/* An "Other" master that could not be created — a duplicate code, most likely.
          Shown here rather than against a field because the cause is the org master,
          not the value typed: nothing was created and nothing was saved. */}
      {otherError !== null ? (
        <div className="mt-4">
          <Notice tone="error">{otherError}</Notice>
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
