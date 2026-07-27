/**
 * A-KIOSK-09 · /admin/kiosk/purge — irreversible biometric erasure
 * (spec-admin §5.10, §13.4 retention class `biometric_exit_plus_30d`, DPDP Act
 * 2023 §12 erasure).
 *
 * This is the most destructive button in the product, so the screen is built
 * around what the DEPLOYED `face-template-admin` op `purge` actually does and
 * actually demands. It:
 *   * requires `super_admin` AND `biometric.template.purge`, which migration 050
 *     seeds with `requires_step_up`, so an aal1 session is refused with
 *     `MFA_STEP_UP_REQUIRED` and re-tried after the authenticator code;
 *   * requires `confirm_employee_code` to EQUAL `employees.employee_code` and
 *     answers a mismatch with `PURGE_CONFIRMATION_MISMATCH` — the typed
 *     confirmation is enforced by the server, not by this form;
 *   * requires a reason of at least 20 characters naming the request or incident;
 *   * overwrites the live descriptor with zeros, overwrites the ARCHIVED
 *     descriptors in `secure.face_template_history` (a purge that leaves the
 *     archive intact is not a purge), removes the capture objects from the private
 *     bucket, clears `employees.face_enrolled_at` when nothing active remains, and
 *     cancels any pending enrolment request;
 *   * writes a `purge_biometric` hash-chain row and a `data_access_log` row for
 *     the subject inside the same transaction.
 *
 * TWO-PERSON CONTROL, HONESTLY. §16 wants four eyes on a biometric purge. No
 * deployed endpoint accepts a second approver for it, so the second super admin
 * is named here — chosen from the live `user_roles` grants, never free text, and
 * never the actor themselves — and their name is written INTO the audited reason
 * by `purgeReason()`. That makes the second pair of eyes evidence in the
 * immutable chain rather than a checkbox this screen forgets. The screen says as
 * much, because claiming a server-enforced counter-signature would be a lie.
 *
 * What is NOT here: any way to see a descriptor, a face, or a template hash. No
 * client role can select `descriptor` at all, and a hash of an embedding is still
 * a biometric identifier.
 *
 * @route /admin/kiosk/purge
 */
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Fingerprint, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { newIdempotencyKey } from "@/shared/api/invoke";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { useAuth } from "@/app/auth/AuthProvider";
import type { FaceTemplate } from "../api/kiosk.api";
import {
  PURGE_REASON_MIN_LENGTH,
  purgeLegalBases,
  type PurgeLegalBasis,
  type PurgeResult,
} from "../api/kiosk-governance.api";
import { usePurgeMutation, usePurgeRegister } from "../hooks/useKioskGovernance";
import { useProfileDirectory, useRoleGrants } from "../hooks/useSettingsExtra";
import { templateStateChip } from "../kiosk-display";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField, type SelectOption } from "../components/Field";
import { KioskSectionNav } from "../components/KioskSectionNav";

const BASIS_LABEL: Readonly<Record<PurgeLegalBasis, MessageKey>> = {
  dpdp_erasure_request: "admin.kiosk.purge.basis.dpdp",
  exit_retention_elapsed: "admin.kiosk.purge.basis.exit",
  enrolled_in_error: "admin.kiosk.purge.basis.error",
};

/** One employee's template versions, as the preview needs them. */
interface PurgeSubject {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly displayName: string;
  readonly versions: readonly FaceTemplate[];
  /** Versions whose descriptor still exists — exactly what a purge destroys. */
  readonly live: readonly FaceTemplate[];
  readonly alreadyPurged: readonly FaceTemplate[];
  readonly hasActive: boolean;
  readonly pendingRequest: boolean;
  readonly consentVersion: string | null;
  readonly consentGrantedAt: string | null;
  readonly consentWithdrawnAt: string | null;
}

function buildSubjects(templates: readonly FaceTemplate[]): readonly PurgeSubject[] {
  const byEmployee = new Map<string, FaceTemplate[]>();
  for (const template of templates) {
    const bucket = byEmployee.get(template.employeeId);
    if (bucket === undefined) byEmployee.set(template.employeeId, [template]);
    else bucket.push(template);
  }
  const subjects: PurgeSubject[] = [];
  for (const [employeeId, rows] of byEmployee) {
    // Newest version first: that is the one an admin recognises.
    const versions = [...rows].sort((a, b) => b.version - a.version);
    const first = versions[0];
    if (first === undefined) continue;
    const newestConsent = versions.find((row) => row.consent.grantedAt !== null) ?? first;
    subjects.push({
      employeeId,
      employeeCode: first.employeeCode,
      displayName: first.displayName ?? first.employeeCode,
      versions,
      live: versions.filter((row) => row.purgedAt === null),
      alreadyPurged: versions.filter((row) => row.purgedAt !== null),
      hasActive: versions.some((row) => row.state === "active"),
      pendingRequest: versions.some((row) => row.enrolmentRequest?.status === "pending"),
      consentVersion: newestConsent.consent.version,
      consentGrantedAt: newestConsent.consent.grantedAt,
      consentWithdrawnAt: newestConsent.consent.withdrawnAt,
    });
  }
  return subjects.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode, "en-IN"));
}

export default function TemplatePurgePage() {
  const { can, user } = useAuth();
  const isSuper = can("admin.super");

  const [loaded, setLoaded] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [typedCode, setTypedCode] = useState("");
  const [basis, setBasis] = useState<PurgeLegalBasis>("dpdp_erasure_request");
  const [counterSignerId, setCounterSignerId] = useState("");
  const [attested, setAttested] = useState(false);
  const [result, setResult] = useState<PurgeResult | null>(null);

  const register = usePurgeRegister(loaded && isSuper);
  const grants = useRoleGrants();
  const profiles = useProfileDirectory();
  const purge = usePurgeMutation();
  const stepUp = useStepUp();

  /**
   * One idempotency key per (subject, scope) confirmation. Reused across the
   * step-up retry so the SAME purge cannot be recorded twice, and dropped once
   * the purge succeeds.
   */
  const keys = useRef(new Map<string, string>());
  function keyFor(scope: string): string {
    const existing = keys.current.get(scope);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    keys.current.set(scope, fresh);
    return fresh;
  }

  const subjects = useMemo(
    () => buildSubjects(register.data?.templates ?? []),
    [register.data?.templates],
  );

  const subject = subjects.find((row) => row.employeeId === employeeId) ?? null;

  const subjectOptions: SelectOption[] = useMemo(
    () =>
      subjects.map((row) => ({
        value: row.employeeId,
        label: t("admin.kiosk.purge.subject.option", {
          name: row.displayName,
          code: row.employeeCode,
          live: formatNumber(row.live.length),
        }),
      })),
    [subjects],
  );

  /**
   * The other super admins, from `user_roles` (live grants only) joined to the
   * profile directory for their names. The actor is excluded: a person cannot be
   * their own second pair of eyes.
   */
  const counterSigners: SelectOption[] = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const profile of profiles.data ?? []) nameById.set(profile.id, profile.full_name);
    const seen = new Set<string>();
    const options: SelectOption[] = [];
    for (const grant of grants.data ?? []) {
      if (grant.role !== "super_admin" || grant.revoked_at !== null) continue;
      if (grant.user_id === user?.id) continue;
      if (seen.has(grant.user_id)) continue;
      seen.add(grant.user_id);
      options.push({
        value: grant.user_id,
        label: nameById.get(grant.user_id) ?? t("admin.kiosk.purge.counter.unnamed"),
      });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label, "en-IN"));
  }, [grants.data, profiles.data, user?.id]);

  const counterSignerName =
    counterSigners.find((option) => option.value === counterSignerId)?.label ?? "";

  const peersReadable = grants.isSuccess && profiles.isSuccess;
  const codeMatches = subject !== null && typedCode === subject.employeeCode;
  const hasSomethingToPurge = subject !== null && subject.live.length > 0;

  /** The FIRST unmet gate, so a disabled button always says why (DR-06). */
  const blockedBecause: MessageKey | null = !isSuper
    ? "admin.kiosk.purge.block.superOnly"
    : subject === null
      ? "admin.kiosk.purge.block.noSubject"
      : !hasSomethingToPurge
        ? "admin.kiosk.purge.block.nothingLeft"
        : !codeMatches
          ? "admin.kiosk.purge.block.code"
          : !peersReadable
            ? "admin.kiosk.purge.block.peersUnreadable"
            : counterSigners.length === 0
              ? "admin.kiosk.purge.block.noPeer"
              : counterSignerId === ""
                ? "admin.kiosk.purge.block.counter"
                : !attested
                  ? "admin.kiosk.purge.block.attest"
                  : null;

  function resetConfirmation(): void {
    setTypedCode("");
    setCounterSignerId("");
    setAttested(false);
  }

  /**
   * Run the purge, upgrading the session and retrying ONCE on the server's
   * step-up refusal. The retry reuses the same idempotency key and the same
   * reason, so the second attempt is the same act and not a second one.
   */
  async function runPurge(
    scope: "employee" | "template",
    templateId: string | undefined,
    reason: string,
  ): Promise<void> {
    if (subject === null) return;
    const input = {
      scope,
      employeeId: subject.employeeId,
      ...(templateId !== undefined ? { templateId } : {}),
      confirmEmployeeCode: typedCode,
      idempotencyKey: keyFor(`${scope}:${templateId ?? subject.employeeId}`),
      basis,
      counterSignerName,
    };
    let purged: PurgeResult;
    try {
      purged = await purge.saveAsync(input, reason);
    } catch (error) {
      if (!isStepUpRequired(error)) throw error;
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) return;
      purged = await purge.saveAsync(input, reason);
    }
    keys.current.delete(`${scope}:${templateId ?? subject.employeeId}`);
    setResult(purged);
    resetConfirmation();
    toast.success(
      t("admin.kiosk.purge.done", {
        code: purged.employeeCode,
        versions: formatNumber(purged.purgedCount),
      }),
    );
  }

  const versionColumns: DataGridColumn<FaceTemplate>[] = [
    {
      key: "version",
      header: t("admin.kiosk.purge.col.version"),
      align: "right",
      width: "6rem",
      sortable: true,
      render: (row) => <span className="num">{formatNumber(row.version)}</span>,
    },
    {
      key: "state",
      header: t("admin.kiosk.purge.col.state"),
      width: "12rem",
      render: (row) => <StatusChip status={row.state} map={templateStateChip(row.state)} />,
    },
    {
      key: "samples",
      header: t("admin.kiosk.purge.col.samples"),
      align: "right",
      width: "7rem",
      hideBelow: "md",
      render: (row) => <span className="num">{formatNumber(row.sampleCount)}</span>,
    },
    {
      key: "enrolledAt",
      header: t("admin.kiosk.purge.col.enrolled"),
      hideBelow: "md",
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="num text-sm">{dash(row.enrolledAt, fmtDateTime)}</span>
          <span className="text-xs text-muted-foreground">{dash(row.enrolledByName)}</span>
        </span>
      ),
    },
    {
      key: "purgedAt",
      header: t("admin.kiosk.purge.col.purged"),
      hideBelow: "lg",
      render: (row) =>
        row.purgedAt === null ? (
          <Badge variant="warning">{t("admin.kiosk.purge.state.present")}</Badge>
        ) : (
          <span className="num text-sm">{fmtDateTime(row.purgedAt)}</span>
        ),
    },
    {
      key: "actions",
      header: t("admin.kiosk.purge.col.actions"),
      align: "right",
      width: "12rem",
      render: (row) => {
        if (row.purgedAt !== null) {
          return (
            <span className="text-xs text-muted-foreground">
              {t("admin.kiosk.purge.alreadyPurged")}
            </span>
          );
        }
        return (
          <ReasonActionButton
            label={t("admin.kiosk.purge.action.version")}
            variant="outline"
            minLength={PURGE_REASON_MIN_LENGTH}
            // THE ONE PLACE THE WORDS STILL MATTER. Erasing a biometric is
            // irreversible and the CIRCUMSTANCE cannot be derived from the action:
            // a DPDP erasure request, a departure, or a mistake are the same
            // operation and very different records. Everything routine now fires
            // without a prompt; this deliberately does not.
            requireTypedReason
            disabled={blockedBecause !== null}
            {...(blockedBecause !== null ? { disabledHint: t(blockedBecause) } : {})}
            title={t("admin.kiosk.purge.version.title", {
              version: formatNumber(row.version),
              code: row.employeeCode,
            })}
            description={t("admin.kiosk.purge.version.description", {
              basis: t(BASIS_LABEL[basis]),
              counter: counterSignerName,
            })}
            confirmLabel={t("admin.kiosk.purge.confirmLabel")}
            onConfirm={(reason) => runPurge("template", row.templateId, reason)}
          />
        );
      },
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("admin.kiosk.purge.title")}
        subtitle={t("admin.kiosk.purge.subtitle")}
      />

      <KioskSectionNav />

      <Notice tone="error">
        <strong className="font-medium">{t("admin.kiosk.purge.warning.title")}</strong>{" "}
        {t("admin.kiosk.purge.warning.body")}
      </Notice>

      <p className="mt-3 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-medium text-foreground">
            {t("admin.kiosk.purge.fourEyes.title")}
          </strong>{" "}
          {t("admin.kiosk.purge.fourEyes.hint")}
        </span>
      </p>

      {!isSuper ? (
        <div className="mt-4">
          <EmptyState
            icon={ShieldAlert}
            title={t("admin.kiosk.purge.superOnly.title")}
            hint={t("admin.kiosk.purge.superOnly.hint")}
            action={
              <Button variant="outline" asChild>
                <Link to="/admin/kiosk/templates">{t("admin.kiosk.templates.title")}</Link>
              </Button>
            }
          />
        </div>
      ) : !loaded ? (
        <div className="mt-4">
          <EmptyState
            icon={Fingerprint}
            title={t("admin.kiosk.purge.load.title")}
            hint={t("admin.kiosk.purge.load.hint")}
            action={<Button onClick={() => setLoaded(true)}>{t("admin.kiosk.purge.load.action")}</Button>}
          />
        </div>
      ) : isStepUpRequired(register.error) ? (
        <div className="mt-4">
          <EmptyState
            icon={ShieldAlert}
            title={t("admin.kiosk.purge.stepUp.title")}
            hint={t("admin.kiosk.purge.stepUp.hint")}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  void (async () => {
                    const upgraded = await stepUp.ensureAal2();
                    if (upgraded) void register.refetch();
                  })();
                }}
              >
                {t("admin.kiosk.purge.stepUp.action")}
              </Button>
            }
          />
        </div>
      ) : (
        <StateBoundary
          loading={register.isLoading}
          error={register.error ?? undefined}
          onRetry={() => void register.refetch()}
          partialError={grants.error ?? profiles.error ?? undefined}
          partialLabel={t("admin.kiosk.purge.partial")}
          isEmpty={register.isSuccess && subjects.length === 0}
          empty={
            <EmptyState
              icon={Fingerprint}
              title={t("admin.kiosk.purge.empty.title")}
              hint={t("admin.kiosk.purge.empty.hint")}
              action={
                <Button variant="outline" asChild>
                  <Link to="/admin/kiosk/enrolment">{t("admin.kiosk.enrolment.title")}</Link>
                </Button>
              }
            />
          }
          skeletonRows={5}
        >
          {result !== null ? (
            <div className="mt-4">
              <Notice
                tone="success"
                action={
                  <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                    {t("admin.common.dismiss")}
                  </Button>
                }
              >
                <span className="flex flex-col gap-1">
                  <strong className="font-medium">
                    {t("admin.kiosk.purge.receipt.title", {
                      code: result.employeeCode,
                      name: dash(result.displayName),
                    })}
                  </strong>
                  <span>
                    {t("admin.kiosk.purge.receipt.body", {
                      versions: formatNumber(result.purgedCount),
                      numbers: result.purgedVersions.map((v) => formatNumber(v)).join(", "),
                      archive: formatNumber(result.archiveRowsZeroed),
                      captures: formatNumber(result.captureObjects),
                    })}
                  </span>
                  {!result.capturesRemoved ? (
                    <span className="text-warning">
                      {t("admin.kiosk.purge.receipt.capturesLeft")}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {t("admin.kiosk.purge.receipt.audit")}
                  </span>
                </span>
              </Notice>
            </div>
          ) : null}

          <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label={t("admin.kiosk.purge.kpi.enrolled")}
              value={formatNumber(subjects.length)}
              hint={t("admin.kiosk.purge.kpi.enrolledHint")}
            />
            <KpiTile
              label={t("admin.kiosk.purge.kpi.versions")}
              value={formatNumber(register.data?.total ?? 0)}
              hint={t("admin.kiosk.purge.kpi.versionsHint")}
            />
            <KpiTile
              label={t("admin.kiosk.purge.kpi.peers")}
              value={formatNumber(counterSigners.length)}
              tone={counterSigners.length > 0 ? "success" : "danger"}
              hint={t("admin.kiosk.purge.kpi.peersHint")}
            />
          </section>

          <section className="mt-6 rounded-lg border bg-card p-4">
            <h2 className="font-display text-lg font-semibold">
              {t("admin.kiosk.purge.step1.title")}
            </h2>
            <p className="mb-3 mt-1 text-sm text-muted-foreground">
              {t("admin.kiosk.purge.step1.hint")}
            </p>
            <SelectField
              label={t("admin.kiosk.purge.field.subject")}
              value={employeeId}
              options={subjectOptions}
              placeholder={t("admin.kiosk.purge.field.subjectPlaceholder")}
              onChange={(value) => {
                setEmployeeId(value);
                resetConfirmation();
                setResult(null);
              }}
              hint={t("admin.kiosk.purge.field.subjectHint")}
            />
          </section>

          {subject !== null ? (
            <>
              <section className="mt-6">
                <h2 className="font-display text-lg font-semibold">
                  {t("admin.kiosk.purge.step2.title", { code: subject.employeeCode })}
                </h2>
                <p className="mb-3 mt-1 text-sm text-muted-foreground">
                  {t("admin.kiosk.purge.step2.hint")}
                </p>

                <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <KpiTile
                    label={t("admin.kiosk.purge.preview.live")}
                    value={formatNumber(subject.live.length)}
                    tone={subject.live.length > 0 ? "danger" : "neutral"}
                    hint={t("admin.kiosk.purge.preview.liveHint")}
                  />
                  <KpiTile
                    label={t("admin.kiosk.purge.preview.purged")}
                    value={formatNumber(subject.alreadyPurged.length)}
                    hint={t("admin.kiosk.purge.preview.purgedHint")}
                  />
                  <KpiTile
                    label={t("admin.kiosk.purge.preview.gate")}
                    value={
                      subject.hasActive
                        ? t("admin.kiosk.purge.preview.gateOpen")
                        : t("admin.kiosk.purge.preview.gateShut")
                    }
                    tone={subject.hasActive ? "warn" : "neutral"}
                    hint={t("admin.kiosk.purge.preview.gateHint")}
                  />
                  <KpiTile
                    label={t("admin.kiosk.purge.preview.consent")}
                    value={
                      subject.consentWithdrawnAt !== null
                        ? t("admin.kiosk.purge.preview.consentWithdrawn")
                        : subject.consentGrantedAt !== null
                          ? t("admin.kiosk.purge.preview.consentOnFile")
                          : dash(null)
                    }
                    hint={t("admin.kiosk.purge.preview.consentHint")}
                  />
                </div>

                <DataGrid
                  columns={versionColumns}
                  rows={subject.versions}
                  rowKey={(row) => row.templateId}
                  pageSize={10}
                />

                <ul className="mt-3 list-disc space-y-1 rounded-md border bg-card px-6 py-3 text-sm text-muted-foreground">
                  <li>
                    {t("admin.kiosk.purge.effect.descriptors", {
                      versions: formatNumber(subject.live.length),
                    })}
                  </li>
                  <li>{t("admin.kiosk.purge.effect.archive")}</li>
                  <li>{t("admin.kiosk.purge.effect.captures")}</li>
                  <li>{t("admin.kiosk.purge.effect.enrolledAt")}</li>
                  <li>
                    {subject.pendingRequest
                      ? t("admin.kiosk.purge.effect.pendingCancelled")
                      : t("admin.kiosk.purge.effect.noPending")}
                  </li>
                  <li>
                    {t("admin.kiosk.purge.effect.survives", {
                      version: dash(subject.consentVersion),
                    })}
                  </li>
                  <li>{t("admin.kiosk.purge.effect.audit")}</li>
                </ul>
              </section>

              <section className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                <h2 className="font-display text-lg font-semibold">
                  {t("admin.kiosk.purge.step3.title")}
                </h2>
                <p className="mb-4 mt-1 text-sm text-muted-foreground">
                  {t("admin.kiosk.purge.step3.hint", { code: subject.employeeCode })}
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label={t("admin.kiosk.purge.field.basis")}
                    value={basis}
                    options={purgeLegalBases.map((value) => ({
                      value,
                      label: t(BASIS_LABEL[value]),
                    }))}
                    onChange={(value) => setBasis(value as PurgeLegalBasis)}
                    hint={t("admin.kiosk.purge.field.basisHint")}
                    required
                  />
                  <TextField
                    label={t("admin.kiosk.purge.field.code")}
                    value={typedCode}
                    onChange={setTypedCode}
                    placeholder={subject.employeeCode}
                    hint={t("admin.kiosk.purge.field.codeHint", { code: subject.employeeCode })}
                    error={
                      typedCode !== "" && !codeMatches
                        ? t("admin.kiosk.purge.field.codeMismatch")
                        : null
                    }
                    required
                  />
                  <SelectField
                    label={t("admin.kiosk.purge.field.counter")}
                    value={counterSignerId}
                    options={counterSigners}
                    placeholder={t("admin.kiosk.purge.field.counterPlaceholder")}
                    onChange={setCounterSignerId}
                    hint={t("admin.kiosk.purge.field.counterHint")}
                    error={
                      peersReadable && counterSigners.length === 0
                        ? t("admin.kiosk.purge.field.counterNone")
                        : !peersReadable
                          ? t("admin.kiosk.purge.field.counterUnreadable")
                          : null
                    }
                    disabled={!peersReadable || counterSigners.length === 0}
                    required
                  />
                  <label className="flex items-start gap-2 self-end text-sm">
                    <input
                      type="checkbox"
                      checked={attested}
                      onChange={(event) => setAttested(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-input text-primary"
                    />
                    <span>
                      {t("admin.kiosk.purge.field.attest", {
                        counter:
                          counterSignerName === ""
                            ? t("admin.kiosk.purge.field.counterPlaceholder")
                            : counterSignerName,
                      })}
                    </span>
                  </label>
                </div>

                {purge.userMessage !== null ? (
                  <div className="mt-4">
                    <Notice tone="error">{purge.userMessage}</Notice>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <ReasonActionButton
                    label={t("admin.kiosk.purge.action.all", {
                      versions: formatNumber(subject.live.length),
                    })}
                    variant="destructive"
                    size="default"
                    minLength={PURGE_REASON_MIN_LENGTH}
            // THE ONE PLACE THE WORDS STILL MATTER. Erasing a biometric is
            // irreversible and the CIRCUMSTANCE cannot be derived from the action:
            // a DPDP erasure request, a departure, or a mistake are the same
            // operation and very different records. Everything routine now fires
            // without a prompt; this deliberately does not.
            requireTypedReason
                    disabled={blockedBecause !== null || purge.isPending}
                    {...(blockedBecause !== null ? { disabledHint: t(blockedBecause) } : {})}
                    title={t("admin.kiosk.purge.all.title", {
                      name: subject.displayName,
                      code: subject.employeeCode,
                    })}
                    description={t("admin.kiosk.purge.all.description", {
                      versions: formatNumber(subject.live.length),
                      basis: t(BASIS_LABEL[basis]),
                      counter: counterSignerName,
                    })}
                    confirmLabel={t("admin.kiosk.purge.confirmLabel")}
                    onConfirm={(reason) => runPurge("employee", undefined, reason)}
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("admin.kiosk.purge.reasonFloor", { min: PURGE_REASON_MIN_LENGTH })}
                  </span>
                </div>
              </section>
            </>
          ) : null}
        </StateBoundary>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="ghost" asChild>
          <Link to="/admin/kiosk/templates">{t("admin.kiosk.templates.title")}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/admin/kiosk/consent">{t("admin.kiosk.consent.title")}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/admin/audit/retention">{t("admin.kiosk.purge.action.retention")}</Link>
        </Button>
      </div>

      {stepUp.dialog}
    </div>
  );
}
