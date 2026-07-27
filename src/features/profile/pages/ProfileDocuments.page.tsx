/**
 * E-07.6 · /me/profile/documents — the documents attached to MY employee
 * record: offer letter, contracts, ID proofs, certificates — and the place the
 * employee ADDS one.
 *
 * Distinct from /me/documents (the org-wide "issued to you / you uploaded /
 * you signed" console): this tab is the record's own attachments, read through
 * the same `documents` table but scoped to the employee record. Expiring
 * documents lead — the compliance view flags them, and the venue's licences
 * (food safety, fire) make expiry the fact HR actually chases.
 *
 * THE UPLOAD IS REAL, and what is not real is stated rather than mocked. The
 * private `documents` bucket exists (migration 039) and `documents__own_write`
 * already lets an employee write into their own folder; migration
 * 20260801014000 adds the metadata half (`documents__self__insert`) so the file
 * arrives as a `pending_review` row on the queue /admin/documents/pending
 * already reads. What is still absent is the `document-access` edge function
 * that mints signed read URLs — so this screen offers no download button and
 * says why, instead of shipping one that 400s.
 *
 * "Still owed for onboarding" is computed from `document_types.is_required_for_onboarding`
 * against the codes actually on the record, so it is HR's own configuration
 * asking, not a hard-coded checklist.
 *
 * `DOCUMENT_STATUS_CHIP` is imported from `admin/documents/labels` rather than
 * re-declared: that module is pure (no React, no supabase) and is the single
 * vocabulary for `document_status` across nine screens. A local copy is exactly
 * how this tab and /admin/documents/pending end up calling `pending_review` two
 * different things.
 *
 * @route /me/profile/documents
 */
import { useState } from "react";
import { FileText, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip } from "@/shared/ui/StatusChip";
import { DOCUMENT_STATUS_CHIP } from "@/features/admin/documents/labels";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { ProfileCard } from "../components/FieldRow";
import { DocumentUploadCard } from "../components/DocumentUploadCard";
import { useMyProfile, useOrgLabels, useProfileDocuments } from "../hooks/useProfile";
import { useUploadableDocumentTypes } from "../hooks/useProfileDocumentUpload";
import { missingOnboardingTypes } from "../api/documents.api";

export default function ProfileDocumentsPage() {
  const profile = useMyProfile();
  const orgLabels = useOrgLabels();
  const documents = useProfileDocuments();
  const types = useUploadableDocumentTypes();
  const [preselectedCode, setPreselectedCode] = useState<string | null>(null);

  const rows = documents.data ?? [];
  const typeRows = types.data ?? [];
  const missing = missingOnboardingTypes(typeRows, rows);

  return (
    <ProfileShell
      title={t("profile.docs.title")}
      subtitle={t("profile.docs.subtitle")}
      profile={profile.data}
      orgLabels={orgLabels.data}
      loading={profile.isPending}
      error={profile.error}
      onRetry={() => void profile.refetch()}
      {...(types.error !== null ? { partialError: types.error } : {})}
      partialLabel={t("profile.docsUpload.card.title")}
    >
      <StateBoundary
        loading={documents.isPending}
        error={documents.error}
        onRetry={() => void documents.refetch()}
        skeletonRows={4}
      >
        {/* 1 ── what HR is still waiting for, from HR's own configuration ──── */}
        {typeRows.length > 0 ? (
          <ProfileCard
            icon={ShieldAlert}
            title={t("profile.docsUpload.missing.title")}
            description={t("profile.docsUpload.missing.hint")}
          >
            {missing.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("profile.docsUpload.missing.none")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {missing.map((type) => (
                  <li key={type.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPreselectedCode(type.code)}
                    >
                      {type.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </ProfileCard>
        ) : null}

        {/* 2 ── the record itself ───────────────────────────────────────────── */}
        <StateBoundary
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={FileText}
              title={t("profile.docs.empty.title")}
              hint={t("profile.docs.empty.hint")}
            />
          }
        >
          <ProfileCard
            icon={FileText}
            title={t("profile.docs.card.title")}
            description={t("profile.docs.card.hint")}
          >
            <ul className="divide-y">
              {rows.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {d.title}
                      {d.is_confidential ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {t("profile.docs.confidential")}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {dash(d.document_types?.name ?? null)}
                      {" · "}
                      {t("profile.docs.uploaded", { at: fmtDateTime(d.uploaded_at) })}
                      {d.current_version > 1
                        ? " · " + t("profile.docs.version", { n: formatNumber(d.current_version) })
                        : null}
                    </p>
                    {d.requires_acknowledgement && d.acknowledgement_due_on !== null ? (
                      <p className="mt-0.5 text-xs font-medium text-warning">
                        {t("profile.docs.ackDue", { date: fmtCivilDate(d.acknowledgement_due_on) })}
                      </p>
                    ) : null}
                    {d.status === "pending_review" ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("profile.docsUpload.pending.badge")}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <StatusChip status={d.status} map={DOCUMENT_STATUS_CHIP} />
                    {d.expiry_date !== null ? (
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <TriangleAlert className="size-3.5 text-warning" aria-hidden />
                        {t("profile.docs.expires", { date: fmtCivilDate(d.expiry_date) })}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </ProfileCard>
        </StateBoundary>

        {/* 3 ── adding one ──────────────────────────────────────────────────── */}
        <StateBoundary
          loading={types.isPending}
          error={types.error}
          onRetry={() => void types.refetch()}
          isEmpty={typeRows.length === 0}
          empty={
            <EmptyState
              icon={FileText}
              title={t("profile.docsUpload.card.title")}
              hint={t("profile.docsUpload.typeHint")}
            />
          }
          skeletonRows={3}
        >
          <DocumentUploadCard
            // Remount on a new preselection so the form resets to that type.
            // `initialTypeCode` is initial state by design — a controlled type
            // would fight the employee's own choice on every re-render.
            key={preselectedCode ?? "blank"}
            types={typeRows}
            companyId={profile.data?.company_id ?? null}
            initialTypeCode={preselectedCode}
            onUploaded={(title) => {
              setPreselectedCode(null);
              toast.success(t("profile.docsUpload.done", { title }));
            }}
          />
        </StateBoundary>
      </StateBoundary>
    </ProfileShell>
  );
}
