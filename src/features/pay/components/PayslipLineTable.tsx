/**
 * PayslipLineTable — one section of the payslip (earnings, deductions, employer
 * contributions, other lines).
 *
 * Not a `<DataGrid>`: a payslip section must render EVERY line with no pager
 * (DR-35 — the reference product paginated a fixed structure "1 – 5 of 9" and
 * counted its own subtotal rows), and its total is a pinned footer read from a
 * header column rather than a data row. Both are things DataGrid deliberately
 * does not do. The <768px card list DataGrid gives for free is reproduced here.
 *
 * `calc_basis` is rendered verbatim: it is the server's proof of how the amount
 * was derived, and paraphrasing it in the browser would be a second, divergent
 * explanation of the same number.
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
import { Badge } from "@/components/ui/badge";
import { Money } from "@/shared/ui/Money";
import { t } from "@/shared/i18n/en";
import { dash } from "@/lib/format";
import type { PayslipLineRow } from "../api/pay.api";

export interface PayslipSectionTotal {
  readonly label: string;
  /** A HEADER column of v_payslip_detail — never a sum of the rows above. */
  readonly paise: number | null;
}

export interface PayslipLineTableProps {
  heading: string;
  /** Why this section exists / how to read it. Rendered under the heading. */
  note?: string;
  lines: readonly PayslipLineRow[];
  /** Money is masked until the page-level session reveal is open. */
  masked: boolean;
  total?: PayslipSectionTotal;
  /** Shown instead of the table when payroll published no lines of this kind. */
  emptyHint: string;
}

function LineBadges({ line }: { line: PayslipLineRow }) {
  return (
    <>
      {line.is_prorated === true ? (
        <Badge variant="neutral" className="ml-2 align-middle">
          {t("pay.viewer.lines.prorated")}
        </Badge>
      ) : null}
      {line.is_arrear === true ? (
        <Badge variant="warning" className="ml-2 align-middle">
          {t("pay.viewer.lines.arrear")}
        </Badge>
      ) : null}
    </>
  );
}

export function PayslipLineTable({
  heading,
  note,
  lines,
  masked,
  total,
  emptyHint,
}: PayslipLineTableProps) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b p-4">
        <h3 className="font-display text-base font-semibold">{heading}</h3>
        {note ? <p className="mt-1 text-sm text-muted-foreground">{note}</p> : null}
      </div>

      {lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{emptyHint}</p>
      ) : (
        <>
          {/* ≥768px: table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("pay.viewer.lines.col.label")}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t("pay.viewer.lines.col.basis")}
                  </TableHead>
                  <TableHead className="hidden xl:table-cell text-right">
                    {t("pay.viewer.lines.col.fullMonth")}
                  </TableHead>
                  <TableHead className="text-right">{t("pay.viewer.lines.col.amount")}</TableHead>
                  <TableHead className="hidden lg:table-cell text-right">
                    {t("pay.viewer.lines.col.ytd")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.line_id ?? line.label ?? String(line.sequence)}>
                    <TableCell>
                      <span className="font-medium">{dash(line.label)}</span>
                      <LineBadges line={line} />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {dash(line.calc_basis)}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell num text-right">
                      <Money paise={line.full_month_amount_paise} masked={masked} />
                    </TableCell>
                    <TableCell className="num text-right">
                      <Money paise={line.amount_paise} masked={masked} />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell num text-right">
                      <Money paise={line.ytd_amount_paise} masked={masked} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {total ? (
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell className="font-semibold">{total.label}</TableCell>
                    <TableCell className="hidden lg:table-cell" />
                    <TableCell className="hidden xl:table-cell" />
                    <TableCell className="num text-right font-semibold">
                      <Money paise={total.paise} masked={masked} />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell" />
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>

          {/* <768px: card list */}
          <ul className="divide-y md:hidden">
            {lines.map((line) => (
              <li key={line.line_id ?? line.label ?? String(line.sequence)} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-medium">
                    {dash(line.label)}
                    <LineBadges line={line} />
                  </p>
                  <p className="num shrink-0 font-medium">
                    <Money paise={line.amount_paise} masked={masked} />
                  </p>
                </div>
                {line.calc_basis !== null ? (
                  <p className="mt-1 text-xs text-muted-foreground">{line.calc_basis}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("pay.viewer.lines.col.ytd")}:{" "}
                  <Money paise={line.ytd_amount_paise} masked={masked} />
                </p>
              </li>
            ))}
            {total ? (
              <li className="flex items-center justify-between gap-3 bg-muted/50 p-4">
                <p className="font-semibold">{total.label}</p>
                <p className="num font-semibold">
                  <Money paise={total.paise} masked={masked} />
                </p>
              </li>
            ) : null}
          </ul>
        </>
      )}
    </section>
  );
}
