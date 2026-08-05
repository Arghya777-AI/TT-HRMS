/**
 * §2 · /admin/people/:code — Employee 360. The whole record, editable.
 *
 * Four rules this screen exists to hold:
 *
 *  1. EVERY EDIT IS AUDITED, AND SOME DEMAND A SENTENCE. Saving goes through
 *     `useAuditedMutation`, which sends an `X-Reason` header that Postgres turns
 *     into `app.reason` and the audit trigger writes one row PER CHANGED FIELD
 *     with the old and new value. Fields in `REASON_PROMPTING_COLUMNS` (salary
 *     policy, exit dates, payroll exclusion) open the reason dialog with the diff
 *     spelled out; routine fields carry a default reason.
 *  2. STALE FORMS DO NOT WIN. Every save carries `expectedUpdatedAt`, so if
 *     someone else edited this person while the tab was open the update matches
 *     zero rows and says so instead of overwriting them.
 *  3. IDENTIFIERS ARE MASKED, AND UNMASKING IS ITSELF AN EVENT. PAN, Aadhaar,
 *     UAN, ESIC and account numbers are read from the masked views — the client
 *     never holds the full value. Reveal calls a definer RPC that writes a
 *     per-subject row in the data-access log. The UI says so before you click.
 *  4. ONLY WHAT AN ADMIN MAY WRITE IS OFFERED. The tabs are built from
 *     `EDITABLE_*_COLUMNS` ∩ `adminEmployeeSchema` — a field an admin could
 *     write but not read back would render blank over a real value, which is a
 *     lie. Salary and statutory numbers are NOT on `employees` and are therefore
 *     read-only here by construction, not by choice.
 *
 * @route /admin/people/:code
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Eye, History, Save, ScanFace, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { dash } from "@/lib/format";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { FieldGroupSection } from "../components/FieldGroupSection";
import { EmployeeLinksPanel } from "../components/EmployeeLinksPanel";
import {
  changeSummary,
  coerceValues,
  validateFields,
  valuesFromRow,
  type FieldErrors,
  type FieldGroup,
  type FormValues,
} from "../masters/fields";
import {
  basicGroups,
  employmentGroups,
  exitGroups,
  paymentGroups,
  personalGroups,
  timePolicyGroups,
} from "../people/fields";
import {
  useAdminEmployee,
  useBankMasked,
  usePeopleRefs,
  useRevealBank,
  useRevealStatutory,
  useStatutoryMasked,
  useUpdateEmployee,
} from "../hooks/usePeople";
import {
  EMPLOYMENT_STATUS_LABELS,
  REASON_EMPLOYMENT_DETAILS,
  patchNeedsTypedReason,
  type EmploymentStatus,
} from "../api/employees.api";

const STATUS_CHIP: Readonly<Record<EmploymentStatus, StatusChipEntry>> = {
  pre_joining: { label: EMPLOYMENT_STATUS_LABELS.pre_joining, tone: "info" },
  active: { label: EMPLOYMENT_STATUS_LABELS.active, tone: "success" },
  on_probation: { label: EMPLOYMENT_STATUS_LABELS.on_probation, tone: "warn" },
  confirmed: { label: EMPLOYMENT_STATUS_LABELS.confirmed, tone: "success" },
  on_notice: { label: EMPLOYMENT_STATUS_LABELS.on_notice, tone: "warn" },
  suspended: { label: EMPLOYMENT_STATUS_LABELS.suspended, tone: "danger" },
  on_long_leave: { label: EMPLOYMENT_STATUS_LABELS.on_long_leave, tone: "info" },
  absconding: { label: EMPLOYMENT_STATUS_LABELS.absconding, tone: "danger" },
  exited: { label: EMPLOYMENT_STATUS_LABELS.exited, tone: "neutral" },
  retired: { label: EMPLOYMENT_STATUS_LABELS.retired, tone: "neutral" },
  rehired: { label: EMPLOYMENT_STATUS_LABELS.rehired, tone: "info" },
};

type TabId = "basic" | "employment" | "policy" | "payment" | "personal" | "exit";

const TABS: readonly TabId[] = ["basic", "employment", "policy", "payment", "personal", "exit"];

function tabLabel(id: TabId): string {
  switch (id) {
    case "basic":
      return t("admin.p360.tab.basic");
    case "employment":
      return t("admin.p360.tab.employment");
    case "policy":
      return t("admin.p360.tab.policy");
    case "payment":
      return t("admin.p360.tab.payment");
    case "personal":
      return t("admin.p360.tab.personal");
    case "exit":
      return t("admin.p360.tab.exit");
  }
}

export default function Employee360Page() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const refs = usePeopleRefs();

  const employee = useAdminEmployee(code);
  const row = employee.data ?? null;
  const employeeId = row?.id ?? null;

  const statutory = useStatutoryMasked(employeeId);
  const bank = useBankMasked(employeeId);
  const revealStat = useRevealStatutory(employeeId);
  const revealBank = useRevealBank(employeeId);
  const update = useUpdateEmployee(code);

  const [tab, setTab] = useState<TabId>("basic");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [reasonOpen, setReasonOpen] = useState(false);
  const [revealTarget, setRevealTarget] = useState<"statutory" | "bank" | null>(null);

  const groups: readonly FieldGroup[] = useMemo(() => {
    switch (tab) {
      case "basic":
        return basicGroups();
      case "employment":
        return employmentGroups(refs, employeeId ?? undefined);
      case "policy":
        return timePolicyGroups(refs);
      case "payment":
        return paymentGroups(refs);
      case "personal":
        return personalGroups();
      case "exit":
        return exitGroups();
    }
  }, [tab, refs, employeeId]);

  /** Server values for this tab; `edits` overlays only what was touched. */
  const original = useMemo<FormValues>(
    () => valuesFromRow(groups, row as Readonly<Record<string, unknown>> | null),
    [groups, row],
  );
  const values = useMemo<FormValues>(() => ({ ...original, ...edits }), [original, edits]);

  const dirtyFields = useMemo(
    () => Object.keys(edits).filter((k) => (edits[k] ?? "") !== (original[k] ?? "")),
    [edits, original],
  );
  const isDirty = dirtyFields.length > 0;

  const setValue = (name: string, value: string) => {
    setEdits((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => {
      if (prev[name] === undefined) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const discard = () => {
    setEdits({});
    setErrors({});
  };

  const patch = useMemo(
    () => coerceValues(groups, values, "edit", original),
    [groups, values, original],
  );

  const needsTypedReason = patchNeedsTypedReason(patch);

  const attemptSave = () => {
    const found = validateFields(groups, values, "edit");
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (Object.keys(patch).length === 0) return;
    if (needsTypedReason) {
      setReasonOpen(true);
      return;
    }
    commit(REASON_EMPLOYMENT_DETAILS);
  };

  const commit = (reason: string) => {
    if (employeeId === null || row === null) return;
    update.save(
      {
        employeeId,
        patch,
        // Optimistic lock: the row we read is the row we are allowed to change.
        expectedUpdatedAt: row.updated_at,
      },
      reason,
    );
    setReasonOpen(false);
    setEdits({});
  };

  const revealed = revealTarget === "statutory" ? revealStat : revealBank;

  return (
    <div className="container py-6">
      <StateBoundary
        loading={employee.isPending}
        error={employee.error}
        onRetry={() => void employee.refetch()}
      >
        {row === null ? null : (
          <>
            <PageHeader
              icon={UserRound}
              title={row.display_name}
              subtitle={t("admin.p360.subtitle", {
                code: row.employee_code,
                designation: dash(row.designation_name),
                department: dash(row.department_name),
              })}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    SAVE AT THE TOP AS WELL AS THE BOTTOM.

                    The record is long — identity, employment, statutory, timekeeping — and
                    the only Save was the sticky bar at the foot of the page. Somebody who
                    ticks a box in the first section has to travel to the other end of the
                    form to commit it, and the fields they just changed leave the screen on
                    the way.

                    It is the SAME handler and the same disabled state as the bottom bar, not
                    a second save path: two buttons that could disagree about whether a save
                    is in flight is how you get a double submit. It appears only when
                    something is actually dirty, so the header does not carry a button that
                    does nothing, and it leads with the pending count for the same reason the
                    bottom bar does — "2 changes" is the fact that makes the button
                    meaningful.
                  */}
                  {isDirty ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        {t("admin.p360.pending", { n: String(dirtyFields.length) })}
                      </span>
                      <Button variant="ghost" size="sm" onClick={discard} disabled={update.isPending}>
                        {t("admin.p360.discard")}
                      </Button>
                      <Button size="sm" onClick={attemptSave} disabled={update.isPending}>
                        <Save className="mr-2 size-4" aria-hidden />
                        {update.isPending ? t("admin.p360.saving") : t("admin.p360.save")}
                      </Button>
                    </>
                  ) : null}
                  <StatusChip status={row.employment_status} map={STATUS_CHIP} />
                  {/*
                    ENROL FACE, from the employee you are already looking at.
                    The console lives at /admin/kiosk/enrolment and had no
                    navigation entry at all, so the only way to reach it was to
                    type the URL. The admin's actual task starts here — "pick an
                    employee, register their face" — so the button belongs on the
                    employee, and it carries the code so the console can open on
                    the right person.
                  */}
                  <Button asChild>
                    <Link
                      to={`/admin/kiosk/enrolment?employee=${encodeURIComponent(row.employee_code)}`}
                      title={t("admin.emp360.enrolFace.hint")}
                    >
                      <ScanFace className="mr-2 size-4" aria-hidden />
                      {t("admin.emp360.enrolFace")}
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link to={`/admin/people/${row.employee_code}/audit`}>
                      <History className="mr-2 size-4" aria-hidden />
                      {t("admin.p360.history")}
                    </Link>
                  </Button>
                  <Button variant="ghost" onClick={() => void navigate("/admin/people")}>
                    <ArrowLeft className="mr-2 size-4" aria-hidden />
                    {t("admin.p360.backToDirectory")}
                  </Button>
                </div>
              }
            />

            {/* Facts the database owns and nobody edits here. */}
            <dl className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                [t("admin.p360.fact.code"), row.employee_code],
                [t("admin.p360.fact.joined"), fmtCivilDate(row.date_of_join)],
                [t("admin.p360.fact.manager"), dash(row.reporting_manager_name)],
                [t("admin.p360.fact.updated"), fmtDateTime(row.updated_at)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="num truncate text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>

            {/* Tabs */}
            <nav className="mt-4 flex flex-wrap gap-2" aria-label={t("admin.p360.tabsLabel")}>
              {TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (isDirty) return;
                    setTab(id);
                    setErrors({});
                  }}
                  disabled={isDirty && id !== tab}
                  aria-current={id === tab ? "page" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    id === tab
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                    isDirty && id !== tab && "cursor-not-allowed opacity-50",
                  )}
                >
                  {tabLabel(id)}
                </button>
              ))}
            </nav>

            {isDirty ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("admin.p360.dirtyLock")}</p>
            ) : null}

            {/*
              EVERY SCREEN ABOUT THIS PERSON, above the tabs, because it is navigation
              rather than another tab of fields. Nine admin screens can be scoped to one
              employee and the record linked to none of them — an admin asking "why was she
              late" had to leave, find Attendance, find the date, filter to her, and come
              back. Each link opens already filtered.
            */}
            {row !== null ? (
              <div className="mt-4">
                <EmployeeLinksPanel
                  employeeCode={row.employee_code}
                  employeeId={row.id}
                  displayName={row.display_name}
                />
              </div>
            ) : null}

            {/* The masked identifiers live on the Payment tab, read-only. */}
            {tab === "payment" ? (
              <div className="mt-4 space-y-4">
                <section className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-display text-sm font-semibold">
                        {t("admin.p360.statutory.title")}
                      </h3>
                      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                        {t("admin.p360.statutory.hint")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setRevealTarget("statutory")}
                      disabled={employeeId === null}
                    >
                      <Eye className="mr-2 size-4" aria-hidden />
                      {t("admin.p360.reveal")}
                    </Button>
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      [t("admin.p360.statutory.pan"), statutory.data?.pan_masked],
                      [t("admin.p360.statutory.aadhaar"), statutory.data?.aadhaar_masked],
                      [t("admin.p360.statutory.uan"), statutory.data?.uan_masked],
                      [t("admin.p360.statutory.esi"), statutory.data?.esi_number_masked],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="num text-sm font-medium">{dash(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {revealStat.data !== undefined ? (
                    <div className="mt-4">
                      <Notice tone="warning">
                        {t("admin.p360.revealed.statutory", {
                          pan: dash(revealStat.data.pan),
                          aadhaar: dash(revealStat.data.aadhaar_number),
                        })}
                      </Notice>
                    </div>
                  ) : null}
                </section>

                <section className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-display text-sm font-semibold">
                        {t("admin.p360.bank.title")}
                      </h3>
                      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                        {t("admin.p360.bank.hint")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setRevealTarget("bank")}
                      disabled={employeeId === null}
                    >
                      <Eye className="mr-2 size-4" aria-hidden />
                      {t("admin.p360.reveal")}
                    </Button>
                  </div>
                  {(bank.data ?? []).length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">{t("admin.p360.bank.none")}</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {(bank.data ?? []).map((b) => (
                        <li key={b.id} className="rounded-md border p-3 text-sm">
                          <span className="font-medium">{dash(b.bank_name)}</span>
                          <span className="num ml-2 text-muted-foreground">
                            ••••{dash(b.account_number_last4)}
                          </span>
                          <span className="num ml-2 text-muted-foreground">{dash(b.ifsc)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {revealBank.data !== undefined ? (
                    <div className="mt-4">
                      <Notice tone="warning">
                        {t("admin.p360.revealed.bank", {
                          n: String(revealBank.data.length),
                        })}
                      </Notice>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}

            {/* Editable field groups for the active tab. */}
            <div className="mt-4 space-y-4">
              {groups.map((group) => (
                <FieldGroupSection
                  key={group.title}
                  group={group}
                  values={values}
                  errors={errors}
                  mode="edit"
                  onChange={setValue}
                  disabled={update.isPending}
                />
              ))}
            </div>

            {update.userMessage !== null && !reasonOpen ? (
              <div className="mt-4">
                <Notice tone="error">{update.userMessage}</Notice>
              </div>
            ) : null}

            {/* `bottom-[max(...)]`: the action bar sticks to the viewport's bottom edge, which on a
                phone with a home indicator is behind it — 16px was not enough to clear the swipe
                area, so Save fought the gesture and lost. */}
            {isDirty ? (
              <div className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/95 p-4 shadow-lg backdrop-blur">
                <p className="text-sm">
                  {t("admin.p360.pending", { n: String(dirtyFields.length) })}
                  {needsTypedReason ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <ShieldCheck className="size-3.5" aria-hidden />
                      {t("admin.p360.needsReason")}
                    </span>
                  ) : null}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={discard} disabled={update.isPending}>
                    {t("admin.p360.discard")}
                  </Button>
                  <Button onClick={attemptSave} disabled={update.isPending}>
                    <Save className="mr-2 size-4" aria-hidden />
                    {update.isPending ? t("admin.p360.saving") : t("admin.p360.save")}
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Reason for a sensitive edit — with the diff spelled out. */}
            <ReasonDialog
              open={reasonOpen}
              title={t("admin.p360.reason.title", { name: row.display_name })}
              // changeSummary returns one line per changed field ("Mobile:
              // 9880010004 → 9880019999"); the dialog takes a single sentence.
              description={changeSummary(groups, original, values).join(" · ")}
              confirmLabel={t("admin.p360.reason.confirm")}
              minLength={15}
              pending={update.isPending}
              errorMessage={update.userMessage}
              onConfirm={commit}
              onCancel={() => setReasonOpen(false)}
            />

            {/* Reason for an audited reveal. */}
            <ReasonDialog
              open={revealTarget !== null}
              title={
                revealTarget === "bank"
                  ? t("admin.p360.revealBank.title", { name: row.display_name })
                  : t("admin.p360.revealStat.title", { name: row.display_name })
              }
              description={t("admin.p360.reveal.description")}
              confirmLabel={t("admin.p360.reveal.confirm")}
              minLength={15}
              pending={revealed.isPending}
              errorMessage={revealed.userMessage}
              onConfirm={(reason) => {
                revealed.save(undefined, reason);
                setRevealTarget(null);
              }}
              onCancel={() => setRevealTarget(null)}
            />
          </>
        )}
      </StateBoundary>
    </div>
  );
}
