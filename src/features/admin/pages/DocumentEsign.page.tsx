/**
 * §9 · /admin/documents/esign — E-Sign Requests. Signature chains and their
 * audit trail.
 *
 * RECON RESULT, stated plainly because it decides the shape of this screen:
 *
 *  - The DATA is deployed and admin-readable. `e_sign_requests`,
 *    `e_sign_signers` and `e_sign_events` all exist (migration 026) with
 *    `…__admin__all` / `…__admin__select` policies, so the register below is real
 *    rows, not a placeholder.
 *  - The ACTIONS are deployed too, but they are not a browser form. Creating,
 *    sending, reminding, sealing and cancelling all go through ONE endpoint,
 *    `supabase/functions/esign-flow/index.ts`, discriminated on `action`, and the
 *    signing itself happens on a token-gated `/sign/:token` route served by that
 *    function against `secure.esign_signer_tokens` — hashes the browser can never
 *    see. Driving `create` from here would mean building the signer list, the
 *    identity-check policy per signer and the ordering ceremony, and the honest
 *    version of that is its own screen, not a button bolted to a register.
 *
 * So: the full chain is READABLE here — who is next, who has viewed, who signed
 * and when, whether identity was verified, and the certificate hash of a
 * completed envelope — and every action is named as out of scope tonight rather
 * than half-wired.
 *
 * @route /admin/documents/esign
 */
import { useMemo, useState } from "react";
import { PenTool, Signature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PersonCell } from "../components/PersonCell";
import { SelectField, TextField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { ESIGN_ROW_CAP, useEsignCount, useEsignRequests, useEsignSigners } from "../hooks/useDocumentsAdmin";
import {
  esignStatusValues,
  type EsignFilters,
  type EsignStatus,
} from "../api/documents.api";
import { ESIGN_CHIP, SIGNER_CHIP } from "../documents/labels";

/** The two states that are actually waiting on somebody. */
const OPEN_STATUSES: readonly EsignStatus[] = ["sent", "partially_signed"];

export default function DocumentEsignPage() {
  const [view, setView] = useState<"open" | "all">("open");
  const [status, setStatus] = useState<EsignStatus | "">("");
  const [titleLike, setTitleLike] = useState("");

  const labels = useEmployeeLabels();

  const filters = useMemo<EsignFilters>(
    () => ({
      ...(status !== "" ? { statuses: [status] } : view === "open" ? { statuses: OPEN_STATUSES } : {}),
      ...(titleLike.trim() !== "" ? { titleLike: titleLike.trim() } : {}),
    }),
    [status, view, titleLike],
  );

  const requests = useEsignRequests(filters);
  const total = useEsignCount(filters);
  const rows = useMemo(() => requests.data ?? [], [requests.data]);

  const requestIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const signers = useEsignSigners(requestIds);

  const hasAnyFilter = status !== "" || titleLike.trim() !== "" || view === "all";

  return (
    <div className="container py-6">
      <PageHeader
        icon={Signature}
        title={t("admin.docs.esign.title")}
        subtitle={
          total.isSuccess
            ? t("admin.docs.esign.subtitle", { n: formatNumber(total.data) })
            : t("admin.docs.esign.subtitlePlain")
        }
      />

      <div className="mt-4">
        <Notice tone="warning">{t("admin.docs.esign.noActions")}</Notice>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-4">
        <SelectField
          label={t("admin.docs.esign.filter.view")}
          value={view}
          options={[
            { value: "open", label: t("admin.docs.esign.view.open") },
            { value: "all", label: t("admin.docs.esign.view.all") },
          ]}
          onChange={(v) => setView(v === "all" ? "all" : "open")}
          hint={t("admin.docs.esign.filter.viewHint")}
        />
        <SelectField
          label={t("admin.docs.esign.filter.status")}
          value={status}
          placeholder={t("admin.docs.esign.filter.anyStatus")}
          options={esignStatusValues.map((value) => ({ value, label: ESIGN_CHIP[value].label }))}
          onChange={(v) => setStatus(v as EsignStatus | "")}
        />
        <TextField
          label={t("admin.docs.esign.filter.title")}
          value={titleLike}
          onChange={setTitleLike}
          placeholder={t("admin.docs.esign.filter.titlePlaceholder")}
        />
        <div className="flex items-end">
          {hasAnyFilter ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStatus("");
                setTitleLike("");
                setView("open");
              }}
            >
              {t("admin.docs.exp.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={requests.isPending}
          error={requests.error}
          onRetry={() => void requests.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? labels.error ?? signers.error}
          partialLabel={t("admin.docs.esign.partial")}
          empty={
            <EmptyState
              icon={PenTool}
              title={
                hasAnyFilter
                  ? t("admin.docs.esign.empty.filtered.title")
                  : t("admin.docs.esign.empty.title")
              }
              hint={
                hasAnyFilter
                  ? t("admin.docs.esign.empty.filtered.hint")
                  : t("admin.docs.esign.empty.hint")
              }
            />
          }
        >
          <ul className="space-y-3">
            {rows.map((row) => {
              const who =
                row.subject_employee_id === null
                  ? null
                  : (labels.data?.get(row.subject_employee_id) ?? null);
              const chain = signers.data?.get(row.id) ?? [];
              return (
                <li key={row.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{row.title}</p>
                      <p className="num mt-0.5 text-xs text-muted-foreground">
                        {row.request_number}
                        {" · "}
                        {t("admin.docs.esign.raised", { at: fmtDateTime(row.created_at) })}
                        {row.sent_at !== null
                          ? ` · ${t("admin.docs.esign.sentAt", { at: fmtDateTime(row.sent_at) })}`
                          : ""}
                      </p>
                    </div>
                    <StatusChip status={row.status} map={ESIGN_CHIP} />
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">
                        {t("admin.docs.esign.subject")}
                      </p>
                      <div className="mt-1">
                        {row.subject_employee_id === null ? (
                          <span className="text-sm text-muted-foreground">
                            {t("admin.docs.esign.noSubject")}
                          </span>
                        ) : (
                          <PersonCell name={who?.name ?? null} code={who?.code ?? null} />
                        )}
                      </div>
                    </div>
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">
                        {t("admin.docs.esign.orderTitle")}
                      </p>
                      <p className="mt-1 text-sm">
                        {row.signing_order === "parallel"
                          ? t("admin.docs.esign.order.parallel")
                          : t("admin.docs.esign.order.sequential")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.expires_at === null
                          ? t("admin.docs.esign.noExpiry")
                          : t("admin.docs.esign.expires", { at: fmtDateTime(row.expires_at) })}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed p-3">
                      <p className="text-xs text-muted-foreground">
                        {t("admin.docs.esign.completion")}
                      </p>
                      <p className="mt-1 text-sm">
                        {row.completed_at === null
                          ? t("admin.docs.esign.notCompleted")
                          : t("admin.docs.esign.completedAt", {
                              at: fmtDateTime(row.completed_at),
                            })}
                      </p>
                      {row.certificate_hash !== null ? (
                        <p className="num mt-1 break-all text-xs text-muted-foreground">
                          {t("admin.docs.esign.certificate", { hash: row.certificate_hash })}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground">
                      {t("admin.docs.esign.chainTitle")}
                    </p>
                    {signers.isPending && chain.length === 0 ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("admin.docs.esign.chainLoading")}
                      </p>
                    ) : chain.length === 0 ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("admin.docs.esign.chainEmpty")}
                      </p>
                    ) : (
                      <ol className="mt-1 space-y-1">
                        {chain.map((signer) => (
                          <li
                            key={signer.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="num text-xs text-muted-foreground">
                                {formatNumber(signer.signer_order)}
                              </span>
                              <span className="font-medium normal-case">{signer.full_name}</span>
                              <span className="text-xs text-muted-foreground">
                                {dash(signer.designation_snapshot)}
                              </span>
                            </span>
                            <span className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "num text-xs",
                                  signer.signed_at === null
                                    ? "text-muted-foreground"
                                    : "text-foreground",
                                )}
                              >
                                {signer.signed_at === null
                                  ? signer.viewed_at === null
                                    ? t("admin.docs.esign.notViewed")
                                    : t("admin.docs.esign.viewedAt", {
                                        at: fmtDateTime(signer.viewed_at),
                                      })
                                  : t("admin.docs.esign.signedAt", {
                                      at: fmtDateTime(signer.signed_at),
                                    })}
                              </span>
                              <StatusChip status={signer.status} map={SIGNER_CHIP} />
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {row.cancelled_reason !== null ? (
                    <p className="mt-2 text-sm">
                      <span className="text-muted-foreground">
                        {t("admin.docs.esign.cancelledBecause")}{" "}
                      </span>
                      {row.cancelled_reason}
                    </p>
                  ) : null}

                  <p className="mt-2 text-xs text-muted-foreground">{row.legal_framework}</p>
                </li>
              );
            })}
          </ul>
        </StateBoundary>
      </div>

      <div className="mt-4 space-y-2">
        {total.isSuccess && total.data > rows.length ? (
          <Notice tone="warning">
            {t("admin.docs.esign.capped", {
              shown: formatNumber(rows.length),
              total: formatNumber(total.data),
              cap: formatNumber(ESIGN_ROW_CAP),
            })}
          </Notice>
        ) : null}
        <Notice tone="info">{t("admin.docs.esign.footnote")}</Notice>
      </div>
    </div>
  );
}
