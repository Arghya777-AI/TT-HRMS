/**
 * E-09 · /me/documents — what HR has given you, what you sent them, and what
 * you have already agreed to.
 *
 * Three tabs, one read: `useMyDocuments()` returns every document on the
 * caller's record and the tabs are two filters over that array, so "Issued to
 * me" and "My uploads" can never disagree about a row's status or date. Tab 3
 * reads the acknowledgement ledger, which is the only place a signature date
 * lives.
 *
 * Titles are `documents.title`, never the filename, and there is no "Type"
 * column carrying a file extension (DR-55). Attribution is a person's role in
 * words, never `HR-HR001` (DR-23/53). `expiry_date IS NULL` renders "No expiry"
 * (DR-19).
 *
 * Opening a file is deliberately NOT wired: the signed URL must be minted by the
 * `document-access` edge function, which writes `document_access_log` first, and
 * that function is not deployed. A disabled action that says why is honest; a
 * browser-minted URL that bypasses the access log is not.
 *
 * @route /me/documents
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText, Inbox, PenLine, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { useProfileId } from "@/shared/api/employee-scope";
import {
  filerOf,
  partitionMyDocuments,
  type DocumentAck,
  type DocumentRow,
} from "../api/docs.api";
import { useMyDocuments, useMySignedDocuments } from "../hooks/useDocs";

const DOC_STATUS_MAP: Record<string, StatusChipEntry> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_review: { label: "With HR", tone: "warn" },
  approved: { label: "Accepted", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "danger" },
  superseded: { label: "Replaced", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

const ACK_STATUS_MAP: Record<string, StatusChipEntry> = {
  acknowledged: { label: "Acknowledged", tone: "success" },
  waived: { label: "Waived by HR", tone: "neutral" },
  assigned: { label: "Not acknowledged", tone: "warn" },
  opened: { label: "Started reading", tone: "warn" },
  overdue: { label: "Overdue", tone: "danger" },
};

type TabKey = "issued" | "uploads" | "signed";
const TAB_KEYS: readonly TabKey[] = ["issued", "uploads", "signed"];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

function categoryLabel(row: DocumentRow): string {
  return dash(row.document_types?.name ?? null);
}

function validTo(row: DocumentRow): string {
  return row.expiry_date === null ? t("docs.validTo.none") : fmtCivilDate(row.expiry_date);
}

/** A disabled, explained action beats a link that cannot log the access. */
function ViewAction() {
  return (
    <Button variant="outline" size="sm" disabled title={t("docs.view.unavailable")}>
      {t("docs.action.view")}
    </Button>
  );
}

export default function MyDocumentsPage() {
  const profileId = useProfileId();
  const docs = useMyDocuments();
  const signed = useMySignedDocuments();
  const [params, setParams] = useSearchParams();

  const tab: TabKey = isTabKey(params.get("tab")) ? (params.get("tab") as TabKey) : "issued";

  const { issued, uploads } = useMemo(
    () => partitionMyDocuments(docs.data ?? [], profileId),
    [docs.data, profileId],
  );

  function selectTab(next: string) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  }

  const filerLabel = (row: DocumentRow): string => {
    switch (filerOf(row, profileId)) {
      case "system":
        return t("docs.by.system");
      case "you":
        return t("docs.by.you");
      default:
        return t("docs.by.hr");
    }
  };

  const issuedColumns: DataGridColumn<DocumentRow>[] = [
    { key: "title", header: t("docs.col.document"), render: (row) => row.title, sortable: true },
    { key: "category", header: t("docs.col.category"), render: categoryLabel },
    {
      key: "issue_date",
      header: t("docs.col.issued"),
      width: "9rem",
      sortable: true,
      render: (row) => dash(row.issue_date, fmtCivilDate),
    },
    {
      key: "issued_by",
      header: t("docs.col.issuedBy"),
      hideBelow: "lg",
      render: filerLabel,
    },
    { key: "expiry_date", header: t("docs.col.validTo"), hideBelow: "md", render: validTo },
    {
      key: "status",
      header: t("docs.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={DOC_STATUS_MAP} />,
    },
    { key: "action", header: t("docs.col.action"), align: "right", width: "7rem", render: ViewAction },
  ];

  const uploadColumns: DataGridColumn<DocumentRow>[] = [
    { key: "title", header: t("docs.col.document"), render: (row) => row.title, sortable: true },
    { key: "category", header: t("docs.col.category"), render: categoryLabel },
    {
      key: "uploaded_at",
      header: t("docs.col.uploaded"),
      width: "12rem",
      sortable: true,
      render: (row) => fmtDateTime(row.uploaded_at),
    },
    { key: "expiry_date", header: t("docs.col.validTo"), hideBelow: "md", render: validTo },
    {
      key: "status",
      header: t("docs.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={DOC_STATUS_MAP} />,
    },
    {
      key: "review",
      header: t("docs.col.reviewNote"),
      hideBelow: "lg",
      render: (row) => dash(row.review_comment),
    },
    { key: "action", header: t("docs.col.action"), align: "right", width: "7rem", render: ViewAction },
  ];

  const signedColumns: DataGridColumn<DocumentAck>[] = [
    {
      key: "title",
      header: t("docs.col.document"),
      render: (row) => dash(row.documents?.title ?? null),
    },
    {
      key: "category",
      header: t("docs.col.category"),
      render: (row) => dash(row.documents?.document_types?.name ?? null),
    },
    {
      key: "version",
      header: t("docs.col.version"),
      width: "6rem",
      hideBelow: "lg",
      render: (row) => dash(row.documents?.current_version ?? null, (v) => `v${v}`),
    },
    {
      key: "acknowledged_at",
      header: t("docs.col.acknowledged"),
      width: "13rem",
      render: (row) => dash(row.acknowledged_at, fmtDateTime),
    },
    {
      key: "what",
      header: t("docs.signed.col.what"),
      hideBelow: "lg",
      render: (row) => dash(row.acknowledgement_text),
    },
    {
      key: "status",
      header: t("docs.col.status"),
      width: "10rem",
      render: (row) => <StatusChip status={row.status} map={ACK_STATUS_MAP} />,
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader icon={FileText} title={t("docs.title")} subtitle={t("docs.subtitle")} />

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList aria-label={t("docs.tabs.label")} className="mb-4 h-auto flex-wrap">
          <TabsTrigger value="issued">{t("docs.tab.issued")}</TabsTrigger>
          <TabsTrigger value="uploads">{t("docs.tab.uploads")}</TabsTrigger>
          <TabsTrigger value="signed">{t("docs.tab.signed")}</TabsTrigger>
        </TabsList>

        <TabsContent value="issued">
          <StateBoundary
            loading={docs.isLoading}
            error={docs.error ?? undefined}
            onRetry={() => void docs.refetch()}
            isEmpty={docs.data !== undefined && issued.length === 0}
            empty={
              <EmptyState
                icon={Inbox}
                title={t("docs.issued.empty.title")}
                hint={t("docs.issued.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={issuedColumns}
              rows={issued}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </TabsContent>

        <TabsContent value="uploads">
          <StateBoundary
            loading={docs.isLoading}
            error={docs.error ?? undefined}
            onRetry={() => void docs.refetch()}
            isEmpty={docs.data !== undefined && uploads.length === 0}
            empty={
              <EmptyState
                icon={Upload}
                title={t("docs.uploads.empty.title")}
                hint={t("docs.uploads.empty.hint")}
              />
            }
          >
            {/*
              This said "self-upload is not switched on yet — send it to HR via the Help
              Desk", which stopped being true when `/me/profile/documents` shipped its
              upload form and `documents__self__insert` was granted. It was telling
              employees to raise a ticket for something they could already do themselves.
              Uploading lives in the profile and only there; this console reads.
            */}
            <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {t("docs.upload.whereToUpload")}
              <Button asChild size="sm" variant="outline" className="h-7">
                <Link to="/me/profile/documents">
                  <Upload className="mr-1.5 size-3.5" aria-hidden />
                  {t("docs.upload.goToProfile")}
                </Link>
              </Button>
            </p>
            <DataGrid
              columns={uploadColumns}
              rows={uploads}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </TabsContent>

        <TabsContent value="signed">
          <StateBoundary
            loading={signed.isLoading}
            error={signed.error ?? undefined}
            onRetry={() => void signed.refetch()}
            isEmpty={signed.data !== undefined && signed.data.length === 0}
            empty={
              <EmptyState
                icon={PenLine}
                title={t("docs.signed.empty.title")}
                hint={t("docs.signed.empty.hint")}
              />
            }
          >
            <DataGrid
              columns={signedColumns}
              rows={signed.data ?? []}
              rowKey={(row) => row.id}
              pageSize={25}
            />
          </StateBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}
