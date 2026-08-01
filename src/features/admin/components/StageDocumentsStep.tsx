/**
 * StageDocumentsStep — collect documents DURING Add Employee, upload them the instant the
 * employee exists.
 *
 * WHY STAGING AND NOT UPLOADING. `documents.employee_id` is NOT NULL for an employee
 * subject and `employee_code` comes from a database trigger, so until the INSERT there is
 * nobody to attach anything to. The card on the success screen was therefore correct and
 * in the wrong place: an administrator adding somebody with a folder of paperwork in front
 * of them expects to hand it over as part of the flow, not after being told the flow
 * finished.
 *
 * So the step holds `File` objects in memory, the Review step lists them, and the creation
 * path uploads them the moment the id exists. Nothing here pretends to save.
 *
 * FAILURES ARE PER FILE AND NAMED. If three of four attach, the screen says which one did
 * not and why, and the same card is still on the success screen to retry it. The employee
 * is committed by then and must never look like a failed creation — an admin who reads
 * "could not be saved" over somebody who exists will add them again.
 */
import { useMemo, useState } from "react";
import { FileUp, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { useUploadableDocumentTypes } from "@/features/profile/hooks/useProfileDocumentUpload";
import type { UploadableDocumentType } from "@/features/profile/api/documents.api";

/** One document waiting for an employee id. */
export interface StagedDocument {
  /** Stable key for the list — files have no id of their own. */
  readonly key: string;
  readonly type: UploadableDocumentType;
  readonly title: string;
  readonly file: File;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly note: string;
}

export interface StageDocumentsStepProps {
  readonly staged: readonly StagedDocument[];
  readonly onChange: (next: readonly StagedDocument[]) => void;
  readonly disabled?: boolean;
}

export function StageDocumentsStep({
  staged,
  onChange,
  disabled = false,
}: StageDocumentsStepProps) {
  const types = useUploadableDocumentTypes();
  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(
    () => (types.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [types.data],
  );
  const chosen = (types.data ?? []).find((row) => row.id === typeId) ?? null;
  const needsExpiry = chosen?.requires_expiry === true;

  function add(): void {
    if (chosen === null) {
      setError(t("admin.stageDocs.needType"));
      return;
    }
    if (file === null) {
      setError(t("admin.stageDocs.needFile"));
      return;
    }
    if (needsExpiry && expiryDate === "") {
      setError(t("admin.stageDocs.needExpiry"));
      return;
    }
    setError(null);
    onChange([
      ...staged,
      {
        // `file.name` alone is not unique — two scans can both be `image.jpg`.
        key: `${chosen.code}-${file.name}-${String(staged.length)}`,
        type: chosen,
        title: title.trim() === "" ? file.name.replace(/\.[^.]+$/, "") : title.trim(),
        file,
        issueDate: issueDate === "" ? null : issueDate,
        expiryDate: expiryDate === "" ? null : expiryDate,
        note,
      },
    ]);
    setTypeId("");
    setTitle("");
    setFile(null);
    setIssueDate("");
    setExpiryDate("");
    setNote("");
  }

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
        <Paperclip className="size-4 text-primary" aria-hidden />
        {t("admin.stageDocs.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("admin.stageDocs.hint")}</p>

      {staged.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          {t("admin.stageDocs.empty")}
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {staged.map((doc) => (
            <li
              key={doc.key}
              className="flex items-center gap-2 rounded-md border bg-background/60 px-3 py-2"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{doc.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {doc.type.name} · {doc.file.name}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={t("admin.stageDocs.remove")}
                onClick={() => onChange(staged.filter((row) => row.key !== doc.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t("admin.attachDocs.type")}
          value={typeId}
          options={options}
          onChange={(next) => {
            setTypeId(next);
            setError(null);
          }}
          placeholder="—"
          disabled={disabled}
          hint={t("admin.attachDocs.typeHint")}
        />
        <TextField
          label={t("admin.attachDocs.docTitle")}
          value={title}
          onChange={setTitle}
          disabled={disabled}
          placeholder={t("admin.attachDocs.docTitlePlaceholder")}
        />
        <TextField
          label={t("admin.attachDocs.issue")}
          value={issueDate}
          onChange={setIssueDate}
          type="date"
          disabled={disabled}
        />
        <TextField
          label={needsExpiry ? t("admin.attachDocs.expiryRequired") : t("admin.attachDocs.expiry")}
          value={expiryDate}
          onChange={setExpiryDate}
          type="date"
          disabled={disabled}
          {...(needsExpiry ? { hint: t("admin.attachDocs.expiryHint") } : {})}
        />
      </div>

      <div className="mt-3">
        <TextField
          label={t("admin.attachDocs.note")}
          value={note}
          onChange={setNote}
          disabled={disabled}
          hint={t("admin.attachDocs.noteHint")}
          placeholder={t("admin.attachDocs.notePlaceholder")}
        />
      </div>

      <label className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3">
        <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="file"
          disabled={disabled}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError(null);
          }}
          className="min-w-0 flex-1 text-xs file:mr-3 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs"
          aria-label={t("admin.attachDocs.pick")}
        />
      </label>

      {error !== null ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={add}>
          {t("admin.stageDocs.add")}
        </Button>
        {staged.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("admin.stageDocs.staged", { n: formatNumber(staged.length) })}
          </span>
        ) : null}
      </div>
    </section>
  );
}
