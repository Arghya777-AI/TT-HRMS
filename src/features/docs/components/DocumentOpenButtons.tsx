/**
 * DocumentOpenButtons — View and Download for one document, anywhere a document is
 * listed.
 *
 * ONE COMPONENT, not a pair per screen. Employees asked for this on My Profile and
 * HR asked for it on the vault; both need the same three states (idle, minting,
 * refused) and the same refusal copy. Two implementations would be two chances to
 * forget that a signed URL must not be cached, or to swallow the "the file was never
 * stored" sentence and show a spinner forever.
 *
 * THE ERROR IS SHOWN, NOT SWALLOWED. `document-access` distinguishes a record whose
 * file is missing from a genuine fault, and this deployment has plenty of the
 * former — seeded rows with metadata and no bytes. So a failure prints the sentence
 * beside the button rather than doing nothing, which is what makes somebody click
 * five times and file a bug.
 *
 * NOTHING IS DISABLED ON A GUESS. The button does not try to predict whether the
 * file exists from `file_size_bytes` or `virus_scan_status` — the server knows and
 * the click is how we find out. A button greyed out on a client-side guess cannot
 * explain itself.
 */
import { useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  DocumentOpenError,
  openDocument,
  type DocumentAccessKind,
} from "../api/documentAccess.api";

export interface DocumentOpenButtonsProps {
  readonly documentId: string;
  /** Shown in the aria-label so screen readers hear which document. */
  readonly title?: string | null;
  /** `icon` for dense grids, `text` where there is room for a word. */
  readonly variant?: "icon" | "text";
  /** Offer only View when there is no reason to keep a copy. */
  readonly allowDownload?: boolean;
  readonly className?: string;
}

export function DocumentOpenButtons({
  documentId,
  title,
  variant = "text",
  allowDownload = true,
  className,
}: DocumentOpenButtonsProps) {
  const [busy, setBusy] = useState<DocumentAccessKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: DocumentAccessKind) => {
    setBusy(kind);
    setError(null);
    try {
      await openDocument(documentId, kind);
    } catch (e) {
      // DocumentOpenError already carries reader-facing copy; anything else is
      // unexpected and says so rather than pretending to be a document problem.
      setError(e instanceof DocumentOpenError ? e.message : t("docs.open.error.generic"));
    } finally {
      setBusy(null);
    }
  };

  const named = title !== null && title !== undefined && title !== "" ? title : t("docs.open.thisDocument");

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run("view")}
          aria-label={t("docs.open.viewAria", { name: named })}
        >
          {busy === "view" ? (
            <Loader2 className={cn("size-4 animate-spin", variant === "text" && "mr-2")} aria-hidden />
          ) : (
            <ExternalLink className={cn("size-4", variant === "text" && "mr-2")} aria-hidden />
          )}
          {variant === "text" ? t("docs.open.view") : null}
        </Button>

        {allowDownload ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run("download")}
            aria-label={t("docs.open.downloadAria", { name: named })}
          >
            {busy === "download" ? (
              <Loader2 className={cn("size-4 animate-spin", variant === "text" && "mr-2")} aria-hidden />
            ) : (
              <Download className={cn("size-4", variant === "text" && "mr-2")} aria-hidden />
            )}
            {variant === "text" ? t("docs.open.download") : null}
          </Button>
        ) : null}
      </div>

      {error !== null ? (
        <span className="max-w-[18rem] text-right text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}
