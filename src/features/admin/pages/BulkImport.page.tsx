/**
 * §3.4 · /admin/people/import — Bulk Import. A spreadsheet import that REJECTS
 * rather than coerces.
 *
 * The importer is the deployed `employee-import` edge function; this screen is
 * its console and adds no validation of its own. That is deliberate: a second
 * validator in the browser would drift from the one that actually decides, and
 * the operator would be told "47 rows are fine" by code that never sees the
 * database. Every number on this page is a field of the function's own answer.
 *
 * The `1.0202E+11` defence, as the user experiences it (spec-roadmap §4.1):
 *   * CSV ONLY. A workbook is refused — by the function, and by this screen before
 *     the upload, with the same sentence. By the time Excel has a `.xlsx` cell in
 *     memory, `1020212345` is already a float; the conversion must happen in the
 *     spreadsheet, where the FORMATTED text still exists.
 *   * Every identifier stays text. Scientific notation, a pincode that lost its
 *     leading zero, a padded Aadhaar, an Excel date serial and a Unicode
 *     look-alike are ROW REJECTIONS that quote the offending cell back.
 *   * Staging first, always. Step 2 writes `import_batches` + `import_rows` and
 *     not one employee; step 3 is refused by the server while any rejection
 *     remains. The reconciliation block — per-column blank counts, a SHA-256 over
 *     each identifier column's raw text, and the first ten rows verbatim — is what
 *     lets the operator prove the file arrived unmangled.
 *
 * THREE HONEST LIMITS, stated on the screen rather than discovered at 07:00:
 *   1. The importer CREATES. An existing employee code is `DUPLICATE_IN_DATABASE`,
 *      not an update; §3.4's "3 updated (11 fields)" has no server path.
 *   2. There is no rollback. `import_batches.rollback_at` exists as a column, but
 *      no function writes it, so §3.4's 24-hour window is not real yet.
 *   3. No compensation, no login. The function inserts `employees` plus
 *      statutory / bank / address / contact satellites — salary and credentials
 *      are separate, audited acts on their own screens.
 *
 * `employee.import` carries `requires_step_up`, so both actions catch
 * `MFA_STEP_UP_REQUIRED`, take the authenticator code, and retry the SAME
 * idempotent call.
 *
 * @route /admin/people/import
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Download,
  FileSpreadsheet,
  ListChecks,
  ShieldAlert,
  Table2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { SelectField, TextField } from "../components/Field";
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  REQUIRED_IMPORT_HEADERS,
  TEMPLATE_FILE_NAME,
  fileSizeLabel,
  importErrorSummarySchema,
  importMappingSchema,
  importRowIssueListSchema,
  templateCsv,
  type ImportBatch,
  type ImportColumnGroup,
  type ImportColumnSpec,
  type ImportDelimiter,
  type ImportReportedRow,
  type ImportRow,
  type CommitReport,
  type StageReport,
} from "../api/imports.api";
import {
  useImportBatches,
  useImportCommit,
  useImportRowCount,
  useImportRows,
  useImportStage,
} from "../hooks/useEmployeeImport";

/** A workbook never reaches the wire — refused here with the server's reason. */
const WORKBOOK_RE = /\.(xlsx|xls|xlsm|numbers|ods)$/i;

const BATCH_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  uploaded: { label: t("admin.import.batch.uploaded"), tone: "neutral" },
  validating: { label: t("admin.import.batch.validating"), tone: "info" },
  validated: { label: t("admin.import.batch.validated"), tone: "info" },
  importing: { label: t("admin.import.batch.importing"), tone: "warn" },
  completed: { label: t("admin.import.batch.completed"), tone: "success" },
  failed: { label: t("admin.import.batch.failed"), tone: "danger" },
  rolled_back: { label: t("admin.import.batch.rolledBack"), tone: "neutral" },
};

const ROW_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("admin.import.row.pending"), tone: "neutral" },
  valid: { label: t("admin.import.row.valid"), tone: "info" },
  invalid: { label: t("admin.import.row.invalid"), tone: "danger" },
  imported: { label: t("admin.import.row.imported"), tone: "success" },
  skipped: { label: t("admin.import.row.skipped"), tone: "neutral" },
};

const GROUP_LABEL: Readonly<Record<ImportColumnGroup, MessageKey>> = {
  identity: "admin.import.group.identity",
  employment: "admin.import.group.employment",
  timeRules: "admin.import.group.timeRules",
  statutory: "admin.import.group.statutory",
  bank: "admin.import.group.bank",
  personal: "admin.import.group.personal",
  address: "admin.import.group.address",
  emergency: "admin.import.group.emergency",
};

const KIND_LABEL: Readonly<Record<ImportColumnSpec["kind"], MessageKey>> = {
  text: "admin.import.kind.text",
  identifier: "admin.import.kind.identifier",
  date: "admin.import.kind.date",
  enum: "admin.import.kind.enum",
  integer: "admin.import.kind.integer",
  boolean: "admin.import.kind.boolean",
  ref: "admin.import.kind.ref",
  email: "admin.import.kind.email",
};

function delimiterOptions(): { value: ImportDelimiter; label: string }[] {
  return [
    { value: ",", label: t("admin.import.delimiter.comma") },
    { value: ";", label: t("admin.import.delimiter.semicolon") },
    { value: "\t", label: t("admin.import.delimiter.tab") },
  ];
}

/** Identifies the upload on screen: any change invalidates the staged report. */
function uploadSignature(
  file: File | null,
  delimiter: string,
  companyCode: string,
): string {
  if (file === null) return "";
  return [file.name, file.size, file.lastModified, delimiter, companyCode].join("|");
}

/** A numbered step frame — the order of the three acts is visible, not implied. */
function Step({
  index,
  title,
  hint,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span
          className="num mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          aria-hidden
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold leading-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
          <div className="mt-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

/** The cell-level issues of one rejected or warned row, quoted as the server sent them. */
function IssueLines({ row }: { row: ImportReportedRow }) {
  return (
    <ul className="space-y-1.5">
      {row.issues.map((issue, index) => (
        <li key={`${issue.code}-${issue.column}-${index}`} className="text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <Badge variant={issue.severity === "error" ? "danger" : "warning"}>{issue.code}</Badge>
            {issue.field !== null ? (
              <code className="text-xs text-muted-foreground">{issue.field}</code>
            ) : null}
          </span>
          <span className="mt-0.5 block text-muted-foreground">{issue.detail}</span>
          {issue.rawValue !== "" ? (
            <span className="mt-0.5 block text-xs">
              {t("admin.import.issue.cellWas")}{" "}
              <code className="num rounded bg-muted px-1 py-0.5">{issue.rawValue}</code>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Reconciliation: the evidence that the file arrived with its digits intact. */
function ReconciliationCard({ report }: { report: StageReport }) {
  const checksums = Object.entries(report.reconciliation.identifierChecksums);
  const blanks = Object.entries(report.reconciliation.nullCounts).filter(([, n]) => n > 0);
  const spotColumns = Object.keys(report.reconciliation.spotCheck[0] ?? {}).filter(
    (key) => key !== "row_number",
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("admin.import.recon.checksums")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("admin.import.recon.checksumsHint")}
        </p>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          {checksums.map(([field, digest]) => (
            <div key={field} className="rounded-md border bg-background px-3 py-2">
              <dt className="font-mono text-xs text-muted-foreground">{field}</dt>
              <dd className="num mt-0.5 break-all text-xs">{digest}</dd>
            </div>
          ))}
        </dl>
      </div>

      {report.reconciliation.spotCheck.length > 0 && spotColumns.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">{t("admin.import.recon.spotCheck")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.import.recon.spotCheckHint")}
          </p>
          <div className="mt-2 overflow-x-auto rounded-md border bg-background">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t("admin.import.col.row")}
                  </th>
                  {spotColumns.map((column) => (
                    <th key={column} className="px-2 py-1.5 text-left font-mono font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.reconciliation.spotCheck.map((row) => (
                  <tr key={row["row_number"]} className="border-b last:border-b-0">
                    <td className="num px-2 py-1.5">{row["row_number"]}</td>
                    {spotColumns.map((column) => (
                      <td key={column} className="num px-2 py-1.5">
                        {dash(row[column] === "" ? null : row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {blanks.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">{t("admin.import.recon.blanks")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("admin.import.recon.blanksHint")}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {blanks.map(([field, count]) => (
              <li key={field}>
                <Badge variant="neutral">
                  <span className="font-mono">{field}</span>
                  <span className="num ml-1">{formatNumber(count)}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default function BulkImportPage() {
  const [params, setParams] = useSearchParams();
  const stepUp = useStepUp();

  const [file, setFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState<ImportDelimiter>(",");
  const [companyCode, setCompanyCode] = useState("");
  const [showColumns, setShowColumns] = useState(false);

  /** The staged report on screen, with the upload it was produced for. */
  const [staged, setStaged] = useState<{ signature: string; report: StageReport } | null>(null);

  const stage = useImportStage();
  const commit = useImportCommit();

  const batches = useImportBatches(25);
  const selectedBatchId = params.get("batch");
  const rejectedRows = useImportRows(selectedBatchId, ["invalid"], 200);
  const rejectedCount = useImportRowCount(selectedBatchId, ["invalid"]);
  const importedCount = useImportRowCount(selectedBatchId, ["imported"]);

  const signature = uploadSignature(file, delimiter, companyCode);
  const reviewed = staged !== null && staged.signature === signature && signature !== "";
  const staleReview = staged !== null && staged.signature !== signature;
  const report = reviewed ? staged.report : null;

  /** Blank-template download — a header line, so there is nothing to audit. */
  const templateHref = useMemo(
    () => `data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv())}`,
    [],
  );

  const fileError: string | null =
    file === null
      ? null
      : WORKBOOK_RE.test(file.name)
        ? t("admin.import.error.workbook")
        : file.size > MAX_IMPORT_FILE_BYTES
          ? t("admin.import.error.tooLarge", { max: fileSizeLabel(MAX_IMPORT_FILE_BYTES) })
          : file.size === 0
            ? t("admin.import.error.empty")
            : null;

  const canStage = file !== null && fileError === null;

  function pickFile(next: File | null): void {
    setFile(next);
    // A new file has not been reviewed, so the commit closes again.
    setStaged(null);
  }

  function setUploadOption(apply: () => void): void {
    apply();
    setStaged(null);
  }

  function selectBatch(batchId: string | null): void {
    const next = new URLSearchParams(params);
    if (batchId === null) next.delete("batch");
    else next.set("batch", batchId);
    setParams(next, { replace: true });
  }

  // ── Step 1 · the column reference ───────────────────────────────────────────
  const columnColumns: DataGridColumn<ImportColumnSpec>[] = useMemo(
    () => [
      {
        key: "header",
        header: t("admin.import.col.header"),
        width: "16rem",
        render: (row) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <code className="text-xs">{row.header}</code>
            {row.required === true ? (
              <Badge variant="warning">{t("admin.import.required")}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: "group",
        header: t("admin.import.col.group"),
        width: "10rem",
        hideBelow: "md",
        render: (row) => t(GROUP_LABEL[row.group]),
      },
      {
        key: "kind",
        header: t("admin.import.col.kind"),
        width: "9rem",
        hideBelow: "sm",
        render: (row) => t(KIND_LABEL[row.kind]),
      },
      {
        key: "rules",
        header: t("admin.import.col.rules"),
        render: (row) => {
          const parts: string[] = [];
          if (row.fixedDigits !== undefined) {
            parts.push(t("admin.import.rule.fixedDigits", { n: row.fixedDigits }));
          }
          if (row.reference !== undefined) {
            parts.push(t("admin.import.rule.reference", { table: row.reference }));
          }
          if (row.enumValues !== undefined) {
            parts.push(row.enumValues.join(" · "));
          }
          if (parts.length === 0) return <span className="text-muted-foreground">{dash(null)}</span>;
          return <span className="text-xs text-muted-foreground">{parts.join(" — ")}</span>;
        },
      },
    ],
    [],
  );

  // ── Step 2 · the rejection and warning grids ────────────────────────────────
  const reportedColumns: DataGridColumn<ImportReportedRow>[] = useMemo(
    () => [
      {
        key: "rowNumber",
        header: t("admin.import.col.row"),
        width: "8rem",
        sortable: true,
        sortValue: (row) => row.rowNumber,
        render: (row) => (
          <span className="flex flex-col leading-tight">
            <span className="num text-sm font-medium">
              {t("admin.import.rowLabel", { n: row.rowNumber })}
            </span>
            <span className="num text-xs text-muted-foreground">
              {t("admin.import.csvLine", { n: row.csvLine })}
            </span>
          </span>
        ),
      },
      {
        key: "employeeCode",
        header: t("admin.import.col.employeeCode"),
        width: "10rem",
        hideBelow: "sm",
        render: (row) => <code className="num text-xs">{dash(row.employeeCode)}</code>,
      },
      {
        key: "issues",
        header: t("admin.import.col.issues"),
        render: (row) => <IssueLines row={row} />,
      },
    ],
    [],
  );

  // ── Step 4 · the batch register ─────────────────────────────────────────────
  const batchColumns: DataGridColumn<ImportBatch>[] = useMemo(
    () => [
      {
        key: "file",
        header: t("admin.import.col.file"),
        render: (row) => {
          const mapping = importMappingSchema.safeParse(row.mapping);
          const sha = mapping.success ? (mapping.data.source?.sha256 ?? null) : null;
          return (
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-medium">{dash(row.original_file_name)}</span>
              <span className="num text-xs text-muted-foreground">
                {fmtDateTime(row.created_at)}
              </span>
              {sha !== null ? (
                <code className="num mt-0.5 text-xs text-muted-foreground">
                  {t("admin.import.shaShort", { sha: sha.slice(0, 16) })}
                </code>
              ) : null}
            </span>
          );
        },
      },
      {
        key: "status",
        header: t("admin.import.col.status"),
        width: "10rem",
        render: (row) => (
          <span className="flex flex-col items-start gap-1">
            <StatusChip status={row.status} map={BATCH_CHIP} />
            {row.dry_run ? (
              <span className="text-xs text-muted-foreground">
                {t("admin.import.batch.dryRunOnly")}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "rows",
        header: t("admin.import.col.rows"),
        align: "right",
        width: "7rem",
        render: (row) => <span className="num">{formatNumber(row.row_count)}</span>,
      },
      {
        key: "valid",
        header: t("admin.import.col.valid"),
        align: "right",
        width: "7rem",
        hideBelow: "md",
        render: (row) => <span className="num">{formatNumber(row.valid_count)}</span>,
      },
      {
        key: "invalid",
        header: t("admin.import.col.rejected"),
        align: "right",
        width: "7rem",
        render: (row) => (
          <span className={row.invalid_count > 0 ? "num text-destructive" : "num"}>
            {formatNumber(row.invalid_count)}
          </span>
        ),
      },
      {
        key: "imported",
        header: t("admin.import.col.imported"),
        align: "right",
        width: "8rem",
        render: (row) => (
          <span className={row.imported_count > 0 ? "num text-success" : "num"}>
            {formatNumber(row.imported_count)}
          </span>
        ),
      },
      {
        key: "codes",
        header: t("admin.import.col.topCodes"),
        hideBelow: "lg",
        render: (row) => {
          const summary = importErrorSummarySchema.safeParse(row.error_summary);
          const byCode = summary.success ? (summary.data.by_code ?? null) : null;
          const entries = Object.entries(byCode ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
          if (entries.length === 0) {
            return <span className="text-xs text-muted-foreground">{dash(null)}</span>;
          }
          return (
            <span className="flex flex-wrap gap-1">
              {entries.map(([code, count]) => (
                <Badge key={code} variant="neutral">
                  {code} <span className="num ml-1">{formatNumber(count)}</span>
                </Badge>
              ))}
            </span>
          );
        },
      },
    ],
    [],
  );

  const rejectedRowColumns: DataGridColumn<ImportRow>[] = useMemo(
    () => [
      {
        key: "row_number",
        header: t("admin.import.col.row"),
        width: "7rem",
        sortable: true,
        render: (row) => (
          <span className="num text-sm">{t("admin.import.rowLabel", { n: row.row_number })}</span>
        ),
      },
      {
        key: "status",
        header: t("admin.import.col.status"),
        width: "9rem",
        render: (row) => <StatusChip status={row.status} map={ROW_CHIP} />,
      },
      {
        key: "errors",
        header: t("admin.import.col.issues"),
        render: (row) => {
          const issues = importRowIssueListSchema.safeParse(row.errors);
          if (!issues.success || issues.data.length === 0) {
            return <span className="text-xs text-muted-foreground">{dash(null)}</span>;
          }
          return (
            <ul className="space-y-1">
              {issues.data.map((issue, index) => (
                <li key={`${issue.code}-${index}`} className="text-xs">
                  <Badge variant={issue.severity === "error" ? "danger" : "warning"}>
                    {issue.code}
                  </Badge>{" "}
                  <span className="text-muted-foreground">{issue.detail}</span>
                  {issue.raw !== "" ? (
                    <code className="num ml-1 rounded bg-muted px-1">{issue.raw}</code>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        },
      },
    ],
    [],
  );

  const commitReport = commit.data ?? null;
  const commitBlocked: string | null =
    report === null
      ? t("admin.import.commit.blocked.noDryRun")
      : report.totals.invalid > 0
        ? t("admin.import.commit.blocked.rejections", {
            n: formatNumber(report.totals.invalid),
          })
        : report.nextStep !== "commit"
          ? t("admin.import.commit.blocked.serverSaysNo")
          : commitReport !== null && !commitReport.partial
            ? t("admin.import.commit.blocked.done")
            : null;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Users}
        title={t("admin.import.title")}
        subtitle={t("admin.import.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <a href={templateHref} download={TEMPLATE_FILE_NAME}>
              <Download className="mr-2 size-4" aria-hidden />
              {t("admin.import.template.download")}
            </a>
          </Button>
        }
      />

      <Notice tone="info">{t("admin.import.intro")}</Notice>
      <Notice tone="warning" className="mt-2">
        {t("admin.import.limits")}
      </Notice>

      {/* ── STEP 1 · Template + column reference ───────────────────────────── */}
      <Step
        index={1}
        title={t("admin.import.step1.title")}
        hint={t("admin.import.step1.hint")}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" asChild>
            <a href={templateHref} download={TEMPLATE_FILE_NAME}>
              <Download className="mr-2 size-4" aria-hidden />
              {t("admin.import.template.download")}
            </a>
          </Button>
          <Button variant="ghost" onClick={() => setShowColumns((open) => !open)}>
            <Table2 className="mr-2 size-4" aria-hidden />
            {showColumns
              ? t("admin.import.columns.hide")
              : t("admin.import.columns.show", { n: formatNumber(IMPORT_COLUMNS.length) })}
          </Button>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          {t("admin.import.step1.required", { headers: REQUIRED_IMPORT_HEADERS.join(", ") })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.import.step1.quoting", { rows: formatNumber(MAX_IMPORT_ROWS) })}
        </p>

        {showColumns ? (
          <div className="mt-4">
            <DataGrid
              columns={columnColumns}
              rows={IMPORT_COLUMNS}
              rowKey={(row) => row.header}
              pageSize={25}
            />
          </div>
        ) : null}
      </Step>

      {/* ── STEP 2 · Upload and validate ───────────────────────────────────── */}
      <Step
        index={2}
        title={t("admin.import.step2.title")}
        hint={t("admin.import.step2.hint")}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="import-file">{t("admin.import.field.file")}</Label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              className="flex h-10 w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-invalid={fileError !== null}
              {...(fileError !== null ? { "aria-describedby": "import-file-error" } : {})}
            />
            {file !== null ? (
              <p className="text-xs text-muted-foreground">
                {t("admin.import.field.fileChosen", {
                  name: file.name,
                  size: fileSizeLabel(file.size),
                })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("admin.import.field.fileHint", {
                  max: fileSizeLabel(MAX_IMPORT_FILE_BYTES),
                })}
              </p>
            )}
            {fileError !== null ? (
              <p id="import-file-error" className="text-xs font-medium text-destructive" role="alert">
                {fileError}
              </p>
            ) : null}
          </div>

          <SelectField
            label={t("admin.import.field.delimiter")}
            value={delimiter}
            options={delimiterOptions()}
            hint={t("admin.import.field.delimiterHint")}
            onChange={(value) =>
              setUploadOption(() => setDelimiter((value === ";" || value === "\t" ? value : ",")))
            }
          />

          <TextField
            label={t("admin.import.field.companyCode")}
            value={companyCode}
            hint={t("admin.import.field.companyCodeHint")}
            onChange={(value) => setUploadOption(() => setCompanyCode(value))}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ReasonActionButton
            label={
              <>
                <Upload className="mr-2 size-4" aria-hidden />
                {t("admin.import.action.validate")}
              </>
            }
            variant="default"
            size="default"
            minLength={stage.minReasonLength}
            title={t("admin.import.validate.title")}
            description={t("admin.import.validate.description", {
              name: file?.name ?? dash(null),
            })}
            disabled={!canStage || stage.isPending}
            disabledHint={
              canStage ? t("admin.import.action.validating") : t("admin.import.action.pickFirst")
            }
            onConfirm={async (reason) => {
              if (file === null) return;
              const input = { file, delimiter, ...(companyCode !== "" ? { companyCode } : {}) };
              const target = uploadSignature(file, delimiter, companyCode);
              let result: StageReport;
              try {
                result = await stage.saveAsync(input, reason);
              } catch (error) {
                // `employee.import` is a step-up capability: on an aal1 session the
                // function refuses before reading the file. Verify, then replay the
                // same idempotent upload.
                if (!isStepUpRequired(error)) throw error;
                const upgraded = await stepUp.ensureAal2();
                if (!upgraded) return;
                result = await stage.saveAsync(input, reason);
              }
              setStaged({ signature: target, report: result });
              toast.success(
                t("admin.import.validated", {
                  valid: formatNumber(result.totals.valid),
                  rows: formatNumber(result.totals.rows),
                }),
              );
            }}
          />
          {staleReview ? (
            <span className="text-sm text-warning">{t("admin.import.step2.stale")}</span>
          ) : null}
        </div>

        {stage.userMessage !== null ? (
          <Notice tone="error" className="mt-4">
            {stage.userMessage}
          </Notice>
        ) : null}

        <div className="mt-4">
          <StateBoundary
            loading={stage.isPending}
            isEmpty={report === null}
            empty={
              <EmptyState
                icon={FileSpreadsheet}
                title={t("admin.import.step2.empty.title")}
                hint={t("admin.import.step2.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            {report !== null ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("admin.import.report.header", {
                    name: report.file.name,
                    columns: formatNumber(report.columns.count),
                    company: report.company.code ?? dash(null),
                  })}
                </p>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <KpiTile
                    label={t("admin.import.kpi.rows")}
                    value={formatNumber(report.totals.rows)}
                  />
                  <KpiTile
                    label={t("admin.import.kpi.valid")}
                    value={formatNumber(report.totals.valid)}
                    tone={report.totals.valid > 0 ? "success" : "neutral"}
                  />
                  <KpiTile
                    label={t("admin.import.kpi.rejected")}
                    value={formatNumber(report.totals.invalid)}
                    tone={report.totals.invalid > 0 ? "danger" : "success"}
                    {...(report.totals.invalid > 0
                      ? { hint: t("admin.import.kpi.rejectedHint") }
                      : {})}
                  />
                  <KpiTile
                    label={t("admin.import.kpi.warned")}
                    value={formatNumber(report.totals.rowsWithWarnings)}
                    tone={report.totals.rowsWithWarnings > 0 ? "warn" : "neutral"}
                  />
                </div>

                {report.totals.invalid === 0 ? (
                  <Notice tone="success">{t("admin.import.report.clean")}</Notice>
                ) : (
                  <Notice tone="error">
                    {t("admin.import.report.dirty", {
                      n: formatNumber(report.totals.invalid),
                    })}
                  </Notice>
                )}

                <ReconciliationCard report={report} />

                {report.rejections.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-medium">{t("admin.import.rejections.heading")}</h3>
                    {report.rejectionsTruncated ? (
                      <Notice tone="warning" className="mt-2">
                        {t("admin.import.rejections.truncated", {
                          shown: formatNumber(report.rejections.length),
                          total: formatNumber(report.totals.invalid),
                        })}
                      </Notice>
                    ) : null}
                    <div className="mt-2">
                      <DataGrid
                        columns={reportedColumns}
                        rows={report.rejections}
                        rowKey={(row) => `reject-${row.rowNumber}`}
                        pageSize={10}
                      />
                    </div>
                  </div>
                ) : null}

                {report.warnings.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-medium">{t("admin.import.warnings.heading")}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("admin.import.warnings.hint")}
                    </p>
                    <div className="mt-2">
                      <DataGrid
                        columns={reportedColumns}
                        rows={report.warnings}
                        rowKey={(row) => `warn-${row.rowNumber}`}
                        pageSize={10}
                      />
                    </div>
                  </div>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  {t("admin.import.report.batchRef", { id: report.batchId })}
                </p>
              </div>
            ) : null}
          </StateBoundary>
        </div>
      </Step>

      {/* ── STEP 3 · Commit ────────────────────────────────────────────────── */}
      <Step
        index={3}
        title={t("admin.import.step3.title")}
        hint={t("admin.import.step3.hint")}
      >
        <div className="flex flex-wrap items-center gap-3">
          <ReasonActionButton
            label={t("admin.import.action.commit")}
            variant="default"
            size="default"
            minLength={commit.minReasonLength}
            title={t("admin.import.commit.title")}
            description={t("admin.import.commit.description", {
              n: formatNumber(report?.totals.valid ?? 0),
              name: report?.file.name ?? dash(null),
            })}
            disabled={commitBlocked !== null || commit.isPending}
            {...(commitBlocked !== null ? { disabledHint: commitBlocked } : {})}
            onConfirm={async (reason) => {
              if (report === null) return;
              const input = {
                batchId: report.batchId,
                ...(commitReport?.resume ? { afterRowNumber: commitReport.resume.afterRowNumber } : {}),
              };
              let result: CommitReport;
              try {
                result = await commit.saveAsync(input, reason);
              } catch (error) {
                if (!isStepUpRequired(error)) throw error;
                const upgraded = await stepUp.ensureAal2();
                if (!upgraded) return;
                result = await commit.saveAsync(input, reason);
              }
              toast.success(
                t("admin.import.committed", {
                  n: formatNumber(result.totals.importedThisCall),
                }),
              );
            }}
          />
          {commitBlocked !== null ? (
            <span className="text-sm text-muted-foreground">{commitBlocked}</span>
          ) : null}
        </div>

        {commit.userMessage !== null ? (
          <Notice tone="error" className="mt-4">
            {commit.userMessage}
          </Notice>
        ) : null}

        {commitReport !== null ? (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <KpiTile
                label={t("admin.import.kpi.created")}
                value={formatNumber(commitReport.totals.importedTotal)}
                tone="success"
              />
              <KpiTile
                label={t("admin.import.kpi.thisCall")}
                value={formatNumber(commitReport.totals.importedThisCall)}
              />
              <KpiTile
                label={t("admin.import.kpi.managers")}
                value={formatNumber(commitReport.managersLinked)}
                hint={t("admin.import.kpi.managersHint")}
              />
              <KpiTile
                label={t("admin.import.kpi.remaining")}
                value={formatNumber(commitReport.totals.remaining)}
                tone={commitReport.totals.remaining > 0 ? "warn" : "success"}
              />
            </div>

            {commitReport.partial ? (
              <Notice tone="warning">
                {t("admin.import.commit.partial", {
                  n: formatNumber(commitReport.totals.remaining),
                })}
              </Notice>
            ) : (
              <Notice
                tone="success"
                action={
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/people">{t("admin.import.commit.openDirectory")}</Link>
                  </Button>
                }
              >
                {t("admin.import.commit.done", {
                  n: formatNumber(commitReport.totals.importedTotal),
                })}
              </Notice>
            )}

            {commitReport.created.length > 0 ? (
              <div>
                <h3 className="text-sm font-medium">{t("admin.import.created.heading")}</h3>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {commitReport.created.map((row) => (
                    <li key={row.employeeId}>
                      <Badge variant="success">
                        <Link to={`/admin/people/${row.employeeCode}`} className="num">
                          {row.employeeCode}
                        </Link>
                      </Badge>
                    </li>
                  ))}
                </ul>
                {commitReport.createdTruncated ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.import.created.truncated", {
                      shown: formatNumber(commitReport.created.length),
                      total: formatNumber(commitReport.totals.importedTotal),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Step>

      {/* ── STEP 4 · The batch register ────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.import.register.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.import.register.hint")}</p>

        <div className="mt-3">
          <StateBoundary
            loading={batches.isLoading}
            error={batches.error ?? undefined}
            onRetry={() => void batches.refetch()}
            isEmpty={batches.isSuccess && (batches.data?.length ?? 0) === 0}
            empty={
              <EmptyState
                icon={ListChecks}
                title={t("admin.import.register.empty.title")}
                hint={t("admin.import.register.empty.hint")}
              />
            }
            skeletonRows={4}
          >
            <DataGrid
              columns={batchColumns}
              rows={batches.data ?? []}
              rowKey={(row) => row.id}
              pageSize={10}
              onRowClick={(row) => selectBatch(row.id === selectedBatchId ? null : row.id)}
            />
          </StateBoundary>
        </div>

        {selectedBatchId !== null ? (
          <div className="mt-4 rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold">
                  {t("admin.import.batchRows.heading")}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("admin.import.batchRows.counts", {
                    rejected: formatNumber(rejectedCount.data ?? 0),
                    imported: formatNumber(importedCount.data ?? 0),
                  })}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => selectBatch(null)}>
                {t("admin.import.batchRows.close")}
              </Button>
            </div>

            <div className="mt-3">
              <StateBoundary
                loading={rejectedRows.isLoading}
                error={rejectedRows.error ?? undefined}
                onRetry={() => void rejectedRows.refetch()}
                isEmpty={rejectedRows.isSuccess && (rejectedRows.data?.length ?? 0) === 0}
                empty={
                  <EmptyState
                    icon={ListChecks}
                    title={t("admin.import.batchRows.empty.title")}
                    hint={t("admin.import.batchRows.empty.hint")}
                  />
                }
                skeletonRows={3}
              >
                <DataGrid
                  columns={rejectedRowColumns}
                  rows={rejectedRows.data ?? []}
                  rowKey={(row) => row.id}
                  pageSize={10}
                />
              </StateBoundary>
            </div>
          </div>
        ) : null}
      </section>

      <div className="mt-6 space-y-2">
        <Notice tone="info">{t("admin.import.note.raw")}</Notice>
        <Notice tone="info">
          <span className="flex flex-wrap items-center gap-1">
            <ShieldAlert className="size-4 shrink-0 text-info" aria-hidden />
            {t("admin.import.note.stepUp")}
          </span>
        </Notice>
      </div>

      {stepUp.dialog}
    </div>
  );
}
