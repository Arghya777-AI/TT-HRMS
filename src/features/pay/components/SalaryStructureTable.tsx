/**
 * SalaryStructureTable — E-08 Card A. The structure in force today, WHOLE.
 *
 * DR-35 is the whole point of this component: the reference product paginated a
 * nine-row fixed structure to "1 – 5 of 9", counted its own subtotal rows in
 * that 9, and made the columns sortable — so "GROSS SALARY (A)" could be sorted
 * away from the rows it totals. Here:
 *   - every component renders, on one page, with no pager and no sort;
 *   - the A / B / C / CTC rows are PINNED footer rows, not data rows;
 *   - each pinned figure is a view column (`bucket_a_monthly_paise`,
 *     `monthly_ctc_paise`, …) computed by window functions inside
 *     `v_employee_current_salary` — the browser adds nothing.
 *
 * Below 768px it becomes a card list, like every other table in the product.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Money } from "@/shared/ui/Money";
import { t } from "@/shared/i18n/en";
import { dash } from "@/lib/format";
import { ctcBucketLabel, structureLines } from "../display";
import type { CurrentSalaryLine } from "../api/pay.api";

export interface SalaryStructureTableProps {
  /** All rows of `v_employee_current_salary` for the caller. */
  rows: readonly CurrentSalaryLine[];
  masked: boolean;
}

interface PinnedRow {
  key: string;
  label: string;
  monthly: number | null;
  annual: number | null;
  emphasis: boolean;
}

export function SalaryStructureTable({ rows, masked }: SalaryStructureTableProps) {
  const header = rows[0];
  if (header === undefined) return null;
  const lines = structureLines(rows);

  /**
   * The pinned rows. `annual_ctc_paise` is a stored column; the bucket rows have
   * no annual counterpart in the view, so their yearly cell shows '—' rather
   * than a browser-multiplied figure. Bucket B is listed only when the employee
   * actually has variable components, so nobody reads a phantom '₹0' as a cut.
   */
  const pinned: PinnedRow[] = [
    {
      key: "gross",
      label: t("pay.salary.total.gross"),
      monthly: header.monthly_gross_paise,
      annual: null,
      emphasis: false,
    },
  ];
  if (header.bucket_b_monthly_paise !== null && header.bucket_b_monthly_paise > 0) {
    pinned.push({
      key: "variable",
      label: t("pay.salary.total.variable"),
      monthly: header.bucket_b_monthly_paise,
      annual: null,
      emphasis: false,
    });
  }
  pinned.push(
    {
      key: "employer",
      label: t("pay.salary.total.employer"),
      monthly: header.monthly_employer_contribution_paise,
      annual: null,
      emphasis: false,
    },
    {
      key: "ctc",
      label: t("pay.salary.total.ctc"),
      monthly: header.monthly_ctc_paise,
      annual: header.annual_ctc_paise,
      emphasis: true,
    },
  );

  return (
    <div>
      {/* ≥768px: table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("pay.salary.col.component")}</TableHead>
              <TableHead className="hidden lg:table-cell">{t("pay.salary.col.bucket")}</TableHead>
              <TableHead className="text-right">{t("pay.salary.col.monthly")}</TableHead>
              <TableHead className="text-right">{t("pay.salary.col.annual")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.line_id ?? String(line.sequence)}>
                <TableCell className="font-medium">{dash(line.component_name)}</TableCell>
                <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                  {ctcBucketLabel(line.ctc_bucket)}
                </TableCell>
                <TableCell className="num text-right">
                  <Money paise={line.monthly_amount_paise} masked={masked} />
                </TableCell>
                <TableCell className="num text-right">
                  <Money paise={line.annual_amount_paise} masked={masked} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            {pinned.map((row) => (
              <TableRow
                key={row.key}
                className={`hover:bg-transparent ${row.emphasis ? "bg-secondary/70 dark:bg-muted" : ""}`}
              >
                <TableCell className="font-semibold">{row.label}</TableCell>
                <TableCell className="hidden lg:table-cell" />
                <TableCell className="num text-right font-semibold">
                  <Money paise={row.monthly} masked={masked} />
                </TableCell>
                <TableCell className="num text-right font-semibold">
                  <Money paise={row.annual} masked={masked} />
                </TableCell>
              </TableRow>
            ))}
          </TableFooter>
        </Table>
      </div>

      {/* <768px: card list */}
      <ul className="divide-y md:hidden">
        {lines.map((line) => (
          <li key={line.line_id ?? String(line.sequence)} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-medium">{dash(line.component_name)}</p>
              <p className="num shrink-0 font-medium">
                <Money paise={line.monthly_amount_paise} masked={masked} />
              </p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("pay.salary.col.annual")}: <Money paise={line.annual_amount_paise} masked={masked} />
            </p>
          </li>
        ))}
        {pinned.map((row) => (
          <li
            key={row.key}
            className={`flex items-center justify-between gap-3 p-4 ${
              row.emphasis ? "bg-secondary/60 dark:bg-muted" : "bg-muted/50"
            }`}
          >
            <p className="font-semibold">{row.label}</p>
            <p className="num font-semibold">
              <Money paise={row.monthly} masked={masked} />
            </p>
          </li>
        ))}
      </ul>

      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        {t("pay.salary.full", { count: lines.length })}
      </p>
    </div>
  );
}
