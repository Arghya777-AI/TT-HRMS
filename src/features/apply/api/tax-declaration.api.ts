/**
 * tax-declaration.api.ts — the investment declaration the screen said was absent.
 *
 * ── THE GAP WAS THE FORM, NOT THE BACKEND ──────────────────────────────────
 *
 * `/me/apply/tax` told every employee three things:
 *
 *   "The IT Declaration request type points at a table called
 *    income_tax_declarations, and no migration creates it."
 *   "No approval chain is configured for IT Declaration either."
 *   "There is nowhere to declare a section-wise amount (80C, 80D, 80CCD(1B),
 *    24B, HRA, LTA) and nowhere to attach a proof against it."
 *
 * All three are false. Migration 041300 creates the table with every section as
 * its own bigint paise column, a GENERATED `total_deductions_paise`, a
 * `proof_document_ids` array, the three self RLS policies, AND the approval chain
 * — and 042100 attaches the trigger that raises the approval request on submit.
 *
 * The notice was written before 041300 and never revisited, so a statutory
 * feature that exists in the database has been declared missing to everybody who
 * looked. Payroll has meanwhile been computing TDS on the regime alone, because
 * nobody could file the deductions that would reduce it.
 *
 * ── AMOUNTS ARE DECLARED, NOT VERIFIED ─────────────────────────────────────
 *
 * That is the table's own comment and it governs this module. Nothing here
 * validates a section against its statutory ceiling — 80C is 1.5 lakh this year
 * and a different number next year, and a client that hard-codes a limit becomes
 * wrong silently. The employee declares, HR checks against proofs and the Act,
 * and the approval is where the judgement lives.
 */
import { z } from "zod";
import { nowInstantIso } from "@/lib/datetime";
import {
  dbInt,
  dbTimestampNullable,
  dbUuid,
  eq,
  insertRow,
  selectOne,
  updateRow,
} from "@/shared/api/query";

export const TAX_DECLARATIONS_TABLE = "income_tax_declarations";

/**
 * The declarable heads, in the order the Act reads and the form renders.
 *
 * One list, used for the schema, the form and the totals row — a section added
 * here appears everywhere, and none of them can drift apart. Labels are i18n
 * keys resolved by the screen; this module holds no copy.
 */
export const DECLARATION_SECTIONS = [
  { column: "sec_80c_paise", key: "80c" },
  { column: "sec_80ccd_1b_paise", key: "80ccd1b" },
  { column: "sec_80d_paise", key: "80d" },
  { column: "sec_80dd_paise", key: "80dd" },
  { column: "sec_80ddb_paise", key: "80ddb" },
  { column: "sec_80e_paise", key: "80e" },
  { column: "sec_80eeb_paise", key: "80eeb" },
  { column: "sec_80g_paise", key: "80g" },
  { column: "sec_80tta_paise", key: "80tta" },
  { column: "sec_24b_paise", key: "24b" },
  { column: "hra_rent_paid_paise", key: "hraRent" },
] as const;

export type DeclarationSection = (typeof DECLARATION_SECTIONS)[number];

export const taxDeclarationSchema = z.object({
  id: dbUuid,
  employee_id: dbUuid,
  financial_year: z.string(),
  regime: z.string(),
  sec_80c_paise: dbInt,
  sec_80ccd_1b_paise: dbInt,
  sec_80d_paise: dbInt,
  sec_80dd_paise: dbInt,
  sec_80ddb_paise: dbInt,
  sec_80e_paise: dbInt,
  sec_80eeb_paise: dbInt,
  sec_80g_paise: dbInt,
  sec_80tta_paise: dbInt,
  sec_24b_paise: dbInt,
  hra_rent_paid_paise: dbInt,
  hra_landlord_pan: z.string().nullable(),
  other_income_paise: dbInt,
  previous_employer_income_paise: dbInt,
  previous_employer_tds_paise: dbInt,
  /** GENERATED in Postgres. Never computed here — see the module header. */
  total_deductions_paise: dbInt,
  proof_document_ids: z.array(dbUuid),
  declaration_note: z.string().nullable(),
  status: z.string(),
  approval_request_id: dbUuid.nullable(),
  submitted_at: dbTimestampNullable,
});

export type TaxDeclaration = z.infer<typeof taxDeclarationSchema>;

const COLUMNS =
  "id, employee_id, financial_year, regime, sec_80c_paise, sec_80ccd_1b_paise, sec_80d_paise, " +
  "sec_80dd_paise, sec_80ddb_paise, sec_80e_paise, sec_80eeb_paise, sec_80g_paise, " +
  "sec_80tta_paise, sec_24b_paise, hra_rent_paid_paise, hra_landlord_pan, other_income_paise, " +
  "previous_employer_income_paise, previous_employer_tds_paise, total_deductions_paise, " +
  "proof_document_ids, declaration_note, status, approval_request_id, submitted_at";

/**
 * My declaration for one financial year, or null if I have not started one.
 *
 * `itd__self__select` scopes it; the employee filter is for the query key rather
 * than for security. One row per employee-year is the table's own unique index,
 * so this is `selectOne` and not a list.
 */
export function fetchMyTaxDeclaration(
  employeeId: string,
  financialYear: string,
  signal?: AbortSignal,
): Promise<TaxDeclaration | null> {
  return selectOne(
    TAX_DECLARATIONS_TABLE,
    taxDeclarationSchema,
    [eq("employee_id", employeeId), eq("financial_year", financialYear)],
    { columns: COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Amounts in PAISE, keyed by column. The form converts rupees once, on entry. */
export type DeclarationAmounts = Partial<Record<DeclarationSection["column"], number>>;

export interface SaveDeclarationInput {
  readonly employeeId: string;
  readonly financialYear: string;
  readonly regime: string;
  readonly amounts: DeclarationAmounts;
  readonly landlordPan: string | null;
  readonly otherIncomePaise: number;
  readonly previousEmployerIncomePaise: number;
  readonly previousEmployerTdsPaise: number;
  readonly note: string | null;
  /** An existing draft to update, or null to start one. */
  readonly existingId: string | null;
  /**
   * `draft` keeps it editable; `pending` submits it and lets 042100's trigger
   * raise the approval request. The two are one column, so submitting is not a
   * separate write that could half-happen.
   */
  readonly status: "draft" | "pending";
}

function payload(input: SaveDeclarationInput): Record<string, unknown> {
  return {
    employee_id: input.employeeId,
    financial_year: input.financialYear,
    regime: input.regime,
    ...input.amounts,
    hra_landlord_pan: input.landlordPan,
    other_income_paise: input.otherIncomePaise,
    previous_employer_income_paise: input.previousEmployerIncomePaise,
    previous_employer_tds_paise: input.previousEmployerTdsPaise,
    declaration_note: input.note,
    status: input.status,
    /*
      Stamped only on the way to pending. A draft has not been submitted, and a
      submitted_at on a draft would make the SLA clock start on something nobody
      has sent.
    */
    ...(input.status === "pending" ? { submitted_at: nowInstantIso() } : {}),
  };
}

/**
 * Save the declaration — insert on the first save, update thereafter.
 *
 * `total_deductions_paise` is deliberately absent from the payload: it is a
 * GENERATED column and Postgres refuses a write to it. That refusal is a feature
 * — the total on screen and the total payroll reads are the same expression,
 * evaluated once, in one place.
 */
export function saveTaxDeclaration(
  input: SaveDeclarationInput,
  reason: string,
): Promise<TaxDeclaration> {
  const values = payload(input);
  return input.existingId === null
    ? insertRow(TAX_DECLARATIONS_TABLE, values, taxDeclarationSchema, { reason, columns: COLUMNS })
    : /* updateRow takes FILTERS, not an id — and the id alone is the right
         filter here: `itd__self__update` already restricts the row to this
         employee and to a draft or pending status, so the policy is the guard and
         this predicate is just the address. */
      updateRow(
        TAX_DECLARATIONS_TABLE,
        [eq("id", input.existingId)],
        values,
        taxDeclarationSchema,
        { reason, columns: COLUMNS },
      );
}
