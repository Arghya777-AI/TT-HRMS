import { Badge } from "@/components/ui/badge";

export type StatusTone = "success" | "warn" | "danger" | "info" | "neutral";

export interface StatusChipEntry {
  label: string;
  tone: StatusTone;
}

export interface StatusChipProps {
  /** Raw status value (typically a server enum, e.g. 'missing_punch'). */
  status: string;
  /** Vocabulary map: status → {label, tone}. Unmapped statuses render humanised + neutral. */
  map?: Record<string, StatusChipEntry>;
}

const TONE_VARIANT: Record<StatusTone, "success" | "warning" | "danger" | "info" | "neutral"> = {
  success: "success",
  warn: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
};

/** Sane defaults for cross-domain vocabulary; feature maps override per screen. */
const DEFAULT_MAP: Record<string, StatusChipEntry> = {
  approved: { label: "Approved", tone: "success" },
  present: { label: "Present", tone: "success" },
  active: { label: "Active", tone: "success" },
  published: { label: "Published", tone: "success" },
  available: { label: "Available", tone: "success" },
  pending: { label: "Pending", tone: "warn" },
  pending_l1: { label: "With manager", tone: "warn" },
  pending_l2: { label: "With HR", tone: "warn" },
  missing_punch: { label: "Missing punch", tone: "warn" },
  proposed: { label: "Awaiting approval", tone: "warn" },
  in_progress: { label: "In progress", tone: "info" },
  draft: { label: "Draft", tone: "neutral" },
  on_leave: { label: "On leave", tone: "info" },
  weekly_off: { label: "Weekly off", tone: "neutral" },
  holiday: { label: "Holiday", tone: "neutral" },
  not_yet: { label: "Upcoming", tone: "neutral" },
  rejected: { label: "Rejected", tone: "danger" },
  absent: { label: "Absent", tone: "danger" },
  short_day: { label: "Short day", tone: "danger" },
  lapsed: { label: "Lapsed", tone: "danger" },
  suspended: { label: "Suspended", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
};

/** 'missing_punch' → 'Missing punch' — never a bare internal code in the UI (D-10). */
function humanise(status: string): string {
  const words = status.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function StatusChip({ status, map }: StatusChipProps) {
  const entry = map?.[status] ?? DEFAULT_MAP[status] ?? { label: humanise(status), tone: "neutral" as const };
  return <Badge variant={TONE_VARIANT[entry.tone]}>{entry.label}</Badge>;
}
