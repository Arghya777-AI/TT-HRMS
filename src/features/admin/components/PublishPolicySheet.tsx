/**
 * PublishPolicySheet — upload a policy file and circulate it for acknowledgement.
 *
 * THE SCREEN THIS LIVES ON USED TO SAY IT COULD NOT DO THIS. `PolicyPublication`
 * described itself as "the REGISTER plus the map of the path" and explicitly not
 * an uploader, because nothing in the application inserted a policy document.
 * Migration 042800 supplied the missing half — a read policy so the employee can
 * see what they were given, and `publish_policy` to assign it — so this is the
 * other half: the file, and the choice of audience.
 *
 * ── TWO STEPS, REPORTED SEPARATELY ─────────────────────────────────────────
 *
 * Upload, then circulate. They fail differently and the sheet says which
 * happened, because an upload that succeeds and a circulation that is refused
 * leaves a real document with no audience — and telling HR "publishing failed"
 * would send them to upload the same file a second time. When step 2 fails the
 * sheet keeps the document id and offers to retry the circulation alone.
 *
 * ── READ, OR SIGN ──────────────────────────────────────────────────────────
 *
 * One switch, per document rather than per document type, because the code of
 * conduct is signed and the canteen timings are read and both are POLICY. The
 * signature is the employee typing their own name; the server checks it against
 * their employee record, so a screen cannot lower that bar.
 */
import { useState } from "react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Notice } from "./Notice";
import { SelectField, TextField } from "./Field";
import { Required } from "@/shared/ui/Required";
import { SubmitBlockers, blockerButtonProps, useSubmitAttempt } from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { t } from "@/shared/i18n/en";
import { formatNumber } from "@/lib/format";
import { useDefaultCompanyId, useRefOptions } from "../hooks/useMasters";
import { useProfileId } from "@/shared/api/employee-scope";
import { usePublishPolicy, useUploadPolicyDocument } from "../hooks/useCommsAdmin";
import type { AckDocumentType, PolicyAudience, PolicyDocument } from "../api/comms.api";

/** What the acknowledgement gate charges per page, from migration 025. */
const DWELL_SECONDS_PER_PAGE = 8;

/** One form on this sheet, so one id; the button points at the box with it. */
const BLOCKER_ID = "publish-policy-blockers";

export interface PublishPolicySheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `document_types` that require acknowledgement — POLICY and SOP, live. */
  readonly types: readonly AckDocumentType[];
  /**
   * An EXISTING policy to circulate, instead of uploading a new one.
   *
   * Three approved policies were already sitting in the vault — seeded before any
   * of this — with no assignment rows, which is why every employee's Policies
   * screen was empty while the register said 3. A sheet that could only publish
   * NEW files would have left them there permanently, and asking HR to re-upload
   * a document the system already holds is not a fix.
   */
  readonly existing?: PolicyDocument | null;
}

export function PublishPolicySheet({
  open,
  onOpenChange,
  types,
  existing = null,
}: PublishPolicySheetProps) {
  const companyId = useDefaultCompanyId();
  const actorProfileId = useProfileId();
  const departments = useRefOptions("departments", open);

  const [documentTypeId, setDocumentTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [pageCount, setPageCount] = useState("");

  const [audience, setAudience] = useState<PolicyAudience>("everyone");
  const [departmentId, setDepartmentId] = useState("");
  const [requireSignature, setRequireSignature] = useState(false);

  /** Set when the FILE is registered, so a failed circulation can be retried alone. */
  const [uploadedId, setUploadedId] = useState<string | null>(null);

  const upload = useUploadPolicyDocument();
  const publish = usePublishPolicy();
  const attempt = useSubmitAttempt();

  const circulateOnly = existing !== null;
  const trimmedTitle = circulateOnly ? existing.title : title.trim();

  const blockers: string[] = [];
  if (!circulateOnly) {
    if (documentTypeId === "") blockers.push(t("admin.comms.pol.pub.need.type"));
    if (trimmedTitle.length < 4) blockers.push(t("admin.comms.pol.pub.need.title"));
    if (file === null) blockers.push(t("admin.comms.pol.pub.need.file"));
    if (companyId === null) blockers.push(t("admin.comms.pol.pub.need.company"));
    if (actorProfileId === null) blockers.push(t("admin.comms.pol.pub.need.profile"));
  }
  if (audience === "department" && departmentId === "") {
    blockers.push(t("admin.comms.pol.pub.need.department"));
  }

  const busy = upload.isPending || publish.isPending;

  function reset() {
    setDocumentTypeId("");
    setTitle("");
    setFile(null);
    setEffectiveFrom("");
    setDueOn("");
    setPageCount("");
    setAudience("everyone");
    setDepartmentId("");
    setRequireSignature(false);
    setUploadedId(null);
    upload.reset();
    publish.reset();
    attempt.reset();
  }

  /** Step 2 on its own, so a refused circulation does not re-upload the file. */
  async function circulate(documentId: string) {
    const result = await publish.saveAsync(
      {
        documentId,
        audience,
        departmentId: audience === "department" ? departmentId : null,
        dueOn: dueOn === "" ? null : dueOn,
        requireSignature,
      },
      t("admin.comms.pol.pub.reason", { title: trimmedTitle }),
    );
    confirmSubmitted(
      t("admin.comms.pol.pub.done", { n: formatNumber(result.assigned) }),
      {
        detail:
          result.already > 0
            ? t("admin.comms.pol.pub.doneAlready", { n: formatNumber(result.already) })
            : t("admin.comms.pol.pub.doneDetail"),
      },
    );
    reset();
    onOpenChange(false);
  }

  async function onSubmit() {
    /* `press` reveals the box and returns false when anything is outstanding. */
    if (!attempt.press(blockers)) return;
    try {
      if (circulateOnly) {
        await circulate(existing.id);
        return;
      }
      if (file === null || companyId === null || actorProfileId === null) return;
      const documentId =
        uploadedId ??
        (
          await upload.saveAsync(
            {
              companyId,
              documentTypeId,
              title: trimmedTitle,
              file,
              effectiveFrom: effectiveFrom === "" ? null : effectiveFrom,
              pageCount: pageCount === "" ? null : Number(pageCount),
              actorProfileId,
            },
            t("admin.comms.pol.pub.reason", { title: trimmedTitle }),
          )
        ).id;
      setUploadedId(documentId);
      await circulate(documentId);
    } catch {
      // Both mutations expose `userMessage`; the sheet stays open showing it.
    }
  }

  const typeOptions = types
    .filter((row) => row.is_active)
    .map((row) => ({ value: row.id, label: row.name }));

  const departmentOptions = (departments.data ?? []).map((row) => ({
    value: row.id,
    label: row.name,
  }));

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-display">
            {circulateOnly ? t("admin.comms.pol.circ.title") : t("admin.comms.pol.pub.title")}
          </SheetTitle>
          <SheetDescription>
            {circulateOnly
              ? t("admin.comms.pol.circ.description", { title: existing.title })
              : t("admin.comms.pol.pub.description")}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {uploadedId !== null && publish.userMessage !== null ? (
            <Notice tone="warning">
              <p className="font-medium">{t("admin.comms.pol.pub.uploadedNotCirculated")}</p>
              <p className="mt-1">{t("admin.comms.pol.pub.uploadedNotCirculatedHint")}</p>
            </Notice>
          ) : null}

          {circulateOnly ? null : (
            <>
          <SelectField
            label={t("admin.comms.pol.pub.field.type")}
            value={documentTypeId}
            onChange={setDocumentTypeId}
            options={typeOptions}
            placeholder={t("admin.comms.pol.pub.field.typePlaceholder")}
            hint={t("admin.comms.pol.pub.field.typeHint")}
            required
          />

          <TextField
            label={t("admin.comms.pol.pub.field.title")}
            value={title}
            onChange={setTitle}
            placeholder={t("admin.comms.pol.pub.field.titlePlaceholder")}
            required
          />

          <div>
            <label
              htmlFor="policy-file"
              className="mb-1.5 block text-sm font-medium text-foreground"
            >
              {t("admin.comms.pol.pub.field.file")} <Required />
            </label>
            <input
              id="policy-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                /* A new file is a new document; the id from the last attempt no
                   longer describes what is about to be uploaded. */
                setUploadedId(null);
              }}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.comms.pol.pub.field.fileHint")}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              type="date"
              label={t("admin.comms.pol.pub.field.effective")}
              value={effectiveFrom}
              onChange={setEffectiveFrom}
              hint={t("admin.comms.pol.pub.field.effectiveHint")}
            />
            <TextField
              type="date"
              label={t("admin.comms.pol.pub.field.due")}
              value={dueOn}
              onChange={setDueOn}
              hint={t("admin.comms.pol.pub.field.dueHint")}
            />
          </div>

          <TextField
            label={t("admin.comms.pol.pub.field.pages")}
            value={pageCount}
            onChange={(next) => setPageCount(next.replace(/[^0-9]/g, ""))}
            placeholder="3"
            hint={t("admin.comms.pol.pub.field.pagesHint", { n: DWELL_SECONDS_PER_PAGE })}
          />
            </>
          )}

          {circulateOnly ? (
            <TextField
              type="date"
              label={t("admin.comms.pol.pub.field.due")}
              value={dueOn}
              onChange={setDueOn}
              hint={t("admin.comms.pol.pub.field.dueHint")}
            />
          ) : null}

          <SelectField
            label={t("admin.comms.pol.pub.field.audience")}
            value={audience}
            onChange={(next) => setAudience(next === "department" ? "department" : "everyone")}
            options={[
              { value: "everyone", label: t("admin.comms.pol.pub.audience.everyone") },
              { value: "department", label: t("admin.comms.pol.pub.audience.department") },
            ]}
            hint={t("admin.comms.pol.pub.field.audienceHint")}
            required
          />

          {audience === "department" ? (
            <SelectField
              label={t("admin.comms.pol.pub.field.department")}
              value={departmentId}
              onChange={setDepartmentId}
              options={departmentOptions}
              placeholder={t("admin.comms.pol.pub.field.departmentPlaceholder")}
              required
            />
          ) : null}

          <label className="flex items-start gap-2.5 rounded-lg border bg-card p-3 text-sm">
            <input
              type="checkbox"
              checked={requireSignature}
              onChange={(e) => setRequireSignature(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
            />
            <span>
              <span className="block font-medium">{t("admin.comms.pol.pub.field.sign")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("admin.comms.pol.pub.field.signHint")}
              </span>
            </span>
          </label>

          <SubmitBlockers
            attempt={attempt}
            blockers={blockers}
            id={BLOCKER_ID}
            title={t("admin.comms.pol.pub.blockers")}
          />

          {upload.userMessage !== null ? (
            <Notice tone="error">{upload.userMessage}</Notice>
          ) : null}
          {publish.userMessage !== null ? (
            <Notice tone="error">{publish.userMessage}</Notice>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            {/* Never disabled: pressing it is how somebody learns what is missing. */}
            <Button onClick={() => void onSubmit()} {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}>
              <FileUp className="mr-2 size-4" aria-hidden />
              {busy
                ? t("admin.comms.pol.pub.working")
                : circulateOnly || uploadedId !== null
                  ? t("admin.comms.pol.pub.retryCirculate")
                  : t("admin.comms.pol.pub.cta")}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
