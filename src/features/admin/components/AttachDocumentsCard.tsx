/**
 * AttachDocumentsCard — the admin attaching documents to an employee they just created.
 *
 * WHY IT IS ON THE SUCCESS SCREEN AND NOT A WIZARD STEP. `documents.employee_id` is NOT
 * NULL for `subject_kind = 'employee'`, and `employee_code` is allocated by a trigger, so
 * there is no employee to attach anything to until the INSERT has happened. A step that
 * held files in memory across four screens and uploaded them afterwards would look
 * tidier and would introduce the one failure this flow must not have: an employee created
 * and their paperwork silently lost because the last upload failed after the point of no
 * return. Here the employee already exists, each file is its own attempt, and a failure
 * costs that file and nothing else.
 *
 * ONE FILE AT A TIME, ON PURPOSE. Each document needs its own TYPE, and often its own
 * issue and expiry dates — an Aadhaar and a degree certificate are not interchangeable
 * rows. A multi-file picker would have to ask for all of that per file anyway, in a grid
 * nobody can read on a phone. The list of what has been attached so far sits underneath,
 * so the admin can see the pile grow.
 *
 * EXPIRY IS DEMANDED WHEN THE TYPE DEMANDS IT (`requires_expiry`), because a document
 * whose expiry nobody recorded cannot appear in the expiry report, and its absence there
 * reads as "nothing expires soon".
 */
import { useMemo, useState } from "react";
import { CheckCircle2, FileUp, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { mutationUserMessage } from "@/shared/api/query";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { attachEmployeeDocument, type AttachedDocument } from "../api/employee-documents.api";
import { useUploadableDocumentTypes } from "@/features/profile/hooks/useProfileDocumentUpload";
import { useAuth } from "@/app/auth/AuthProvider";

export interface AttachDocumentsCardProps {
  readonly employeeId: string;
  readonly employeeLabel: string;
  readonly companyId: string | null;
}

export function AttachDocumentsCard({
  employeeId,
  employeeLabel,
  companyId,
}: AttachDocumentsCardProps) {
  const types = useUploadableDocumentTypes();
  const { session } = useAuth();
  const actorProfileId = session?.user.id ?? null;

  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [issueDate, setIssueDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<AttachedDocument[]>([]);

  const options = useMemo(
    () => (types.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    [types.data],
  );
  const chosen = (types.data ?? []).find((row) => row.id === typeId) ?? null;
  const needsExpiry = chosen?.requires_expiry === true;

  const ready =
    file !== null &&
    chosen !== null &&
    title.trim() !== "" &&
    companyId !== null &&
    actorProfileId !== null &&
    (!needsExpiry || expiryDate !== "");

  function reset(): void {
    setFile(null);
    setTitle("");
    setIssueDate("");
    setExpiryDate("");
    setNote("");
    setTypeId("");
  }

  function submit(): void {
    if (!ready || chosen === null || file === null || companyId === null || actorProfileId === null) {
      return;
    }
    setBusy(true);
    setError(null);
    void attachEmployeeDocument({
      employeeId,
      companyId,
      actorProfileId,
      type: chosen,
      title,
      file,
      issueDate: issueDate === "" ? null : issueDate,
      expiryDate: expiryDate === "" ? null : expiryDate,
      note,
    })
      .then((row) => {
        setAttached((prev) => [...prev, row]);
        reset();
      })
      .catch((err: unknown) => setError(mutationUserMessage(err)))
      .finally(() => setBusy(false));
  }

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
        <Paperclip className="size-4 text-primary" aria-hidden />
        {t("admin.attachDocs.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("admin.attachDocs.hint", { name: employeeLabel })}
      </p>

      {attached.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {attached.map((row) => (
            <li key={row.id} className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
              {row.title}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t("admin.attachDocs.type")}
          value={typeId}
          options={options}
          onChange={(next) => {
            setTypeId(next);
            setError(null);
          }}
          placeholder="—"
          required
          disabled={busy}
          hint={t("admin.attachDocs.typeHint")}
        />
        <TextField
          label={t("admin.attachDocs.docTitle")}
          value={title}
          onChange={setTitle}
          required
          disabled={busy}
          placeholder={t("admin.attachDocs.docTitlePlaceholder")}
        />
        <TextField
          label={t("admin.attachDocs.issue")}
          value={issueDate}
          onChange={setIssueDate}
          type="date"
          disabled={busy}
        />
        <TextField
          label={
            needsExpiry ? t("admin.attachDocs.expiryRequired") : t("admin.attachDocs.expiry")
          }
          value={expiryDate}
          onChange={setExpiryDate}
          type="date"
          disabled={busy}
          {...(needsExpiry ? { required: true, hint: t("admin.attachDocs.expiryHint") } : {})}
        />
      </div>

      <div className="mt-3">
        <TextField
          label={t("admin.attachDocs.note")}
          value={note}
          onChange={setNote}
          disabled={busy}
          hint={t("admin.attachDocs.noteHint")}
          placeholder={t("admin.attachDocs.notePlaceholder")}
        />
      </div>

      {/* Native input: there is no file atom in this project, and adding one for a single
          screen would fork a vocabulary twelve master screens already share. */}
      <label className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3">
        <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          type="file"
          disabled={busy}
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            setFile(picked);
            setError(null);
            // A sensible default title, still editable — an admin attaching six files
            // should not have to invent six names.
            if (picked !== null && title.trim() === "") {
              setTitle(picked.name.replace(/\.[^.]+$/, ""));
            }
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

      {actorProfileId === null ? (
        <div className="mt-3">
          <Notice tone="warning">{t("admin.attachDocs.noActor")}</Notice>
        </div>
      ) : null}

      <Button type="button" size="sm" className="mt-3" disabled={!ready || busy} onClick={submit}>
        {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
        {t("admin.attachDocs.action")}
      </Button>

      <p className="mt-2 text-[0.7rem] text-muted-foreground">{t("admin.attachDocs.approvedNote")}</p>
    </section>
  );
}
