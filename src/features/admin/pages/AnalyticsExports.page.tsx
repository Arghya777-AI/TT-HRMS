/**
 * §14 · /admin/analytics/exports — Data Exports. What can leave this system,
 * through which server path, and under what controls.
 *
 * This screen deliberately has no "Export" button on it. An export is a PII
 * EGRESS EVENT: the only sanctioned way one happens is a server function that
 * writes the `export_log` row in the same breath as it produces the file, so the
 * register can never disagree with reality. A browser-side CSV built from rows
 * already on screen would leave no register row, no content hash and no row
 * count — it would be an unaudited egress dressed as a feature. So this page is
 * a CATALOGUE plus the controls, and it links to the register.
 *
 * What is actually deployed, checked against supabase/functions and migration
 * 006 rather than assumed:
 *
 *   * ONE export function exists: `export-audit`. It produces the audit evidence
 *     pack (subject `audit_log`, kind `audit_dump`), demands a ≥15-character
 *     reason, and returns a row count, a SHA-256 content hash and an expiry.
 *   * `export_log`'s own CHECK constraints enumerate the eight SUBJECTS and seven
 *     KINDS the register is able to record — that list is the roadmap, not a
 *     claim that each one is built. Every subject other than `audit_log` has no
 *     function behind it yet, and this page says so in as many words.
 *   * The register enforces approval in SQL, not in the UI:
 *     `NOT (contains_salary OR row_count > 500) OR approved_by IS NOT NULL`.
 *     A salary-bearing or large export without a named approver cannot be
 *     inserted at all.
 *
 * @route /admin/analytics/exports
 */
import { Link } from "react-router-dom";
import { Database, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { formatNumber } from "@/lib/format";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";

/** `export_log.ck_export_log__approval` — the SQL threshold, not a UI choice. */
const APPROVAL_ROW_THRESHOLD = 500;

const AVAILABILITY: Readonly<Record<string, StatusChipEntry>> = {
  available: { label: t("admin.aexp.state.available"), tone: "success" },
  not_built: { label: t("admin.aexp.state.notBuilt"), tone: "neutral" },
};

interface DatasetEntry {
  /** `export_log.subject` — one of the eight values the CHECK constraint allows. */
  readonly subject: string;
  readonly nameKey: MessageKey;
  readonly contentKey: MessageKey;
  /** The deployed server path, or the key that says none exists. */
  readonly pathKey: MessageKey;
  readonly state: "available" | "not_built";
}

const DATASETS: readonly DatasetEntry[] = [
  {
    subject: "audit_log",
    nameKey: "admin.aexp.ds.audit.name",
    contentKey: "admin.aexp.ds.audit.content",
    pathKey: "admin.aexp.ds.audit.path",
    state: "available",
  },
  {
    subject: "employees",
    nameKey: "admin.aexp.ds.employees.name",
    contentKey: "admin.aexp.ds.employees.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "attendance",
    nameKey: "admin.aexp.ds.attendance.name",
    contentKey: "admin.aexp.ds.attendance.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "payroll",
    nameKey: "admin.aexp.ds.payroll.name",
    contentKey: "admin.aexp.ds.payroll.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "leave",
    nameKey: "admin.aexp.ds.leave.name",
    contentKey: "admin.aexp.ds.leave.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "documents",
    nameKey: "admin.aexp.ds.documents.name",
    contentKey: "admin.aexp.ds.documents.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "assets",
    nameKey: "admin.aexp.ds.assets.name",
    contentKey: "admin.aexp.ds.assets.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
  {
    subject: "face_match_log",
    nameKey: "admin.aexp.ds.faceMatch.name",
    contentKey: "admin.aexp.ds.faceMatch.content",
    pathKey: "admin.aexp.ds.none",
    state: "not_built",
  },
];

/** Every control below is enforced server-side; the UI only explains it. */
const CONTROLS: readonly { readonly nameKey: MessageKey; readonly detailKey: MessageKey }[] = [
  { nameKey: "admin.aexp.ctl.purpose.name", detailKey: "admin.aexp.ctl.purpose.detail" },
  { nameKey: "admin.aexp.ctl.approval.name", detailKey: "admin.aexp.ctl.approval.detail" },
  { nameKey: "admin.aexp.ctl.hash.name", detailKey: "admin.aexp.ctl.hash.detail" },
  { nameKey: "admin.aexp.ctl.flags.name", detailKey: "admin.aexp.ctl.flags.detail" },
  { nameKey: "admin.aexp.ctl.immutable.name", detailKey: "admin.aexp.ctl.immutable.detail" },
  { nameKey: "admin.aexp.ctl.reveal.name", detailKey: "admin.aexp.ctl.reveal.detail" },
];

/** `export_log.ck_export_log__kind` — the file kinds the register can record. */
const KINDS = [
  "csv",
  "xlsx",
  "pdf",
  "bank_advice",
  "audit_dump",
  "api_bulk",
  "ai_infographic_data",
] as const;

export default function AnalyticsExportsPage() {
  const built = DATASETS.filter((d) => d.state === "available").length;

  return (
    <div className="container py-6">
      <PageHeader
        icon={Database}
        title={t("admin.aexp.title")}
        subtitle={t("admin.aexp.subtitle", {
          built: formatNumber(built),
          total: formatNumber(DATASETS.length),
        })}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/audit/exports">{t("admin.aexp.toRegister")}</Link>
          </Button>
        }
      />

      <div className="mt-4 space-y-2">
        <Notice tone="info">{t("admin.aexp.note.serverOnly")}</Notice>
        <Notice tone="warning">{t("admin.aexp.note.oneFunction")}</Notice>
      </div>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.aexp.datasets.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aexp.datasets.hint")}</p>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[13rem]">{t("admin.aexp.col.dataset")}</TableHead>
                <TableHead>{t("admin.aexp.col.contents")}</TableHead>
                <TableHead className="w-[16rem]">{t("admin.aexp.col.path")}</TableHead>
                <TableHead className="w-[9rem]">{t("admin.aexp.col.state")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DATASETS.map((dataset) => (
                <TableRow key={dataset.subject}>
                  <TableCell className="align-top">
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium">{t(dataset.nameKey)}</span>
                      <code className="num text-xs text-muted-foreground">{dataset.subject}</code>
                    </span>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(dataset.contentKey)}
                  </TableCell>
                  <TableCell className="align-top text-sm">{t(dataset.pathKey)}</TableCell>
                  <TableCell className="align-top">
                    <StatusChip status={dataset.state} map={AVAILABILITY} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aexp.controls.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("admin.aexp.controls.hint", { rows: formatNumber(APPROVAL_ROW_THRESHOLD) })}
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[16rem]">{t("admin.aexp.col.control")}</TableHead>
                <TableHead>{t("admin.aexp.col.enforcement")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CONTROLS.map((control) => (
                <TableRow key={control.nameKey}>
                  <TableCell className="align-top font-medium">{t(control.nameKey)}</TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(control.detailKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="mt-8 rounded-lg border bg-card p-4">
        <h2 className="font-display text-base font-semibold">{t("admin.aexp.kinds.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aexp.kinds.hint")}</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {KINDS.map((kind) => (
            <li key={kind}>
              <code className="num rounded border bg-muted px-2 py-1 text-xs">{kind}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold">{t("admin.aexp.gaps.heading")}</h2>
        <ul className="mt-2 space-y-2">
          <li className="rounded-lg border bg-card p-3 text-sm">
            <span className="font-medium">{t("admin.aexp.gap.warehouse.name")}</span>
            <p className="mt-1 text-muted-foreground">{t("admin.aexp.gap.warehouse.why")}</p>
          </li>
          <li className="rounded-lg border bg-card p-3 text-sm">
            <span className="font-medium">{t("admin.aexp.gap.api.name")}</span>
            <p className="mt-1 text-muted-foreground">{t("admin.aexp.gap.api.why")}</p>
          </li>
          <li className="rounded-lg border bg-card p-3 text-sm">
            <span className="font-medium">{t("admin.aexp.gap.bank.name")}</span>
            <p className="mt-1 text-muted-foreground">{t("admin.aexp.gap.bank.why")}</p>
          </li>
          <li className="rounded-lg border bg-card p-3 text-sm">
            <span className="font-medium">{t("admin.aexp.gap.scheduled.name")}</span>
            <p className="mt-1 text-muted-foreground">{t("admin.aexp.gap.scheduled.why")}</p>
          </li>
        </ul>
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="outline" asChild>
          <Link to="/admin/audit/exports">
            <ShieldCheck className="mr-2 size-4" aria-hidden />
            {t("admin.aexp.toRegister")}
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/admin/audit/data-access">{t("admin.aexp.toDataAccess")}</Link>
        </Button>
      </div>
    </div>
  );
}
