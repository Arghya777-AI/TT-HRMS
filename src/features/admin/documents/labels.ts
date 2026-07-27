/**
 * labels.ts — the words and tones for every document vocabulary, in one place.
 *
 * Eight screens read the same six enums (`document_status`, `virus_scan_status`,
 * acknowledgement status, compliance status, `esign_status`, `signer_status`)
 * plus four CHECK vocabularies (category, subject kind, retention basis,
 * contract kind). Repeating the maps per screen is how the Approval Queue and
 * the Repository end up disagreeing about what "pending_review" is called.
 *
 * Tones are chosen for a SCAN: `infected`, `expired` and `missing` are the three
 * an administrator must never skim past, so they are the only danger tones.
 *
 * Everything here is pure — no React, no supabase.
 */
import type { StatusChipEntry } from "@/shared/ui/StatusChip";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type {
  AccessKind,
  AckStatus,
  ComplianceStatus,
  ContractKind,
  DocumentCategory,
  DocumentStatus,
  EsignStatus,
  SignerStatus,
  SubjectKind,
  VirusScanStatus,
} from "../api/documents.api";

export const CATEGORY_LABELS: Readonly<Record<DocumentCategory, string>> = {
  identity: t("admin.docs.cat.identity"),
  employment: t("admin.docs.cat.employment"),
  education: t("admin.docs.cat.education"),
  statutory: t("admin.docs.cat.statutory"),
  payroll: t("admin.docs.cat.payroll"),
  policy: t("admin.docs.cat.policy"),
  compliance: t("admin.docs.cat.compliance"),
  medical: t("admin.docs.cat.medical"),
  exit: t("admin.docs.cat.exit"),
  other: t("admin.docs.cat.other"),
};

export const DOCUMENT_STATUS_CHIP: Readonly<Record<DocumentStatus, StatusChipEntry>> = {
  draft: { label: t("admin.docs.status.draft"), tone: "neutral" },
  pending_review: { label: t("admin.docs.status.pendingReview"), tone: "warn" },
  approved: { label: t("admin.docs.status.approved"), tone: "success" },
  rejected: { label: t("admin.docs.status.rejected"), tone: "danger" },
  expired: { label: t("admin.docs.status.expired"), tone: "danger" },
  superseded: { label: t("admin.docs.status.superseded"), tone: "neutral" },
  archived: { label: t("admin.docs.status.archived"), tone: "neutral" },
};

export const VIRUS_CHIP: Readonly<Record<VirusScanStatus, StatusChipEntry>> = {
  pending: { label: t("admin.docs.virus.pending"), tone: "warn" },
  clean: { label: t("admin.docs.virus.clean"), tone: "success" },
  infected: { label: t("admin.docs.virus.infected"), tone: "danger" },
  skipped: { label: t("admin.docs.virus.skipped"), tone: "neutral" },
};

export const ACK_STATUS_CHIP: Readonly<Record<AckStatus, StatusChipEntry>> = {
  assigned: { label: t("admin.docs.ack.assigned"), tone: "info" },
  opened: { label: t("admin.docs.ack.opened"), tone: "warn" },
  acknowledged: { label: t("admin.docs.ack.acknowledged"), tone: "success" },
  overdue: { label: t("admin.docs.ack.overdue"), tone: "danger" },
  waived: { label: t("admin.docs.ack.waived"), tone: "neutral" },
};

export const COMPLIANCE_CHIP: Readonly<Record<ComplianceStatus, StatusChipEntry>> = {
  missing: { label: t("admin.docs.comp.missing"), tone: "danger" },
  expired: { label: t("admin.docs.comp.expired"), tone: "danger" },
  expiring_soon: { label: t("admin.docs.comp.expiringSoon"), tone: "warn" },
  valid: { label: t("admin.docs.comp.valid"), tone: "success" },
};

export const ESIGN_CHIP: Readonly<Record<EsignStatus, StatusChipEntry>> = {
  draft: { label: t("admin.docs.esign.draft"), tone: "neutral" },
  sent: { label: t("admin.docs.esign.sent"), tone: "info" },
  partially_signed: { label: t("admin.docs.esign.partiallySigned"), tone: "warn" },
  completed: { label: t("admin.docs.esign.completed"), tone: "success" },
  declined: { label: t("admin.docs.esign.declined"), tone: "danger" },
  expired: { label: t("admin.docs.esign.expired"), tone: "danger" },
  cancelled: { label: t("admin.docs.esign.cancelled"), tone: "neutral" },
  voided: { label: t("admin.docs.esign.voided"), tone: "neutral" },
};

export const SIGNER_CHIP: Readonly<Record<SignerStatus, StatusChipEntry>> = {
  pending: { label: t("admin.docs.signer.pending"), tone: "neutral" },
  notified: { label: t("admin.docs.signer.notified"), tone: "info" },
  viewed: { label: t("admin.docs.signer.viewed"), tone: "info" },
  identity_verified: { label: t("admin.docs.signer.identityVerified"), tone: "info" },
  signed: { label: t("admin.docs.signer.signed"), tone: "success" },
  declined: { label: t("admin.docs.signer.declined"), tone: "danger" },
  delegated: { label: t("admin.docs.signer.delegated"), tone: "warn" },
  expired: { label: t("admin.docs.signer.expired"), tone: "danger" },
};

export const SUBJECT_KIND_LABELS: Readonly<Record<SubjectKind, string>> = {
  employee: t("admin.docs.subject.employee"),
  company: t("admin.docs.subject.company"),
  policy: t("admin.docs.subject.policy"),
  asset: t("admin.docs.subject.asset"),
  payroll_run: t("admin.docs.subject.payrollRun"),
  event: t("admin.docs.subject.event"),
  vendor: t("admin.docs.subject.vendor"),
};

export const ACCESS_KIND_LABELS: Readonly<Record<AccessKind, string>> = {
  view: t("admin.docs.access.view"),
  download: t("admin.docs.access.download"),
  print: t("admin.docs.access.print"),
  signed_url_minted: t("admin.docs.access.signedUrlMinted"),
  email_attachment: t("admin.docs.access.emailAttachment"),
  api: t("admin.docs.access.api"),
};

export const RETENTION_BASIS_LABELS: Readonly<Record<string, string>> = {
  from_upload: t("admin.docs.retention.fromUpload"),
  from_exit: t("admin.docs.retention.fromExit"),
  from_expiry: t("admin.docs.retention.fromExpiry"),
  indefinite: t("admin.docs.retention.indefinite"),
};

export const CONTRACT_KIND_LABELS: Readonly<Record<ContractKind, string>> = {
  employment_permanent: t("admin.docs.kind.employmentPermanent"),
  employment_probation: t("admin.docs.kind.employmentProbation"),
  fixed_term: t("admin.docs.kind.fixedTerm"),
  internship: t("admin.docs.kind.internship"),
  consultant: t("admin.docs.kind.consultant"),
  retainer: t("admin.docs.kind.retainer"),
  casual_daily_wage: t("admin.docs.kind.casualDailyWage"),
  nda: t("admin.docs.kind.nda"),
  non_compete: t("admin.docs.kind.nonCompete"),
  training_bond: t("admin.docs.kind.trainingBond"),
};

/**
 * A file size in the unit a person reads. This is a UNIT change on one displayed
 * value — the same class of render as rupees from integer paise — not a business
 * figure: nothing is summed, averaged or compared. The byte count itself is the
 * server's `file_size_bytes`.
 */
export function fmtFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return t("admin.docs.size.bytes", { n: formatNumber(bytes) });
  if (bytes < 1024 * 1024) {
    return t("admin.docs.size.kb", { n: (bytes / 1024).toFixed(1) });
  }
  return t("admin.docs.size.mb", { n: (bytes / (1024 * 1024)).toFixed(2) });
}

/** A subject kind that is not in the CHECK list renders as itself, never blank. */
export function subjectKindLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(SUBJECT_KIND_LABELS, kind)
    ? SUBJECT_KIND_LABELS[kind as SubjectKind]
    : kind;
}

export function categoryLabel(category: DocumentCategory): string {
  return CATEGORY_LABELS[category];
}

export function retentionBasisLabel(basis: string): string {
  return RETENTION_BASIS_LABELS[basis] ?? basis;
}
