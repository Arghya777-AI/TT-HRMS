/**
 * A-KIOSK-04 · /admin/kiosk/templates — face template METADATA (spec-admin §5.10).
 *
 * What this screen may show, and why the list is not even loaded until asked:
 *
 *  * `secure.face_templates` has zero grants to `authenticated` and no
 *    PostgREST-reachable view. The only path is the `face-template-admin` edge
 *    function, which lists its columns explicitly and never sends `descriptor`.
 *  * The function writes a `data_access` row of kind `bulk_view` for every list
 *    call, so opening this screen is itself an audited biometric access. It is
 *    therefore behind an explicit "show metadata" action rather than fired on
 *    navigation — an audit row that says an admin looked at biometrics should
 *    mean they looked, not that they mistyped a URL.
 *  * Quality is rendered as good / fair / poor, the band the function computes.
 *    The underlying score and the inter-sample distance are on the wire and stay
 *    off the screen: a face-similarity number IS a match score.
 *  * Reference PHOTOS are never requested (`include_capture_urls: false`), because
 *    each signed URL writes a per-subject `reveal` row and a grid does not need a
 *    face.
 *
 * The capability is `biometric.template.manage` WITH an MFA step-up, so a 403
 * carrying `MFA_STEP_UP_REQUIRED` is a first-class state here, not an error card.
 *
 * @route /admin/kiosk/templates
 */
import { useMemo, useRef, useState } from "react";
import { Fingerprint, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { TTApiError, newIdempotencyKey } from "@/shared/api/invoke";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { FaceTemplate, TemplateListState } from "../api/kiosk.api";
import {
  useFaceTemplates,
  useForceReenrolMutation,
  useTemplateApproveMutation,
  useTemplateRetireMutation,
} from "../hooks/useKioskConsole";
import { qualityChip, qualityLabel, templateStateChip } from "../kiosk-display";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { KioskSectionNav } from "../components/KioskSectionNav";

const TABS: readonly { key: TemplateListState; label: string }[] = [
  { key: "pending", label: t("admin.kiosk.templates.tab.pending") },
  { key: "active", label: t("admin.kiosk.templates.tab.active") },
  { key: "inactive", label: t("admin.kiosk.templates.tab.inactive") },
  { key: "all", label: t("admin.kiosk.templates.tab.all") },
];

/** True when the edge function refused for want of a fresh second factor. */
function isStepUpRefusal(error: unknown): boolean {
  return (
    error instanceof TTApiError &&
    error.status === 403 &&
    (error.problem.code === "MFA_STEP_UP_REQUIRED" || error.problem.code === "MFA_STEP_UP_STALE")
  );
}

export default function FaceTemplatesPage() {
  const [state, setState] = useState<TemplateListState>("pending");
  const [enabled, setEnabled] = useState(false);
  const list = useFaceTemplates(state, 0, enabled);

  const approve = useTemplateApproveMutation();
  const stepUp = useStepUp();
  const retire = useTemplateRetireMutation();
  const reenrol = useForceReenrolMutation();

  // One idempotency key per (template, action), created on first use and reused
  // on every retry — so a refused-then-retried approve cannot approve twice.
  const keys = useRef(new Map<string, string>());
  function keyFor(scope: string): string {
    const existing = keys.current.get(scope);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    keys.current.set(scope, fresh);
    return fresh;
  }

  const rows = list.data?.templates ?? [];
  const total = list.data?.total ?? 0;

  const columns: DataGridColumn<FaceTemplate>[] = useMemo(
    () => [
      {
        key: "employee",
        header: t("admin.kiosk.templates.col.employee"),
        sortable: true,
        sortValue: (row) => row.employeeCode,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{dash(row.displayName)}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.employeeCode}</span>
          </span>
        ),
      },
      {
        key: "version",
        header: t("admin.kiosk.templates.col.version"),
        align: "right",
        width: "6rem",
        sortable: true,
        render: (row) => <span className="num">{formatNumber(row.version)}</span>,
      },
      {
        key: "state",
        header: t("admin.kiosk.templates.col.state"),
        width: "11rem",
        render: (row) => <StatusChip status={row.state} map={templateStateChip(row.state)} />,
      },
      {
        key: "samples",
        header: t("admin.kiosk.templates.col.samples"),
        align: "right",
        width: "7rem",
        render: (row) => (
          <span className="num">
            {t("admin.kiosk.templates.samples", { count: formatNumber(row.sampleCount) })}
          </span>
        ),
      },
      {
        key: "quality",
        header: t("admin.kiosk.templates.col.quality"),
        width: "9rem",
        render: (row) => (
          <span className="inline-flex flex-col items-start gap-0.5">
            <StatusChip status={row.qualityBand} map={qualityChip(row.qualityBand)} />
            {row.qualityBand === "poor" ? (
              <span className="text-xs text-destructive">
                {t("admin.kiosk.templates.qualityPoorHint")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "enrolled",
        header: t("admin.kiosk.templates.col.enrolled"),
        hideBelow: "md",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">{dash(row.enrolledAt, fmtDateTime)}</span>
            {row.enrolledByName !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.kiosk.templates.enrolledBy", { name: row.enrolledByName })}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "approved",
        header: t("admin.kiosk.templates.col.approved"),
        hideBelow: "lg",
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm">{dash(row.approvedAt, fmtDateTime)}</span>
            {row.approvedByName !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.kiosk.templates.enrolledBy", { name: row.approvedByName })}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "consent",
        header: t("admin.kiosk.templates.col.consent"),
        hideBelow: "lg",
        render: (row) => {
          if (row.consent.withdrawnAt !== null) {
            return <Badge variant="neutral">{t("admin.kiosk.consent.status.withdrawn")}</Badge>;
          }
          if (row.consent.grantedAt === null) {
            return <Badge variant="warning">{t("admin.kiosk.templates.noConsent")}</Badge>;
          }
          return <span className="num text-sm">{fmtDateTime(row.consent.grantedAt)}</span>;
        },
      },
      {
        key: "actions",
        header: t("admin.kiosk.templates.col.actions"),
        align: "right",
        width: "18rem",
        render: (row) => (
          <span className="inline-flex flex-wrap items-center justify-end gap-1">
            {row.state === "pending_approval" ? (
              <>
                <ReasonActionButton
                  label={t("admin.kiosk.templates.action.approve")}
                  variant="default"
                  minLength={approve.minReasonLength}
                  title={t("admin.kiosk.templates.approve.title", {
                    code: row.employeeCode,
                    version: row.version,
                  })}
                  description={t("admin.kiosk.templates.approve.description", {
                    band: qualityLabel(row.qualityBand),
                    samples: row.sampleCount,
                  })}
                  onConfirm={async (reason) => {
                    const input = {
                      templateId: row.templateId,
                      idempotencyKey: keyFor(`approve:${row.templateId}`),
                    };
                    try {
                      await approve.saveAsync(input, reason);
                    } catch (error) {
                      // Activation carries requires_step_up: on an aal1 session
                      // the server refuses with MFA_STEP_UP_REQUIRED. Verify the
                      // authenticator code, then retry the same idempotent call.
                      if (!isStepUpRequired(error)) throw error;
                      const upgraded = await stepUp.ensureAal2();
                      if (!upgraded) return;
                      await approve.saveAsync(input, reason);
                    }
                    toast.success(t("admin.kiosk.templates.approved", { code: row.employeeCode }));
                  }}
                />
                <ReasonActionButton
                  label={t("admin.kiosk.templates.action.reject")}
                  minLength={retire.minReasonLength}
                  title={t("admin.kiosk.templates.reject.title", { code: row.employeeCode })}
                  description={t("admin.kiosk.templates.reject.description")}
                  onConfirm={async (reason) => {
                    await retire.saveAsync(
                      {
                        templateId: row.templateId,
                        idempotencyKey: keyFor(`retire:${row.templateId}`),
                      },
                      reason,
                    );
                    toast.success(t("admin.kiosk.templates.retired", { code: row.employeeCode }));
                  }}
                />
              </>
            ) : null}
            {row.state === "active" ? (
              <>
                <ReasonActionButton
                  label={t("admin.kiosk.templates.action.retire")}
                  minLength={retire.minReasonLength}
                  title={t("admin.kiosk.templates.retire.title", {
                    code: row.employeeCode,
                    version: row.version,
                  })}
                  description={t("admin.kiosk.templates.retire.description")}
                  onConfirm={async (reason) => {
                    await retire.saveAsync(
                      {
                        templateId: row.templateId,
                        idempotencyKey: keyFor(`retire:${row.templateId}`),
                      },
                      reason,
                    );
                    toast.success(t("admin.kiosk.templates.retired", { code: row.employeeCode }));
                  }}
                />
                <ReasonActionButton
                  label={t("admin.kiosk.templates.action.forceReenrol")}
                  variant="ghost"
                  minLength={reenrol.minReasonLength}
                  title={t("admin.kiosk.templates.forceReenrol.title", { code: row.employeeCode })}
                  description={t("admin.kiosk.templates.forceReenrol.description")}
                  onConfirm={async (reason) => {
                    await reenrol.saveAsync(
                      {
                        employeeId: row.employeeId,
                        idempotencyKey: keyFor(`reenrol:${row.employeeId}`),
                      },
                      reason,
                    );
                    toast.success(t("admin.kiosk.templates.reenrolled", { code: row.employeeCode }));
                  }}
                />
              </>
            ) : null}
          </span>
        ),
      },
    ],
    [approve, retire, reenrol],
  );

  return (
    <div className="container py-6">
      <PageHeader
        icon={Fingerprint}
        title={t("admin.kiosk.templates.title")}
        subtitle={t("admin.kiosk.templates.subtitle")}
      />

      <KioskSectionNav />

      <p className="mb-4 flex items-start gap-2 rounded-md border border-info/40 bg-info/5 px-3 py-2 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
        <span>
          {t("admin.kiosk.templates.notice")}{" "}
          <span className="text-muted-foreground">{t("admin.kiosk.templates.purgeElsewhere")}</span>
        </span>
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-1" role="group">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={state === tab.key ? "default" : "outline"}
            aria-pressed={state === tab.key}
            onClick={() => setState(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {!enabled ? (
        <EmptyState
          icon={Fingerprint}
          title={t("admin.kiosk.templates.load")}
          hint={t("admin.kiosk.templates.loadHint")}
          action={<Button onClick={() => setEnabled(true)}>{t("admin.kiosk.templates.load")}</Button>}
        />
      ) : isStepUpRefusal(list.error) ? (
        <EmptyState
          icon={ShieldAlert}
          title={t("admin.kiosk.templates.stepUp.title")}
          hint={t("admin.kiosk.templates.stepUp.hint")}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t("error.retry")}
            </Button>
          }
        />
      ) : (
        <StateBoundary
          loading={list.isLoading}
          error={list.error ?? undefined}
          onRetry={() => void list.refetch()}
          skeletonRows={5}
        >
          <p className="mb-2 text-xs text-muted-foreground" aria-live="polite">
            {t("admin.kiosk.templates.total", { count: formatNumber(total) })}
          </p>
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.templateId}
            pageSize={25}
            emptyState={
              <EmptyState
                icon={Fingerprint}
                title={t("admin.kiosk.templates.empty.title")}
                hint={t("admin.kiosk.templates.empty.hint")}
              />
            }
          />
        </StateBoundary>
      )}
      {stepUp.dialog}
    </div>
  );
}
