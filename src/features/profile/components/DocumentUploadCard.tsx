/**
 * DocumentUploadCard.tsx — the employee's side of the document vault: pick a
 * type, attach a file, say why, send it to HR's verification queue.
 *
 * Every field constraint on screen comes from the chosen `document_types` row —
 * `allowed_mime_types`, `max_file_size_mb`, `requires_expiry` — so the rules the
 * employee is held to are the rules the admin actually configured, not a
 * hard-coded list. The checks here are pre-flight; the database and the storage
 * policy remain the authority, and a refusal from either is reported verbatim
 * where it is written for a person and through the catalogue where it is not.
 *
 * The "what happens to the file" block is not decoration. Three real limits of
 * this deployment (no self read-back without the document-access function, no
 * version row, virus scan pending) are stated where the employee is deciding to
 * upload, because discovering them afterwards is how a vault loses trust.
 */
import { useState } from "react";
import { FilePlus2, Info, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/features/admin/components/Notice";
import { SelectField, TextField } from "@/features/admin/components/Field";
import { fmtFileSize } from "@/features/admin/documents/labels";
import { compareCivilDates, nowIstDate } from "@/lib/datetime";
import { QueryError } from "@/shared/api/query";
import { isRuleRejection } from "@/shared/api/write";
import { t } from "@/shared/i18n/en";
import { ProfileCard } from "./FieldRow";
import {
  PROFILE_DOCUMENT_BUCKET,
  UPLOAD_NOTE_MIN_LENGTH,
  type UploadableDocumentType,
} from "../api/documents.api";
import { useUploadProfileDocument } from "../hooks/useProfileDocumentUpload";

/** 'application/pdf, image/jpeg' → 'PDF, JPEG' for a sentence a person reads. */
function mimeLabels(mimeTypes: readonly string[]): string {
  const seen: string[] = [];
  for (const mime of mimeTypes) {
    const tail = mime.slice(mime.lastIndexOf("/") + 1).toUpperCase();
    const label = tail === "JPG" ? "JPEG" : tail;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(", ");
}

export interface DocumentUploadCardProps {
  types: readonly UploadableDocumentType[];
  companyId: string | null | undefined;
  /** Pre-selected type code, e.g. from the "still owed" list. */
  initialTypeCode?: string | null;
  onUploaded: (title: string) => void;
}

export function DocumentUploadCard({
  types,
  companyId,
  initialTypeCode,
  onUploaded,
}: DocumentUploadCardProps) {
  const [typeId, setTypeId] = useState<string>(
    () => types.find((candidate) => candidate.code === initialTypeCode)?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // `<input type="file">` is uncontrolled — clearing `file` alone leaves the
  // browser still showing the old file name, i.e. the form and the control
  // disagreeing about what is attached. Bumping this remounts it.
  const [fileControlKey, setFileControlKey] = useState(0);
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const upload = useUploadProfileDocument(companyId);
  const today = nowIstDate();
  const type = types.find((candidate) => candidate.id === typeId) ?? null;
  const maxBytes = type === null ? 0 : type.max_file_size_mb * 1024 * 1024;

  function pickType(nextId: string) {
    setTypeId(nextId);
    setError(null);
    setServerError(null);
    // A file accepted by the old type may be refused by the new one, so the
    // attachment is dropped rather than silently re-validated later.
    setFile(null);
    setFileControlKey((n) => n + 1);
    const next = types.find((candidate) => candidate.id === nextId) ?? null;
    if (next !== null && title.trim() === "") setTitle(next.name);
  }

  function pickFile(next: File | null) {
    setError(null);
    setServerError(null);
    setFile(next);
  }

  /** Everything the database or the storage policy would refuse, said first. */
  function firstProblem(): string | null {
    if (type === null) return t("profile.docsUpload.error.type");
    if (title.trim() === "") return t("profile.docsUpload.error.title");
    if (file === null) return t("profile.docsUpload.error.file");
    // ck_documents__file_size: file_size_bytes > 0.
    if (file.size === 0) return t("profile.docsUpload.error.emptyFile");
    if (file.size > maxBytes) {
      return t("profile.docsUpload.error.size", {
        size: fmtFileSize(file.size),
        mb: type.max_file_size_mb,
      });
    }
    if (type.allowed_mime_types.length > 0 && !type.allowed_mime_types.includes(file.type)) {
      return t("profile.docsUpload.error.mime", {
        types: mimeLabels(type.allowed_mime_types),
      });
    }
    if (issueDate !== "" && compareCivilDates(issueDate, today) > 0) {
      return t("profile.docsUpload.error.issueFuture");
    }
    // documents__self__insert refuses a requires_expiry type with no expiry_date.
    if (type.requires_expiry && expiryDate === "") return t("profile.docsUpload.error.expiry");
    if (issueDate !== "" && expiryDate !== "" && compareCivilDates(expiryDate, issueDate) <= 0) {
      return t("profile.docsUpload.error.expiryOrder");
    }
    if (note.trim().length < UPLOAD_NOTE_MIN_LENGTH) return t("profile.docsUpload.error.note");
    return null;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const problem = firstProblem();
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (type === null || file === null) return;
    const sentTitle = title.trim();
    upload.mutate(
      {
        type,
        title: sentTitle,
        file,
        issueDate: issueDate === "" ? null : issueDate,
        expiryDate: expiryDate === "" ? null : expiryDate,
        note,
      },
      {
        onSuccess: () => {
          setFile(null);
          setFileControlKey((n) => n + 1);
          setTitle("");
          setIssueDate("");
          setExpiryDate("");
          setNote("");
          setError(null);
          setServerError(null);
          onUploaded(sentTitle);
        },
        onError: (err) => {
          // Ordered by what the employee needs to know, which is whether the
          // file went anywhere:
          //   no digest       → sha256Hex refused BEFORE the upload, so nothing
          //                     was stored and the fix is a secure context.
          //   storage refused → nothing was stored at all; its message says why.
          //   guard refused   → RAISE text written for a person, shown verbatim.
          //   42501 on the row → documents__self__insert (migration
          //                      20260801014000) is not applied here.
          //   anything else    → the bytes are in storage, the row is not, so
          //                      nothing is on the record and HR needs telling.
          if (err instanceof QueryError && err.relation.startsWith("storage/")) {
            // `sha256Hex` is the only storage-relation failure that happens
            // before a single byte moves, and it is the only one raised as
            // 'unknown' — the upload itself always reports 'no_permission'.
            setServerError(
              err.kind === "unknown" ? t("profile.docsUpload.error.checksum") : err.message,
            );
            return;
          }
          if (isRuleRejection(err)) {
            setServerError(err.message);
            return;
          }
          if (err instanceof QueryError && err.kind === "no_permission") {
            setServerError(t("profile.docsUpload.error.refused"));
            return;
          }
          setServerError(t("profile.docsUpload.error.orphan"));
        },
      },
    );
  }

  const typeOptions = types.map((candidate) => ({
    value: candidate.id,
    label: candidate.is_required_for_onboarding
      ? `${candidate.name} — ${t("profile.docsUpload.missing.required")}`
      : candidate.name,
  }));

  return (
    <ProfileCard
      icon={FilePlus2}
      title={t("profile.docsUpload.card.title")}
      description={t("profile.docsUpload.card.hint")}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t("profile.docsUpload.type")}
            value={typeId}
            options={typeOptions}
            placeholder={t("profile.docsUpload.typePlaceholder")}
            onChange={pickType}
            hint={t("profile.docsUpload.typeHint")}
            disabled={upload.isPending}
            required
          />
          <TextField
            label={t("profile.docsUpload.title")}
            value={title}
            onChange={(value) => {
              setTitle(value);
              setError(null);
            }}
            hint={t("profile.docsUpload.titleHint")}
            disabled={upload.isPending}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="profile-doc-file">
            {t("profile.docsUpload.file")}
            <span className="ml-0.5 text-destructive">*</span>
          </Label>
          <Input
            key={fileControlKey}
            id="profile-doc-file"
            type="file"
            disabled={upload.isPending || type === null}
            {...(type !== null && type.allowed_mime_types.length > 0
              ? { accept: type.allowed_mime_types.join(",") }
              : {})}
            onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
          />
          {type !== null ? (
            <p className="text-xs text-muted-foreground">
              {t("profile.docsUpload.fileHint", {
                types: mimeLabels(type.allowed_mime_types),
                mb: type.max_file_size_mb,
              })}
            </p>
          ) : null}
          {file !== null ? (
            <p className="text-xs">
              {t("profile.docsUpload.filePicked", {
                name: file.name,
                size: fmtFileSize(file.size),
              })}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t("profile.docsUpload.issueDate")}
            type="date"
            value={issueDate}
            max={today}
            onChange={(value) => {
              setIssueDate(value);
              setError(null);
            }}
            disabled={upload.isPending}
          />
          <TextField
            label={t("profile.docsUpload.expiryDate")}
            type="date"
            value={expiryDate}
            onChange={(value) => {
              setExpiryDate(value);
              setError(null);
            }}
            disabled={upload.isPending}
            required={type?.requires_expiry ?? false}
            {...(type?.requires_expiry === true
              ? { hint: t("profile.docsUpload.expiryRequiredHint") }
              : {})}
          />
        </div>

        <TextField
          label={t("profile.docsUpload.note")}
          value={note}
          onChange={(value) => {
            setNote(value);
            setError(null);
          }}
          hint={t("profile.docsUpload.noteHint")}
          disabled={upload.isPending}
          required
        />

        <div className="rounded-md border bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Info className="h-4 w-4 shrink-0 text-info" aria-hidden />
            {t("profile.docsUpload.limits.title")}
          </p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t("profile.docsUpload.limits.stored", { bucket: PROFILE_DOCUMENT_BUCKET })}</li>
            <li>{t("profile.docsUpload.limits.review")}</li>
            <li>{t("profile.docsUpload.limits.scan")}</li>
            <li>{t("profile.docsUpload.limits.noDownload")}</li>
          </ul>
        </div>

        {error !== null ? <Notice tone="error">{error}</Notice> : null}
        {serverError !== null ? <Notice tone="error">{serverError}</Notice> : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={upload.isPending}>
            <Upload className="mr-1.5 h-4 w-4" aria-hidden />
            {upload.isPending
              ? t("profile.docsUpload.submitting")
              : t("profile.docsUpload.submit")}
          </Button>
        </div>
      </form>
    </ProfileCard>
  );
}
