/**
 * §9 · /admin/documents/templates — Letter & Contract Templates.
 *
 * WHERE TEMPLATES LIVE. `document_types.template_id` points at
 * `public.contract_templates` (migration 026, FK added in 049), and that table is
 * the one `document-generate` renders: `body_markdown` plus
 * `variables = [{token, label, required, source}]`, with `governing_law`,
 * `jurisdiction` and `approved_by_legal_at` beside it. So this screen reads
 * `contract_templates` — there is no separate "letter templates" table, and
 * `notification_templates` (migration 027) is a different thing entirely: it
 * belongs to /admin/comms/templates.
 *
 * WHY IT IS READ-ONLY TONIGHT. Migration 026 does grant
 * `INSERT, UPDATE ON public.contract_templates` to `authenticated` behind
 * `contract_templates__admin__all`, so the grant is not the blocker. The blocker
 * is what a template IS: a legal instrument whose `body_markdown` is rendered
 * into a signed PDF, under Indian-law clause text, with a `variables` contract
 * the renderer enforces token by token, a `version` that
 * `documents.generated_from_template_id` pins, and an `approved_by_legal_at`
 * stamp. Authoring that in a browser textarea — with no clause library screen, no
 * publish/version ceremony and no legal-approval step — is how an unreviewed
 * contract reaches an employee. The register therefore SHOWS everything the
 * renderer will use, including the exact body and the token contract, and says
 * plainly where authoring happens.
 *
 * @route /admin/documents/templates
 */
import { useMemo, useState } from "react";
import { FileType2, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { dash, formatNumber } from "@/lib/format";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { SelectField, TextField } from "../components/Field";
import { useContractTemplateCount, useContractTemplates } from "../hooks/useDocumentsAdmin";
import {
  contractKindValues,
  templateVariablesOf,
  templateVariablesUnreadable,
  type ContractKind,
  type ContractTemplate,
  type TemplateFilters,
} from "../api/documents.api";
import { CONTRACT_KIND_LABELS } from "../documents/labels";

const PUBLISH_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  published: { label: t("admin.docs.tpl.state.published"), tone: "success" },
  draft: { label: t("admin.docs.tpl.state.draft"), tone: "warn" },
  inactive: { label: t("admin.docs.tpl.state.inactive"), tone: "neutral" },
};

function publishState(row: ContractTemplate): string {
  if (!row.is_active) return "inactive";
  return row.is_published ? "published" : "draft";
}

export default function DocumentTemplatesPage() {
  const [kind, setKind] = useState<ContractKind | "">("");
  const [nameLike, setNameLike] = useState("");
  const [publishedOnly, setPublishedOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [open, setOpen] = useState<ContractTemplate | null>(null);

  const filters = useMemo<TemplateFilters>(
    () => ({
      ...(kind !== "" ? { kinds: [kind] } : {}),
      ...(nameLike.trim() !== "" ? { nameLike: nameLike.trim() } : {}),
      ...(publishedOnly ? { publishedOnly: true } : {}),
      ...(includeInactive ? { includeInactive: true } : {}),
    }),
    [kind, nameLike, publishedOnly, includeInactive],
  );

  const templates = useContractTemplates(filters);
  const total = useContractTemplateCount(filters);
  const rows = templates.data ?? [];

  const openVariables = useMemo(
    () => (open === null ? [] : templateVariablesOf(open.variables)),
    [open],
  );

  const columns: DataGridColumn<ContractTemplate>[] = [
    {
      key: "name",
      header: t("admin.docs.tpl.col.template"),
      width: "18rem",
      sortable: true,
      sortValue: (row) => row.name,
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.name}</span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "contract_kind",
      header: t("admin.docs.tpl.col.kind"),
      width: "13rem",
      sortable: true,
      sortValue: (row) => CONTRACT_KIND_LABELS[row.contract_kind],
      render: (row) => CONTRACT_KIND_LABELS[row.contract_kind],
    },
    {
      key: "version",
      header: t("admin.docs.tpl.col.version"),
      width: "7rem",
      align: "right",
      sortable: true,
      sortValue: (row) => row.version,
      render: (row) => <span className="num">{formatNumber(row.version)}</span>,
    },
    {
      key: "is_published",
      header: t("admin.docs.tpl.col.state"),
      width: "9rem",
      render: (row) => <StatusChip status={publishState(row)} map={PUBLISH_CHIP} />,
    },
    {
      key: "variables",
      header: t("admin.docs.tpl.col.tokens"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) =>
        templateVariablesUnreadable(row.variables) ? (
          <span className="text-xs font-medium text-destructive">
            {t("admin.docs.tpl.tokensUnreadable")}
          </span>
        ) : (
          <span className="num">{formatNumber(templateVariablesOf(row.variables).length)}</span>
        ),
    },
    {
      key: "requires_witness",
      header: t("admin.docs.tpl.col.witness"),
      width: "8rem",
      hideBelow: "lg",
      render: (row) => (row.requires_witness ? t("admin.master.yes") : t("admin.master.no")),
    },
    {
      key: "jurisdiction",
      header: t("admin.docs.tpl.col.jurisdiction"),
      hideBelow: "lg",
      render: (row) => row.jurisdiction,
    },
    {
      key: "approved_by_legal_at",
      header: t("admin.docs.tpl.col.legal"),
      width: "12rem",
      align: "right",
      hideBelow: "md",
      render: (row) =>
        row.approved_by_legal_at === null ? (
          <span className="text-xs font-medium text-warning">
            {t("admin.docs.tpl.notApproved")}
          </span>
        ) : (
          <span className="num">{fmtDateTime(row.approved_by_legal_at)}</span>
        ),
    },
  ];

  const hasAnyFilter =
    kind !== "" || nameLike.trim() !== "" || publishedOnly || includeInactive;

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScrollText}
        title={t("admin.docs.tpl.title")}
        subtitle={
          total.isSuccess
            ? t("admin.docs.tpl.subtitle", { n: formatNumber(total.data) })
            : t("admin.docs.tpl.subtitlePlain")
        }
      />

      <div className="mt-4">
        <Notice tone="note">{t("admin.docs.tpl.readOnly")}</Notice>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t("admin.docs.tpl.filter.name")}
          value={nameLike}
          onChange={setNameLike}
          placeholder={t("admin.docs.tpl.filter.namePlaceholder")}
        />
        <SelectField
          label={t("admin.docs.tpl.filter.kind")}
          value={kind}
          placeholder={t("admin.docs.tpl.filter.anyKind")}
          options={contractKindValues.map((value) => ({
            value,
            label: CONTRACT_KIND_LABELS[value],
          }))}
          onChange={(v) => setKind(v as ContractKind | "")}
        />
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <Button
            type="button"
            variant={publishedOnly ? "default" : "outline"}
            onClick={() => setPublishedOnly((v) => !v)}
            aria-pressed={publishedOnly}
          >
            {t("admin.docs.tpl.filter.publishedOnly")}
          </Button>
          <Button
            type="button"
            variant={includeInactive ? "default" : "outline"}
            onClick={() => setIncludeInactive((v) => !v)}
            aria-pressed={includeInactive}
          >
            {t("admin.master.filter.includeInactive")}
          </Button>
          {hasAnyFilter ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setKind("");
                setNameLike("");
                setPublishedOnly(false);
                setIncludeInactive(false);
              }}
            >
              {t("admin.docs.exp.filter.clear")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <StateBoundary
          loading={templates.isPending}
          error={templates.error}
          onRetry={() => void templates.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error}
          partialLabel={t("admin.docs.tpl.partial")}
          empty={
            <EmptyState
              icon={FileType2}
              title={
                hasAnyFilter
                  ? t("admin.docs.tpl.empty.filtered.title")
                  : t("admin.docs.tpl.empty.title")
              }
              hint={
                hasAnyFilter
                  ? t("admin.docs.tpl.empty.filtered.hint")
                  : t("admin.docs.tpl.empty.hint")
              }
            />
          }
        >
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            onRowClick={(row) => setOpen(row)}
          />
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.docs.tpl.footnote")}</Notice>
      </div>

      <Sheet
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
          <SheetHeader className="border-b p-5 text-left sm:p-6">
            <SheetTitle className="font-display">{open?.name ?? ""}</SheetTitle>
            <SheetDescription>
              {open === null
                ? ""
                : t("admin.docs.tpl.drawer.subtitle", {
                    kind: CONTRACT_KIND_LABELS[open.contract_kind],
                    version: formatNumber(open.version),
                  })}
            </SheetDescription>
          </SheetHeader>

          {open !== null ? (
            <div className="space-y-5 p-5 sm:p-6">
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.docs.tpl.drawer.law")}
                  </dt>
                  <dd className="text-sm">{open.governing_law}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.docs.tpl.drawer.jurisdiction")}
                  </dt>
                  <dd className="text-sm">{open.jurisdiction}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.docs.tpl.drawer.published")}
                  </dt>
                  <dd className="num text-sm">
                    {open.published_at === null
                      ? t("admin.docs.tpl.state.draft")
                      : fmtDateTime(open.published_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.docs.tpl.drawer.legal")}
                  </dt>
                  <dd className="num text-sm">
                    {open.approved_by_legal_at === null
                      ? t("admin.docs.tpl.notApproved")
                      : fmtDateTime(open.approved_by_legal_at)}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">
                    {t("admin.docs.tpl.drawer.description")}
                  </dt>
                  <dd className="text-sm">{dash(open.description)}</dd>
                </div>
              </dl>

              <section>
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("admin.docs.tpl.drawer.tokens")}
                </h3>
                {templateVariablesUnreadable(open.variables) ? (
                  <div className="mt-2">
                    <Notice tone="error">{t("admin.docs.tpl.drawer.tokensBroken")}</Notice>
                  </div>
                ) : openVariables.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("admin.docs.tpl.drawer.noTokens")}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {openVariables.map((variable) => (
                      <li key={variable.token} className="rounded-md border px-3 py-2 text-sm">
                        <span className="num font-medium">{`{{${variable.token}}}`}</span>
                        <span className="ml-2">{dash(variable.label ?? null)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {(variable.source ?? "") === ""
                            ? t("admin.docs.tpl.drawer.typed")
                            : t("admin.docs.tpl.drawer.sourced", { source: variable.source ?? "" })}
                          {variable.required === false
                            ? ` · ${t("admin.docs.tpl.drawer.optional")}`
                            : ` · ${t("admin.docs.tpl.drawer.required")}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("admin.docs.tpl.drawer.body")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("admin.docs.tpl.drawer.bodyHint")}
                </p>
                <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                  {open.body_markdown}
                </pre>
              </section>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
