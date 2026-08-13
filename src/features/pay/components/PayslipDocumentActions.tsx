/**
 * View and Download, at the top of the payslip where somebody looks for them.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 *
 * A `window.print()` button, buried in an actions block below the year-to-date
 * tiles. Its output was submitted as evidence and settled the argument: masked
 * amounts (₹•,••,•••), the floating assistant bubble, the search bar, a URL
 * footer on every page, and three pages of mostly whitespace. Nobody can send
 * that to a bank, and nobody scrolls past the whole payslip to find the button
 * that makes it.
 *
 * ── WHICH DOCUMENT YOU GET ─────────────────────────────────────────────────
 *
 * Payroll's, whenever payroll has one. `pdf_document_id` is set by the
 * `payslip-publish` edge function, and that PDF is the signed record — it is
 * fetched through `document-access`, which logs the access before the URL
 * exists. Only when there is no such document does this build the employee's own
 * copy in the browser, footered as exactly that.
 *
 * So the rule `pay.api.ts` states — "the browser DOWNLOADS the authoritative
 * document; it does not render a second, possibly divergent one" — still holds
 * wherever an authoritative document exists. What changed is the case where none
 * does, which today is every payslip, and where the old answer was to offer
 * nothing at all.
 */
import { useState } from "react";
import { Download, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { buildPayslipPdf, payslipFileName, type PayslipPdfInput } from "../payslipPdf";

export interface PayslipDocumentActionsProps {
  /** Everything the builder needs, gathered by the page from its own queries. */
  readonly input: PayslipPdfInput | null;
  /**
   * Payroll's own PDF, when one is published. Given a resolver rather than a URL
   * so the signed link is minted at the moment of the press and cannot go stale
   * sitting in a rendered page.
   */
  readonly officialUrl: (() => Promise<string | null>) | null;
}

type Busy = "view" | "download" | null;

export function PayslipDocumentActions({ input, officialUrl }: PayslipDocumentActionsProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(kind: Exclude<Busy, null>): Promise<void> {
    if (input === null) return;
    setBusy(kind);
    setError(null);
    try {
      // Payroll's document first, every time it exists.
      if (officialUrl !== null) {
        const url = await officialUrl();
        if (url !== null) {
          window.open(url, "_blank", "noopener,noreferrer");
          return;
        }
      }

      const blob = await buildPayslipPdf(input);
      const url = URL.createObjectURL(blob);
      if (kind === "view") {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.download = payslipFileName({
          employeeCode: input.employee.code,
          periodLabel: input.periodLabel,
        });
        a.click();
      }
      /*
        Revoked on a timer, not immediately: a freshly-opened tab has not
        finished reading the object when this function returns, and revoking
        under it produces a blank viewer with no error anywhere.
      */
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pay.viewer.pdf.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1" data-print-hide>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={input === null || busy !== null}
          onClick={() => void open("view")}
        >
          {busy === "view" ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Eye className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          {t("pay.viewer.pdf.view")}
        </Button>
        <Button
          size="sm"
          disabled={input === null || busy !== null}
          onClick={() => void open("download")}
        >
          {busy === "download" ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Download className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          {t("pay.viewer.pdf.download")}
        </Button>
      </div>
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
