/**
 * §14 · /admin/comms/policies — Policy Publication. Publish a policy version and
 * require acknowledgement.
 *
 * RECON RESULT, and the reason this screen is shaped the way it is: THERE IS NO
 * `policies` TABLE. Nothing in the 59 migrations creates one. A policy in this
 * system is a row in `public.documents` with
 *
 *     subject_kind = 'policy'                        (ck_documents__subject_kind)
 *     requires_acknowledgement = true                (+ acknowledgement_due_on)
 *     document_type_id → a type whose own `requires_acknowledgement` is set
 *
 * and "publishing a version" is `documents.current_version` plus a row in
 * `document_versions`. Circulating it is `communication-send` in `mode:"policy"`,
 * which REQUIRES a `document_id`, mints the single-use ack token into
 * `secure.communication_recipient_tokens`, and links each recipient to its
 * `document_acknowledgements` row.
 *
 * So this screen is the REGISTER plus the map of the path, and it does not
 * pretend to be an uploader:
 *
 *  1. The rulebook — `document_types` where `requires_acknowledgement`. LIVE:
 *     POLICY ("Company Policy") and SOP ("Standard Operating Procedure"), both
 *     with a 7-day acknowledgement deadline, neither requiring e-sign. Real rows,
 *     read live.
 *  2. The register — `documents`, filtered, with a server count. LIVE: ZERO
 *     rows. No policy PDF has been uploaded to this project, which is why
 *     /admin/comms/acknowledgements is also empty. The empty state says exactly
 *     that.
 *  3. What is missing, named: file upload writes to a private Storage bucket and
 *     is minted by the document surface, not by this console; there is no
 *     `documents` INSERT here because inventing one would put a metadata row in
 *     front of a file that does not exist.
 *
 * @route /admin/comms/policies
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileCheck2, FileUp, ScrollText, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { PublishPolicySheet } from "../components/PublishPolicySheet";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { SelectField, TextField } from "../components/Field";
import {
  useAckDocumentTypes,
  usePolicyDocumentCount,
  useActiveEmployeeCount,
  usePolicyAckStatus,
  usePolicyDocuments,
} from "../hooks/useCommsAdmin";
import type {
  AckDocumentType,
  PolicyAckStatus,
  PolicyDocument,
  PolicyFilters,
} from "../api/comms.api";

/** `ck_documents__subject_kind` — the kinds a policy register cares about. */
const SUBJECT_KINDS: readonly { value: string; label: string }[] = [
  { value: "policy", label: t("admin.comms.pol.kind.policy") },
  { value: "company", label: t("admin.comms.pol.kind.company") },
  { value: "event", label: t("admin.comms.pol.kind.event") },
];

/**
 * `public.document_status` in full (migration 003) — all seven values. A policy
 * register that left `superseded` unmapped would render the one status an auditor
 * most needs to see as an untranslated grey chip.
 */
const DOC_STATUS_MAP = {
  draft: { label: t("admin.comms.pol.status.draft"), tone: "neutral" as const },
  pending_review: { label: t("admin.comms.pol.status.pendingReview"), tone: "warn" as const },
  approved: { label: t("admin.comms.pol.status.approved"), tone: "success" as const },
  rejected: { label: t("admin.comms.pol.status.rejected"), tone: "danger" as const },
  expired: { label: t("admin.comms.pol.status.expired"), tone: "danger" as const },
  superseded: { label: t("admin.comms.pol.status.superseded"), tone: "neutral" as const },
  archived: { label: t("admin.comms.pol.status.archived"), tone: "neutral" as const },
};

export default function PolicyPublicationPage() {
  const [publishing, setPublishing] = useState(false);
  /*
    The document whose audience is being chosen, or null when publishing a new
    one. One sheet serves both because the second half of publishing — audience,
    deadline, signature — is identical either way.
  */
  const [circulating, setCirculating] = useState<PolicyDocument | null>(null);
  const [subjectKind, setSubjectKind] = useState("policy");
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [ackRequiredOnly, setAckRequiredOnly] = useState(false);
  const [search, setSearch] = useState("");

  const types = useAckDocumentTypes();
  const typeRows = useMemo(() => types.data ?? [], [types.data]);

  const filters = useMemo<PolicyFilters>(
    () => ({
      ...(subjectKind !== "" ? { subjectKind } : {}),
      ...(documentTypeId !== "" ? { documentTypeId } : {}),
      ...(ackRequiredOnly ? { ackRequiredOnly: true } : {}),
      ...(search.trim() !== "" ? { titleLike: search.trim() } : {}),
    }),
    [subjectKind, documentTypeId, ackRequiredOnly, search],
  );

  const list = usePolicyDocuments(filters);
  const total = usePolicyDocumentCount(filters);
  const rows = useMemo(() => list.data ?? [], [list.data]);

  // Server counts, independent of whatever the register is filtered to.
  const policyCount = usePolicyDocumentCount({ subjectKind: "policy" });
  const ackCount = usePolicyDocumentCount({ ackRequiredOnly: true });

  /*
    Circulation state per document, from the view that already counts it. One map
    rather than a lookup per row, so a register of 200 policies does not do 200
    linear scans while rendering.
  */
  const ackStatus = usePolicyAckStatus();
  /* The denominator: how many people COULD hold this, not how many do. */
  const headcount = useActiveEmployeeCount();
  const ackByDocument = useMemo(() => {
    const map = new Map<string, PolicyAckStatus>();
    for (const row of ackStatus.data ?? []) map.set(row.document_id, row);
    return map;
  }, [ackStatus.data]);

  const typeNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of typeRows) map.set(row.id, row.name);
    return map;
  }, [typeRows]);

  const anyFilter =
    subjectKind !== "policy" || documentTypeId !== "" || ackRequiredOnly || search.trim() !== "";
  const clearAll = () => {
    setSubjectKind("policy");
    setDocumentTypeId("");
    setAckRequiredOnly(false);
    setSearch("");
  };

  const typeColumns: DataGridColumn<AckDocumentType>[] = [
    {
      key: "name",
      header: t("admin.comms.pol.col.type"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
        </span>
      ),
    },
    {
      key: "category",
      header: t("admin.comms.pol.col.category"),
      width: "10rem",
      render: (row) => <span className="text-sm">{dash(row.category)}</span>,
    },
    {
      key: "acknowledgement_deadline_days",
      header: t("admin.comms.pol.col.deadline"),
      align: "right",
      width: "12rem",
      render: (row) => (
        <span className="num text-sm">
          {row.acknowledgement_deadline_days === null
            ? dash(null)
            : t("admin.comms.pol.days", {
                n: formatNumber(row.acknowledgement_deadline_days),
              })}
        </span>
      ),
    },
    {
      key: "flags",
      header: t("admin.comms.pol.col.flags"),
      width: "14rem",
      render: (row) => (
        <span className="flex flex-wrap gap-1">
          <Badge variant="warning">{t("admin.comms.pol.needsAck")}</Badge>
          {row.requires_esign ? (
            <Badge variant="info">{t("admin.comms.pol.needsEsign")}</Badge>
          ) : null}
          {row.is_active ? null : (
            <Badge variant="neutral">{t("admin.comms.pol.inactive")}</Badge>
          )}
        </span>
      ),
    },
  ];

  const columns: DataGridColumn<PolicyDocument>[] = [
    {
      key: "title",
      header: t("admin.comms.pol.col.document"),
      render: (row) => (
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium">{row.title}</span>
          <span className="text-xs text-muted-foreground">
            {dash(typeNames.get(row.document_type_id) ?? null)}
          </span>
        </span>
      ),
    },
    {
      key: "current_version",
      header: t("admin.comms.pol.col.version"),
      align: "right",
      width: "7rem",
      render: (row) => <span className="num">{formatNumber(row.current_version)}</span>,
    },
    {
      key: "status",
      header: t("admin.comms.pol.col.status"),
      width: "11rem",
      render: (row) => <StatusChip status={row.status} map={DOC_STATUS_MAP} />,
    },
    {
      key: "requires_acknowledgement",
      header: t("admin.comms.pol.col.ack"),
      width: "15rem",
      /*
        WAS A BADGE READING "Acknowledgement" AND A DATE, AND MEANT NOTHING.

        Asked, correctly: "who is acknowledge circulate here?? i did not get
        meaning of acknowledge here". The badge was `requires_acknowledgement` —
        a schema flag saying this document is the KIND that needs acknowledging —
        next to `acknowledgement_due_on`. Both true, neither an answer to the
        question anybody has in front of a policy register, which is: has this
        gone out, and how many people have signed it?

        `v_policy_acknowledgement_status` has counted exactly that since 037 and
        no screen read it. Three states now, and they are distinguishable at a
        glance because they are the three decisions HR makes here.
      */
      render: (row) => {
        const status = ackByDocument.get(row.id);
        const assigned = status?.assigned ?? 0;

        if (assigned === 0) {
          return (
            <span className="flex flex-col leading-tight">
              <Badge variant="neutral">{t("admin.comms.pol.notCirculated")}</Badge>
              <span className="mt-1 text-xs text-muted-foreground">
                {t("admin.comms.pol.notCirculatedHint")}
              </span>
            </span>
          );
        }

        const done = status?.acknowledged ?? 0;
        const overdue = status?.overdue ?? 0;
        /*
          THE LINE THAT ANSWERS "why can the employee only see one".

          Two of the three policies here were assigned by the demo seed to every
          employee who existed AT THE TIME IT RAN — fifteen of them. The venue has
          grown to ninety-odd since, and everybody who joined after has never been
          given those documents. "6 of 15 signed" was true and read as circulated.
          Saying how many people are NOT holding it is the fact that makes the
          Circulate again button obviously the next thing to press.
        */
        const total = headcount.data ?? null;
        const missing = total !== null && total > assigned ? total - assigned : 0;
        return (
          <span className="flex flex-col leading-tight">
            <Badge variant={done >= assigned ? "success" : "warning"}>
              {t("admin.comms.pol.ackProgress", {
                done: formatNumber(done),
                total: formatNumber(assigned),
              })}
            </Badge>
            <span className="mt-1 text-xs text-muted-foreground">
              {overdue > 0
                ? t("admin.comms.pol.ackOverdue", { n: formatNumber(overdue) })
                : status?.earliest_open_due_on != null
                  ? t("admin.comms.pol.ackDue", {
                      date: fmtCivilDate(status.earliest_open_due_on),
                    })
                  : t("admin.comms.pol.ackAllDone")}
            </span>
            {missing > 0 ? (
              <span className="mt-0.5 text-xs text-warning">
                {t("admin.comms.pol.ackMissing", { n: formatNumber(missing) })}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "issue_date",
      header: t("admin.comms.pol.col.issued"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => <span className="text-xs">{fmtCivilDate(row.issue_date)}</span>,
    },
    {
      key: "uploaded_at",
      header: t("admin.comms.pol.col.uploadedAt"),
      width: "12rem",
      hideBelow: "lg",
      render: (row) => <span className="text-xs">{fmtDateTime(row.uploaded_at)}</span>,
    },
    {
      key: "open",
      header: t("admin.comms.pol.col.open"),
      width: "8rem",
      /*
        Asked for: "add a button to see pdf that is circulated". HR is about to
        send a document to ninety people and could not look at it first — the
        register listed a title and a size and nothing openable.

        `DocumentOpenButtons` already does this everywhere else: it calls the
        `document-access` edge function, which logs the access BEFORE the URL
        exists and hands back a signed link that expires. Download is off here
        because the question on this screen is "is this the right file", not
        "keep a copy".
      */
      render: (row) => (
        <DocumentOpenButtons
          documentId={row.id}
          title={row.title}
          variant="text"
          allowDownload={false}
        />
      ),
    },
    {
      key: "circulate",
      header: t("admin.comms.pol.col.circulate"),
      width: "9rem",
      /*
        On every policy row, not only unassigned ones. Re-circulating is how a
        joiner gets a policy everybody else already has, and `publish_policy`
        skips anybody who already holds an assignment — so the repeat is safe and
        is the normal way to use it.
      */
      render: (row) => {
        const sent = (ackByDocument.get(row.id)?.assigned ?? 0) > 0;
        return (
          <Button size="sm" variant="outline" onClick={() => setCirculating(row)}>
            <Send className="mr-1.5 size-3.5" aria-hidden />
            {sent ? t("admin.comms.pol.circ.again") : t("admin.comms.pol.circ.cta")}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScrollText}
        title={t("admin.comms.pol.title")}
        subtitle={
          total.isSuccess
            ? t("admin.comms.pol.subtitle", { n: formatNumber(total.data) })
            : t("admin.comms.pol.subtitlePlain")
        }
        actions={
          <Button onClick={() => setPublishing(true)}>
            <FileUp className="mr-2 size-4" aria-hidden />
            {t("admin.comms.pol.pub.cta")}
          </Button>
        }
      />

      <PublishPolicySheet open={publishing} onOpenChange={setPublishing} types={typeRows} />

      <PublishPolicySheet
        open={circulating !== null}
        onOpenChange={(next) => {
          if (!next) setCirculating(null);
        }}
        types={typeRows}
        existing={circulating}
      />

      <div className="mb-6">
        <Notice tone="info">{t("admin.comms.pol.whereNotice")}</Notice>
      </div>

      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label={t("admin.comms.pol.kpi.policies")}
          value={policyCount.isSuccess ? formatNumber(policyCount.data) : dash(null)}
          hint={t("admin.comms.pol.kpi.policiesHint")}
        />
        <KpiTile
          label={t("admin.comms.pol.kpi.ackRequired")}
          value={ackCount.isSuccess ? formatNumber(ackCount.data) : dash(null)}
          hint={t("admin.comms.pol.kpi.ackRequiredHint")}
        />
        <KpiTile
          label={t("admin.comms.pol.kpi.types")}
          value={types.isSuccess ? formatNumber(typeRows.length) : dash(null)}
          hint={t("admin.comms.pol.kpi.typesHint")}
        />
      </section>

      <section className="mb-8">
        <div className="mb-3">
          <h2 className="font-display text-lg font-semibold">{t("admin.comms.pol.rulebook")}</h2>
          <p className="text-sm text-muted-foreground">{t("admin.comms.pol.rulebookHint")}</p>
        </div>
        <StateBoundary
          loading={types.isPending}
          error={types.error}
          onRetry={() => void types.refetch()}
          isEmpty={typeRows.length === 0}
          empty={
            <EmptyState
              icon={FileCheck2}
              title={t("admin.comms.pol.empty.types.title")}
              hint={t("admin.comms.pol.empty.types.hint")}
            />
          }
          skeletonRows={2}
        >
          <DataGrid
            columns={typeColumns}
            rows={typeRows}
            rowKey={(row) => row.id}
            pageSize={10}
          />
        </StateBoundary>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="font-display text-lg font-semibold">{t("admin.comms.pol.register")}</h2>
          <p className="text-sm text-muted-foreground">{t("admin.comms.pol.registerHint")}</p>
        </div>

        <div className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField
            label={t("admin.comms.pol.filter.kind")}
            value={subjectKind}
            placeholder={t("admin.comms.pol.filter.anyKind")}
            options={SUBJECT_KINDS}
            onChange={setSubjectKind}
            hint={t("admin.comms.pol.filter.kindHint")}
          />
          <SelectField
            label={t("admin.comms.pol.filter.type")}
            value={documentTypeId}
            placeholder={t("admin.comms.pol.filter.anyType")}
            options={typeRows.map((row) => ({ value: row.id, label: row.name }))}
            onChange={setDocumentTypeId}
          />
          <TextField
            label={t("admin.comms.pol.filter.search")}
            value={search}
            onChange={setSearch}
            placeholder={t("admin.comms.pol.filter.searchPlaceholder")}
          />
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant={ackRequiredOnly ? "default" : "outline"}
              aria-pressed={ackRequiredOnly}
              onClick={() => setAckRequiredOnly((v) => !v)}
            >
              {t("admin.comms.pol.filter.ackOnly")}
            </Button>
            {anyFilter ? (
              <Button type="button" variant="ghost" onClick={clearAll}>
                {t("admin.comms.pol.filter.clear")}
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground lg:col-span-4 lg:text-right">
            {total.isSuccess
              ? t("admin.comms.pol.matching", { n: formatNumber(total.data) })
              : t("admin.comms.pol.matchingUnknown")}
          </p>
        </div>

        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={rows.length === 0}
          partialError={total.error ?? types.error}
          partialLabel={t("admin.comms.pol.partial.types")}
          empty={
            <EmptyState
              icon={ScrollText}
              title={t("admin.comms.pol.empty.docs.title")}
              hint={
                anyFilter
                  ? t("admin.comms.pol.empty.docs.filteredHint")
                  : t("admin.comms.pol.empty.docs.hint")
              }
              action={
                anyFilter ? (
                  <Button variant="outline" onClick={clearAll}>
                    {t("admin.comms.pol.filter.clear")}
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <Link to="/admin/comms/acknowledgements">
                      {t("admin.comms.pol.empty.docs.action")}
                    </Link>
                  </Button>
                )
              }
            />
          }
          skeletonRows={4}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
        </StateBoundary>
      </section>

      <section className="mt-8 rounded-lg border bg-card p-4">
        <h2 className="font-display text-lg font-semibold">{t("admin.comms.pol.path")}</h2>
        <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>1. {t("admin.comms.pol.path.step1")}</li>
          <li>2. {t("admin.comms.pol.path.step2")}</li>
          <li>3. {t("admin.comms.pol.path.step3")}</li>
          <li>4. {t("admin.comms.pol.path.step4")}</li>
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/comms/broadcasts">{t("admin.comms.pol.link.broadcasts")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/comms/acknowledgements">{t("admin.comms.pol.link.acks")}</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/comms/announcements">{t("admin.comms.pol.link.announcements")}</Link>
          </Button>
        </div>
        <div className="mt-4">
          <Notice tone="warning">{t("admin.comms.pol.gapNotice")}</Notice>
        </div>
      </section>

      <p className="mt-4 text-xs text-muted-foreground">{t("admin.comms.pol.footnote")}</p>
    </div>
  );
}
