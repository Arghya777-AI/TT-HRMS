/**
 * /admin/org/entities — the employing legal entity (spec-admin §4, tier A/S).
 *
 * Admins read; only a super admin writes, because these fields print on
 * payslips, Form 16 and every statutory return. The client gate is UX: the RLS
 * policy on `companies` is the boundary, and a refusal comes back as a plain
 * sentence rather than a 42501.
 *
 * No create and no retire: the entity is seeded by the database (single-tenant,
 * DR-54), so a console that offered "Add entity" would be offering something
 * the product does not support.
  *
 * @route /admin/org/entities
 */
import { useState } from "react";
import { Building2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { SENSITIVE_REASON_LENGTH } from "@/shared/api/query";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Company } from "../api/org.api";
import { useCompanies, useCompanySave } from "../hooks/useMasters";
import { MasterBanner } from "../components/MasterScreen";
import { MasterFormSheet } from "../components/MasterFormSheet";
import { useMasterForm, type MasterFormBuild } from "../masters/useMasterForm";
import { nameField, descriptionField } from "../masters/common";
import type { FieldGroup } from "../masters/fields";

const ENTITY_TYPES = [
  { value: "LLP", label: "LLP" },
  { value: "PRIVATE_LIMITED", label: "Private Limited" },
  { value: "PARTNERSHIP", label: "Partnership" },
  { value: "PROPRIETORSHIP", label: "Proprietorship" },
] as const;

const groups: FieldGroup[] = [
  {
    title: t("admin.org.entity.group.registration"),
    fields: [
      {
        name: "legal_name",
        label: t("admin.org.entity.field.legalName"),
        kind: "text",
        help: t("admin.org.entity.help.legalName"),
        required: true,
        maxLength: 200,
        wide: true,
      },
      {
        name: "trade_name",
        label: t("admin.org.entity.field.tradeName"),
        kind: "text",
        help: t("admin.org.entity.help.tradeName"),
        required: true,
        maxLength: 200,
      },
      nameField,
      {
        name: "entity_type",
        label: t("admin.org.entity.field.entityType"),
        kind: "select",
        help: t("admin.org.entity.help.entityType"),
        options: ENTITY_TYPES,
      },
      {
        name: "registration_number",
        label: t("admin.org.entity.field.registration"),
        kind: "text",
        help: t("admin.org.entity.help.registration"),
        maxLength: 40,
      },
      {
        name: "incorporation_date",
        label: t("admin.org.entity.field.incorporation"),
        kind: "date",
        help: t("admin.org.entity.help.incorporation"),
      },
      descriptionField,
    ],
  },
  {
    title: t("admin.org.entity.group.statutory"),
    fields: [
      {
        name: "pan",
        label: t("admin.org.entity.field.pan"),
        kind: "code",
        help: t("admin.org.entity.help.pan"),
        maxLength: 10,
        pattern: { re: /^[A-Z]{5}[0-9]{4}[A-Z]$/, messageKey: "admin.master.err.pattern.pan" },
      },
      {
        name: "tan",
        label: t("admin.org.entity.field.tan"),
        kind: "code",
        help: t("admin.org.entity.help.tan"),
        maxLength: 10,
        pattern: { re: /^[A-Z]{4}[0-9]{5}[A-Z]$/, messageKey: "admin.master.err.pattern.tan" },
      },
      {
        name: "gstin",
        label: t("admin.org.entity.field.gstin"),
        kind: "code",
        help: t("admin.org.entity.help.gstin"),
        maxLength: 15,
        pattern: {
          re: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/,
          messageKey: "admin.master.err.pattern.gstin",
        },
      },
      {
        name: "pf_establishment_code",
        label: t("admin.org.entity.field.pf"),
        kind: "text",
        help: t("admin.org.entity.help.pf"),
        maxLength: 40,
      },
      {
        name: "esi_establishment_code",
        label: t("admin.org.entity.field.esi"),
        kind: "text",
        help: t("admin.org.entity.help.esi"),
        maxLength: 40,
      },
      {
        name: "lwf_registration",
        label: t("admin.org.entity.field.lwf"),
        kind: "text",
        help: t("admin.org.entity.help.lwf"),
        maxLength: 40,
      },
      {
        name: "shops_establishment_reg",
        label: t("admin.org.entity.field.shops"),
        kind: "text",
        help: t("admin.org.entity.help.shops"),
        maxLength: 40,
      },
    ],
  },
];

export default function EntitiesPage() {
  const { can, employee } = useAuth();
  const mayEdit = can("admin.super");
  const companies = useCompanies();
  const save = useCompanySave();
  const form = useMasterForm<Company>(groups);
  const [pending, setPending] = useState<MasterFormBuild | null>(null);

  const columns: DataGridColumn<Company>[] = [
    {
      key: "legal_name",
      header: t("admin.org.entity.col.legalName"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{row.legal_name}</span>
          <span className="num text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "trade_name",
      header: t("admin.org.entity.col.brand"),
      render: (row) => dash(row.trade_name),
    },
    {
      key: "entity_type",
      header: t("admin.org.entity.col.type"),
      width: "7rem",
      hideBelow: "md",
      render: (row) =>
        ENTITY_TYPES.find((type) => type.value === row.entity_type)?.label ??
        dash(row.entity_type),
    },
    {
      key: "registration_number",
      header: t("admin.org.entity.col.registration"),
      hideBelow: "md",
      render: (row) => <span className="num">{dash(row.registration_number)}</span>,
    },
    {
      key: "pan",
      header: t("admin.org.entity.col.pan"),
      hideBelow: "lg",
      render: (row) => <span className="num">{dash(row.pan)}</span>,
    },
    {
      key: "gstin",
      header: t("admin.org.entity.col.gstin"),
      hideBelow: "lg",
      render: (row) => <span className="num">{dash(row.gstin)}</span>,
    },
    {
      key: "incorporation_date",
      header: t("admin.org.entity.col.incorporated"),
      width: "10rem",
      hideBelow: "lg",
      render: (row) => fmtCivilDate(row.incorporation_date),
    },
    {
      key: "actions",
      header: t("admin.master.col.actions"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => form.openEdit(row)}>
            {mayEdit ? t("admin.master.action.edit") : t("admin.master.action.view")}
          </Button>
        </span>
      ),
    },
  ];

  function submit(): void {
    if (!mayEdit) return;
    const built = form.build();
    if (built === null) return;
    setPending(built);
  }

  async function commit(reason: string): Promise<void> {
    if (pending === null || form.editing === null) return;
    try {
      await save.saveAsync({ id: form.editing.id, values: pending.payload }, reason);
      toast.success(t("admin.master.toast.saved", { name: form.editing.legal_name }));
      setPending(null);
      form.close();
    } catch {
      /* the sentence is on save.userMessage, inside the dialog */
    }
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Building2}
        title={t("admin.org.entity.title")}
        subtitle={t("admin.org.entity.subtitle")}
      />

      {mayEdit ? null : <MasterBanner>{t("admin.org.entity.readOnly")}</MasterBanner>}

      <StateBoundary
        loading={companies.isLoading}
        error={companies.error ?? undefined}
        onRetry={() => void companies.refetch()}
        isEmpty={companies.isSuccess && (companies.data ?? []).length === 0}
        empty={
          <EmptyState
            icon={Building2}
            title={t("admin.org.entity.empty.title")}
            hint={t("admin.org.entity.empty.hint")}
          />
        }
        skeletonRows={2}
      >
        <DataGrid
          columns={columns}
          rows={companies.data ?? []}
          rowKey={(row) => row.id}
          pageSize={10}
          onRowClick={(row) => form.openEdit(row)}
        />
      </StateBoundary>

      <MasterFormSheet
        open={form.open}
        mode="edit"
        entityLabel={t("admin.org.entity.entity")}
        rowName={form.editing?.legal_name ?? null}
        groups={groups}
        values={form.values}
        errors={form.errors}
        pending={save.isPending}
        serverMessage={save.userMessage}
        formError={form.formError}
        readOnly={!mayEdit}
        readOnlyNote={t("admin.org.entity.readOnly")}
        onChange={form.change}
        onSubmit={submit}
        onClose={form.close}
      />

      {pending !== null ? (
        <ReasonDialog
          open
          title={t("admin.master.saveReason.editTitle", {
            name: form.editing?.legal_name ?? pending.name,
          })}
          description={
            pending.changes.length === 0
              ? t("admin.org.entity.reasonPrompt")
              : t("admin.master.changes.list", { changes: pending.changes.join("; ") })
          }
          actorName={employee?.displayName ?? null}
          minLength={SENSITIVE_REASON_LENGTH}
          confirmLabel={t("admin.master.saveReason.confirm")}
          pending={save.isPending}
          errorMessage={save.userMessage}
          onConfirm={(reason) => void commit(reason)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
