/**
 * §9 · /admin/documents/generate — produce a letter from a template.
 *
 * The whole screen is a thin, faithful front for ONE deployed endpoint:
 * `supabase/functions/document-generate/index.ts`. Its request schema is
 * `.strict()`, so the body sent here carries exactly the keys that schema names —
 * an extra `reason` field would be a 422. The audit sentence therefore travels as
 * `purpose`, which the function uses BOTH as the transaction's audit reason and
 * as the mandatory `document_access_log.purpose` when it mints a download link.
 *
 * Four properties of this screen come straight from what the function enforces:
 *
 *  1. PREVIEW BEFORE COMMIT. `dry_run: true` renders the PDF, measures it and
 *     returns the resolved variables WITHOUT writing anything. The admin sees the
 *     letter before it exists, and the preview's page count and byte size are the
 *     function's own — not an estimate.
 *  2. THE SERVER SAYS WHICH TOKENS ARE MISSING. An unresolved `{{token}}` is a
 *     422 with one `/variables/<token>` pointer each. Those tokens are read off
 *     the problem body and given their own inputs, so the browser never has to
 *     guess the template's grammar or re-implement its token scanner.
 *  3. ONE IDEMPOTENCY KEY PER LETTER. The key is minted at mount and reused on
 *     every retry, so a double click replays the first response instead of
 *     producing a second contract. After a success a NEW key is minted, because
 *     the next letter is a different letter.
 *  4. IT IS NOT BULK. The deployed function takes exactly ONE `employee_id` per
 *     call. Looping it silently would be a bulk feature the server does not have
 *     and cannot report on, so the screen generates one document at a time and
 *     says so.
 *
 * @route /admin/documents/generate
 */
import { useEffect, useMemo, useState } from "react";
import { FileSignature, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { TTApiError, newIdempotencyKey } from "@/shared/api/invoke";
import { useAuth } from "@/app/auth/AuthProvider";
import { dash, formatNumber } from "@/lib/format";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/Field";
import { useEmployeeLabels, useEmployeeOptions } from "../hooks/useEmployeeLabels";
import {
  useContractTemplates,
  useDocumentTypeOptions,
  useGenerateDocument,
  usePreviewDocument,
} from "../hooks/useDocumentsAdmin";
import {
  isGeneratePreview,
  templateVariablesOf,
  unresolvedTokensOf,
  type GenerateInput,
  type TemplateVariable,
} from "../api/documents.api";
import { CONTRACT_KIND_LABELS, fmtFileSize } from "../documents/labels";

/** The tokens the admin must type: everything the template does not source. */
function manualTokens(declared: readonly TemplateVariable[]): TemplateVariable[] {
  return declared.filter((v) => (v.source ?? "") === "");
}

export default function DocumentGeneratePage() {
  const actorName = useAuth().employee?.displayName ?? null;

  const templates = useContractTemplates({ publishedOnly: true });
  const types = useDocumentTypeOptions();
  const labels = useEmployeeLabels();
  const employeeOptions = useEmployeeOptions(labels.data);

  const [templateId, setTemplateId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [confidential, setConfidential] = useState(false);
  const [requiresAck, setRequiresAck] = useState(false);
  const [ackDueOn, setAckDueOn] = useState("");
  const [withDownloadUrl, setWithDownloadUrl] = useState(false);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [extraTokens, setExtraTokens] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** One key per letter; replaced after a success (rule 3 in the header). */
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  const preview = usePreviewDocument();
  const generate = useGenerateDocument(idempotencyKey);

  const template = useMemo(
    () => (templates.data ?? []).find((row) => row.id === templateId) ?? null,
    [templates.data, templateId],
  );

  const declared = useMemo(
    () => (template === null ? [] : templateVariablesOf(template.variables)),
    [template],
  );
  const typed = useMemo(() => manualTokens(declared), [declared]);
  const sourced = useMemo(() => declared.filter((v) => (v.source ?? "") !== ""), [declared]);

  /**
   * Changing the template abandons everything that belonged to the old one: its
   * token values, the tokens the server complained about, and both results. Done
   * in the handler rather than an effect so there is no render in between where
   * one template's name sits above another template's merge values.
   */
  function chooseTemplate(nextId: string): void {
    setTemplateId(nextId);
    setVariables({});
    setExtraTokens([]);
    setFormError(null);
    preview.reset();
    generate.reset();
  }

  /** Tokens the SERVER said it could not resolve get an input of their own. */
  useEffect(() => {
    const error = preview.error ?? generate.error ?? null;
    if (!(error instanceof TTApiError)) return;
    const tokens = unresolvedTokensOf(error.problem);
    if (tokens.length === 0) return;
    setExtraTokens((prev) => {
      const merged = [...prev];
      for (const token of tokens) if (!merged.includes(token)) merged.push(token);
      return merged;
    });
  }, [preview.error, generate.error]);

  const tokenInputs = useMemo<readonly { token: string; label: string; required: boolean }[]>(() => {
    const seen = new Set<string>();
    const out: { token: string; label: string; required: boolean }[] = [];
    for (const entry of typed) {
      if (seen.has(entry.token)) continue;
      seen.add(entry.token);
      out.push({
        token: entry.token,
        label: entry.label ?? entry.token,
        required: entry.required !== false,
      });
    }
    for (const token of extraTokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ token, label: token, required: true });
    }
    return out;
  }, [typed, extraTokens]);

  const filledVariables = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const entry of tokenInputs) {
      const value = (variables[entry.token] ?? "").trim();
      if (value !== "") out[entry.token] = value;
    }
    return out;
  }, [tokenInputs, variables]);

  function buildInput(): GenerateInput | null {
    if (templateId === "") {
      setFormError(t("admin.docs.gen.err.template"));
      return null;
    }
    if (employeeId === "") {
      setFormError(t("admin.docs.gen.err.employee"));
      return null;
    }
    if (requiresAck && ackDueOn === "") {
      setFormError(t("admin.docs.gen.err.ackDue"));
      return null;
    }
    setFormError(null);
    return {
      templateId,
      employeeId,
      subjectKind: "employee",
      dryRun: false,
      variables: filledVariables,
      ...(documentTypeId !== "" ? { documentTypeId } : {}),
      ...(title.trim() !== "" ? { title: title.trim() } : {}),
      ...(issueDate !== "" ? { issueDate } : {}),
      ...(expiryDate !== "" ? { expiryDate } : {}),
      ...(confidential ? { isConfidential: true } : {}),
      ...(requiresAck ? { requiresAcknowledgement: true, acknowledgementDueOn: ackDueOn } : {}),
      ...(withDownloadUrl ? { includeDownloadUrl: true } : {}),
    };
  }

  function runPreview(): void {
    const input = buildInput();
    if (input === null) return;
    generate.reset();
    preview.mutate(input);
  }

  function askToCommit(): void {
    const input = buildInput();
    if (input === null) return;
    setConfirming(true);
  }

  function commit(reason: string): void {
    const input = buildInput();
    if (input === null) {
      setConfirming(false);
      return;
    }
    void generate
      .saveAsync(input, reason)
      .then(() => {
        setConfirming(false);
        // The next letter is a different letter — and must not replay this one.
        setIdempotencyKey(newIdempotencyKey());
      })
      .catch(() => {
        // The sentence is on `generate.userMessage`; the dialog stays open.
      });
  }

  const previewResult = preview.data !== undefined && isGeneratePreview(preview.data) ? preview.data : null;
  const created =
    generate.data !== undefined && !isGeneratePreview(generate.data) ? generate.data : null;

  const templateError = preview.error ?? null;
  const busy = preview.isPending || generate.isPending;

  const noTemplates = templates.isSuccess && (templates.data ?? []).length === 0;

  return (
    <div className="container py-6">
      <PageHeader
        icon={FileSignature}
        title={t("admin.docs.gen.title")}
        subtitle={t("admin.docs.gen.subtitle")}
      />

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.docs.gen.notBulk")}</Notice>
      </div>

      <StateBoundary
        loading={templates.isPending}
        error={templates.error}
        onRetry={() => void templates.refetch()}
        isEmpty={noTemplates}
        partialError={types.error ?? labels.error}
        partialLabel={t("admin.docs.gen.partial")}
        empty={
          <div className="mt-4">
            <EmptyState
              icon={Sparkles}
              title={t("admin.docs.gen.empty.title")}
              hint={t("admin.docs.gen.empty.hint")}
            />
          </div>
        }
      >
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {/* ── The request ─────────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t("admin.docs.gen.section.what")}
            </h2>

            <SelectField
              label={t("admin.docs.gen.field.template")}
              value={templateId}
              placeholder={t("admin.docs.gen.field.templatePlaceholder")}
              options={(templates.data ?? []).map((row) => ({
                value: row.id,
                label: `${row.name} · ${CONTRACT_KIND_LABELS[row.contract_kind]}`,
              }))}
              onChange={chooseTemplate}
              required
              hint={t("admin.docs.gen.field.templateHint")}
            />

            {template !== null ? (
              <p className="text-xs text-muted-foreground">
                {t("admin.docs.gen.templateMeta", {
                  version: formatNumber(template.version),
                  law: template.governing_law,
                  legal:
                    template.approved_by_legal_at === null
                      ? t("admin.docs.gen.notLegalApproved")
                      : t("admin.docs.gen.legalApproved"),
                })}
              </p>
            ) : null}

            <SelectField
              label={t("admin.docs.gen.field.employee")}
              value={employeeId}
              placeholder={t("admin.docs.gen.field.employeePlaceholder")}
              options={employeeOptions}
              onChange={setEmployeeId}
              required
              hint={t("admin.docs.gen.field.employeeHint")}
            />

            <SelectField
              label={t("admin.docs.gen.field.type")}
              value={documentTypeId}
              placeholder={t("admin.docs.gen.field.typePlaceholder")}
              options={(types.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
              onChange={setDocumentTypeId}
              hint={t("admin.docs.gen.field.typeHint")}
            />

            <TextField
              label={t("admin.docs.gen.field.title")}
              value={title}
              onChange={setTitle}
              placeholder={t("admin.docs.gen.field.titlePlaceholder")}
              hint={t("admin.docs.gen.field.titleHint")}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={t("admin.docs.gen.field.issue")}
                value={issueDate}
                onChange={setIssueDate}
                type="date"
              />
              <TextField
                label={t("admin.docs.gen.field.expiry")}
                value={expiryDate}
                onChange={setExpiryDate}
                type="date"
                hint={t("admin.docs.gen.field.expiryHint")}
              />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={confidential}
                onChange={(event) => setConfidential(event.target.checked)}
                className="h-4 w-4 rounded border-input text-primary"
              />
              {t("admin.docs.gen.field.confidential")}
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={requiresAck}
                onChange={(event) => setRequiresAck(event.target.checked)}
                className="h-4 w-4 rounded border-input text-primary"
              />
              {t("admin.docs.gen.field.requiresAck")}
            </label>

            {requiresAck ? (
              <TextField
                label={t("admin.docs.gen.field.ackDue")}
                value={ackDueOn}
                onChange={setAckDueOn}
                type="date"
                required
                hint={t("admin.docs.gen.field.ackDueHint")}
              />
            ) : null}

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={withDownloadUrl}
                onChange={(event) => setWithDownloadUrl(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input text-primary"
              />
              <span>
                {t("admin.docs.gen.field.downloadUrl")}
                <span className="block text-xs text-muted-foreground">
                  {t("admin.docs.gen.field.downloadUrlHint")}
                </span>
              </span>
            </label>
          </section>

          {/* ── The merge values ────────────────────────────────────────── */}
          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t("admin.docs.gen.section.variables")}
            </h2>

            {template === null ? (
              <p className="text-sm text-muted-foreground">{t("admin.docs.gen.pickTemplate")}</p>
            ) : tokenInputs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin.docs.gen.noManualTokens")}</p>
            ) : (
              <div className="space-y-3">
                {tokenInputs.map((entry) => (
                  <TextField
                    key={entry.token}
                    label={entry.label}
                    value={variables[entry.token] ?? ""}
                    onChange={(v) => setVariables((prev) => ({ ...prev, [entry.token]: v }))}
                    required={entry.required}
                    hint={t("admin.docs.gen.tokenHint", { token: entry.token })}
                  />
                ))}
              </div>
            )}

            {sourced.length > 0 ? (
              <div className="rounded-md border border-dashed p-3">
                <p className="text-xs font-medium">{t("admin.docs.gen.sourcedTitle")}</p>
                <ul className="mt-1 space-y-0.5">
                  {sourced.map((entry) => (
                    <li key={entry.token} className="num text-xs text-muted-foreground">
                      {`{{${entry.token}}} → ${entry.source ?? ""}`}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {formError !== null ? <Notice tone="error">{formError}</Notice> : null}
            {templateError !== null ? (
              <Notice tone="error">
                {templateError instanceof TTApiError
                  ? (templateError.problem.detail ?? templateError.message)
                  : templateError.message}
              </Notice>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" onClick={runPreview} disabled={busy}>
                {preview.isPending ? t("admin.docs.gen.previewing") : t("admin.docs.gen.preview")}
              </Button>
              <Button onClick={askToCommit} disabled={busy}>
                {generate.isPending ? t("admin.docs.gen.generating") : t("admin.docs.gen.generate")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("admin.docs.gen.previewHint")}</p>
          </section>
        </div>
      </StateBoundary>

      {/* ── The dry-run result ────────────────────────────────────────────── */}
      {previewResult !== null ? (
        <section className="mt-4 rounded-lg border bg-card p-4">
          <h2 className="font-display text-base font-semibold">
            {t("admin.docs.gen.previewTitle", { title: previewResult.title })}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("admin.docs.gen.previewMeta", {
              pages: formatNumber(previewResult.page_count),
              size: fmtFileSize(previewResult.file_size_bytes),
              type: previewResult.document_type.name,
            })}
          </p>
          <p className="num mt-1 break-all text-xs text-muted-foreground">
            {t("admin.docs.gen.checksum", { hash: previewResult.checksum_sha256 })}
          </p>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {previewResult.rendered_markdown}
          </pre>
        </section>
      ) : null}

      {/* ── The committed result ──────────────────────────────────────────── */}
      {created !== null ? (
        <section className="mt-4 space-y-2">
          <Notice tone="success">
            {t("admin.docs.gen.created", {
              title: created.document.title,
              pages: formatNumber(created.document.page_count),
              size: fmtFileSize(created.document.file_size_bytes),
            })}
          </Notice>
          <div className="rounded-lg border bg-card p-4 text-sm">
            <p className="num break-all text-xs text-muted-foreground">
              {t("admin.docs.gen.checksum", { hash: created.document.checksum_sha256 })}
            </p>
            <p className="mt-1">
              {t("admin.docs.gen.storedAt", {
                bucket: created.document.storage_bucket,
                path: created.document.storage_path,
              })}
            </p>
            <p className="mt-1">
              {t("admin.docs.gen.retention", {
                until:
                  created.document.retention_until === null
                    ? dash(null)
                    : fmtCivilDate(created.document.retention_until),
              })}
            </p>
            {created.document.requires_acknowledgement ? (
              <p className="mt-1">
                {t("admin.docs.gen.ackDueOn", {
                  date:
                    created.document.acknowledgement_due_on === null
                      ? dash(null)
                      : fmtCivilDate(created.document.acknowledgement_due_on),
                })}
              </p>
            ) : null}
            {created.requires_esign ? (
              <p className="mt-1 text-warning">{t("admin.docs.gen.needsEsign")}</p>
            ) : null}
            {created.download_url != null && created.download_url !== "" ? (
              <p className="mt-2">
                <a
                  href={created.download_url}
                  className="font-medium underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("admin.docs.gen.downloadLink", {
                    seconds: formatNumber(created.download_url_expires_in_seconds ?? null),
                  })}
                </a>
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {generate.userMessage !== null && !confirming ? (
        <div className="mt-4">
          <Notice tone="error">{generate.userMessage}</Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <Notice tone="info">{t("admin.docs.gen.footnote")}</Notice>
      </div>

      <ReasonDialog
        open={confirming}
        title={t("admin.docs.gen.reason.title")}
        description={t("admin.docs.gen.reason.description", {
          template: template?.name ?? "",
          employee: labels.data?.get(employeeId)?.name ?? "",
        })}
        actorName={actorName}
        minLength={10}
        confirmLabel={t("admin.docs.gen.reason.confirm")}
        pending={generate.isPending}
        errorMessage={generate.userMessage}
        onConfirm={commit}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
