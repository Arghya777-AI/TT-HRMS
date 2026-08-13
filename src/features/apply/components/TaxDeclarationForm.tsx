/**
 * TaxDeclarationForm — the investment declaration, which existed in the database
 * and nowhere on screen.
 *
 * `/me/apply/tax` carried three bullets saying the table, the chain and the
 * section-wise fields were all absent. Migration 041300 created every one of them
 * — eleven section columns in paise, a GENERATED total, `proof_document_ids`, the
 * three self RLS policies and the approval chain — and 042100 attached the trigger
 * that raises the approval request on submit. The notice predated 041300 and was
 * never revisited, so a statutory feature has been declared missing to everybody
 * who looked, while payroll computed TDS on the regime alone because nobody could
 * file the deductions that would reduce it.
 *
 * ── WHAT THIS FORM DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not check a section against its statutory ceiling. 80C is ₹1.5 lakh
 * this year and may not be next, and a limit hard-coded in a browser becomes
 * quietly wrong the year it changes — the employee DECLARES, HR verifies against
 * proofs and the Act, and the approval is where that judgement belongs. The
 * table's own comment says the same thing.
 *
 * It does not total the sections either. `total_deductions_paise` is GENERATED in
 * Postgres, so the figure on screen and the figure payroll reads are one
 * expression evaluated once. A client-side sum would be a second answer.
 */
import { useState } from "react";
import { FileText, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/admin/components/Notice";
import { TextField } from "@/features/admin/components/Field";
import {
  SubmitAttemptScope,
  SubmitBlockers,
  blockerButtonProps,
  useSubmitAttempt,
} from "@/shared/ui/SubmitBlockers";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { SplitBar } from "@/shared/ui/charts/SplitBar";
import { formatPaise } from "@/lib/money";
import { t } from "@/shared/i18n/en";
import type { MessageKey } from "@/shared/i18n/en";
import { useMyTaxDeclaration, useSaveTaxDeclaration } from "../hooks/useApply";
import {
  DECLARATION_SECTIONS,
  type DeclarationAmounts,
  type TaxDeclaration,
} from "../api/tax-declaration.api";

const BLOCKER_ID = "tax-declaration-blockers";

/** Rupees as typed → integer paise. One conversion, at the edge. */
function toPaise(text: string): number {
  const rupees = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0;
}

function toRupees(paise: number): string {
  return paise === 0 ? "" : String(paise / 100);
}

export interface TaxDeclarationFormProps {
  readonly financialYear: string | null;
  /** The regime already elected above; the declaration inherits it. */
  readonly regime: string;
}

export function TaxDeclarationForm({ financialYear, regime }: TaxDeclarationFormProps) {
  const existing = useMyTaxDeclaration(financialYear);
  const save = useSaveTaxDeclaration();
  const attempt = useSubmitAttempt();

  const row: TaxDeclaration | null = existing.data ?? null;
  /*
    Seeded from the saved row ONCE per row identity. A controlled field that reads
    straight from the query would fight the person typing every time the query
    refetches.
  */
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [landlordPan, setLandlordPan] = useState("");
  const [otherIncome, setOtherIncome] = useState("");
  const [prevIncome, setPrevIncome] = useState("");
  const [prevTds, setPrevTds] = useState("");
  const [note, setNote] = useState("");

  const identity = row?.id ?? "new";
  if (seededFor !== identity) {
    setSeededFor(identity);
    setAmounts(
      Object.fromEntries(
        DECLARATION_SECTIONS.map((s) => [s.column, row === null ? "" : toRupees(row[s.column])]),
      ),
    );
    setLandlordPan(row?.hra_landlord_pan ?? "");
    setOtherIncome(row === null ? "" : toRupees(row.other_income_paise));
    setPrevIncome(row === null ? "" : toRupees(row.previous_employer_income_paise));
    setPrevTds(row === null ? "" : toRupees(row.previous_employer_tds_paise));
    setNote(row?.declaration_note ?? "");
  }

  /* Already decided: the figures are HR's record now, not a draft to edit. */
  const locked = row !== null && !["draft", "pending"].includes(row.status);

  const paise: DeclarationAmounts = Object.fromEntries(
    DECLARATION_SECTIONS.map((s) => [s.column, toPaise(amounts[s.column] ?? "")]),
  ) as DeclarationAmounts;

  const declaredTotal = Object.values(paise).reduce((sum, v) => sum + (v ?? 0), 0);
  const rentDeclared = paise.hra_rent_paid_paise ?? 0;

  const blockers: string[] = [];
  if (financialYear === null) blockers.push(t("apply.tax.decl.need.fy"));
  if (declaredTotal === 0) blockers.push(t("apply.tax.decl.need.something"));
  /*
    An HRA claim without the landlord's PAN is the one rule worth enforcing here,
    because it is not a limit that changes with the Finance Act — above ₹1 lakh of
    rent a year the PAN is mandatory, and a declaration missing it will be sent
    back. Better to say so now than after HR reads it.
  */
  if (rentDeclared >= 10_000_000 && landlordPan.trim() === "") {
    blockers.push(t("apply.tax.decl.need.pan"));
  }

  function submit(status: "draft" | "pending"): void {
    if (status === "pending" && !attempt.press(blockers)) return;
    if (financialYear === null) return;
    save
      .saveAsync(
        {
          financialYear,
          regime,
          amounts: paise,
          landlordPan: landlordPan.trim() === "" ? null : landlordPan.trim().toUpperCase(),
          otherIncomePaise: toPaise(otherIncome),
          previousEmployerIncomePaise: toPaise(prevIncome),
          previousEmployerTdsPaise: toPaise(prevTds),
          note: note.trim() === "" ? null : note.trim(),
          existingId: row?.id ?? null,
          status,
        },
        status === "pending"
          ? t("apply.tax.decl.reason.submit", { fy: financialYear })
          : t("apply.tax.decl.reason.draft", { fy: financialYear }),
      )
      .then((saved) => {
        confirmSubmitted(
          status === "pending" ? t("apply.tax.decl.sent") : t("apply.tax.decl.saved"),
          {
            detail:
              status === "pending"
                ? t("apply.tax.decl.sentDetail")
                : t("apply.tax.decl.savedDetail", {
                    total: formatPaise(saved.total_deductions_paise),
                  }),
          },
        );
      })
      .catch(() => undefined);
  }

  return (
    <div className="space-y-4">
      {locked ? (
        <Notice tone="info">
          {t("apply.tax.decl.locked", { status: row?.status ?? "" })}
        </Notice>
      ) : null}

      <SubmitAttemptScope attempt={attempt}>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t("apply.tax.decl.hint")}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DECLARATION_SECTIONS.map((section) => (
              <TextField
                key={section.column}
                label={t(`apply.tax.decl.section.${section.key}` as MessageKey)}
                value={amounts[section.column] ?? ""}
                onChange={(next) =>
                  setAmounts((prev) => ({ ...prev, [section.column]: next.replace(/[^0-9.]/g, "") }))
                }
                inputMode="decimal"
                placeholder="0"
                disabled={locked}
              />
            ))}
          </div>

          {rentDeclared > 0 ? (
            <div className="mt-3 max-w-sm">
              <TextField
                label={t("apply.tax.decl.landlordPan")}
                value={landlordPan}
                onChange={(next) => setLandlordPan(next.toUpperCase())}
                hint={t("apply.tax.decl.landlordPanHint")}
                disabled={locked}
                {...(rentDeclared >= 10_000_000 ? { required: true } : {})}
              />
            </div>
          ) : null}

          <h3 className="mt-6 font-display text-sm font-semibold">
            {t("apply.tax.decl.otherHeading")}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("apply.tax.decl.otherHint")}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <TextField
              label={t("apply.tax.decl.otherIncome")}
              value={otherIncome}
              onChange={(next) => setOtherIncome(next.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={locked}
            />
            <TextField
              label={t("apply.tax.decl.prevIncome")}
              value={prevIncome}
              onChange={(next) => setPrevIncome(next.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={locked}
            />
            <TextField
              label={t("apply.tax.decl.prevTds")}
              value={prevTds}
              onChange={(next) => setPrevTds(next.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={locked}
            />
          </div>

          <div className="mt-4">
            <label htmlFor="decl-note" className="mb-1.5 block text-sm font-medium">
              {t("apply.tax.decl.note")}
            </label>
            <textarea
              id="decl-note"
              rows={2}
              maxLength={1000}
              value={note}
              disabled={locked}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {/*
            The shape of what has been declared, from the SAVED row's generated
            total where there is one — so the picture is Postgres's arithmetic and
            not the browser's. Before the first save there is nothing to draw.
          */}
          {row !== null && row.total_deductions_paise > 0 ? (
            <div className="mt-5">
              <SplitBar
                title={t("apply.tax.decl.mix")}
                showShare
                height={12}
                format={(v) => formatPaise(v)}
                totalCaption={t("apply.tax.decl.total", {
                  total: formatPaise(row.total_deductions_paise),
                })}
                segments={DECLARATION_SECTIONS.filter((s) => row[s.column] > 0).map((s, i) => ({
                  key: s.column,
                  label: t(`apply.tax.decl.section.${s.key}` as MessageKey),
                  value: row[s.column],
                  /* Deductions reduce tax — the earning tone, alternating with the
                     employer tone so eleven adjacent sections stay separable. */
                  tone: i % 2 === 0 ? "earning" : "employer",
                }))}
              />
            </div>
          ) : null}

          <SubmitBlockers
            attempt={attempt}
            blockers={blockers}
            id={BLOCKER_ID}
            title={t("apply.tax.decl.blockers")}
          />

          {save.userMessage !== null ? (
            <div className="mt-3">
              <Notice tone="error">{save.userMessage}</Notice>
            </div>
          ) : null}

          {locked ? null : (
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="outline" disabled={save.isPending} onClick={() => submit("draft")}>
                <FileText className="mr-2 size-4" aria-hidden />
                {t("apply.tax.decl.saveDraft")}
              </Button>
              <Button
                {...blockerButtonProps(attempt, blockers, BLOCKER_ID)}
                disabled={save.isPending}
                onClick={() => submit("pending")}
              >
                <Send className="mr-2 size-4" aria-hidden />
                {save.isPending ? t("apply.tax.decl.sending") : t("apply.tax.decl.send")}
              </Button>
            </div>
          )}
        </div>
      </SubmitAttemptScope>
    </div>
  );
}
