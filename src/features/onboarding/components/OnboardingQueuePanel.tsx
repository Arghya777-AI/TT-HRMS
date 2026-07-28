/**
 * OnboardingQueuePanel — who has finished first-login onboarding, and who HR must chase.
 *
 * Mounted on the People directory, because "which of my joiners still owes paperwork" is a
 * question about people, and HR is already on that screen when they think to ask it.
 *
 * THE WAIVER ASKS FOR A REASON IN A PROMPT, not a free pass on a button. The server demands
 * ten characters and still demands an Aadhaar or PAN on file, and it refuses in plain
 * sentences — which are shown as-is rather than re-worded, because the server's wording is
 * the accurate one and a paraphrase would drift from what actually happened.
 *
 * Reviewing GRANTS NOTHING. Access was given the moment the joiner submitted; this records
 * that a human looked. So the button reads as bookkeeping, not as approval, and an
 * unreviewed row is a task rather than a blocked person.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { shouldRetryQuery } from "@/shared/api/query";
import { asArray } from "@/lib/asArray";
import { fmtCivilDate } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "@/features/admin/components/PersonCell";
import {
  fetchOnboardingQueue,
  reviewOnboarding,
  waiveOnboarding,
  type OnboardingState,
  type QueueRow,
} from "../api/onboardingAdmin.api";

const KEY = ["admin", "onboarding-queue"] as const;

const STATE_CHIP: Readonly<Record<OnboardingState, StatusChipEntry>> = {
  not_started: { label: t("onboarding.state.notStarted"), tone: "warn" },
  awaiting_review: { label: t("onboarding.state.awaitingReview"), tone: "info" },
  waived: { label: t("onboarding.state.waived"), tone: "neutral" },
  reviewed: { label: t("onboarding.state.reviewed"), tone: "success" },
};

function RowActions({ row }: { row: QueueRow }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const review = useMutation({ mutationFn: () => reviewOnboarding(row.employee_id), onSuccess: done, onError: fail });
  const waive = useMutation({
    mutationFn: (reason: string) => waiveOnboarding(row.employee_id, reason),
    onSuccess: done,
    onError: fail,
  });

  if (!row.can_manage) {
    return <span className="text-xs text-muted-foreground">{t("onboarding.adminOnly")}</span>;
  }

  const busy = review.isPending || waive.isPending;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {row.state === "awaiting_review" ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => review.mutate()}>
            <ClipboardCheck className="mr-2 size-4" aria-hidden />
            {t("onboarding.markReviewed")}
          </Button>
        ) : null}
        {row.state === "not_started" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              // A prompt, not a bare button: the server requires ten characters and the
              // reason is what the audit row will carry months from now.
              const reason = window.prompt(t("onboarding.waivePrompt"));
              if (reason !== null && reason.trim().length > 0) waive.mutate(reason.trim());
            }}
          >
            {t("onboarding.waive")}
          </Button>
        ) : null}
      </div>
      {/* The server's own sentence — "a waiver still needs an Aadhaar or PAN number on file"
          is more useful than any paraphrase of it. */}
      {error !== null ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export function OnboardingQueuePanel() {
  const queue = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchOnboardingQueue(signal),
    retry: shouldRetryQuery,
  });
  const rows = asArray(queue.data);
  const chasing = rows.filter((r) => r.state === "not_started").length;

  const columns: DataGridColumn<QueueRow>[] = [
    {
      key: "display_name",
      header: t("onboarding.col.person"),
      width: "17rem",
      render: (row) => <PersonCell name={row.display_name ?? "—"} code={row.employee_code ?? ""} />,
    },
    {
      key: "date_of_join",
      header: t("onboarding.col.joined"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => (row.date_of_join === null ? "—" : fmtCivilDate(row.date_of_join)),
    },
    {
      key: "state",
      header: t("onboarding.col.state"),
      width: "11rem",
      render: (row) => <StatusChip status={row.state} map={STATE_CHIP} />,
    },
    {
      key: "outstanding_documents",
      header: t("onboarding.col.outstanding"),
      width: "12rem",
      hideBelow: "md",
      /* Zero is worth saying out loud rather than showing a bare 0 — "nothing outstanding"
         is the answer HR is looking for. */
      render: (row) =>
        row.outstanding_documents === 0 ? (
          <span className="text-sm text-muted-foreground">{t("onboarding.noneOutstanding")}</span>
        ) : (
          <span className="num text-sm">
            {t("onboarding.docsOutstanding", { n: row.outstanding_documents })}
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "16rem",
      render: (row) => <RowActions row={row} />,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <UserCheck className="size-4 text-muted-foreground" aria-hidden />
        {t("onboarding.queue.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {chasing > 0
          ? t("onboarding.queue.chasing", { n: chasing })
          : t("onboarding.queue.allDone")}
      </p>

      <div className="mt-3">
        <StateBoundary
          loading={queue.isPending}
          error={queue.error}
          onRetry={() => void queue.refetch()}
          isEmpty={!queue.isPending && queue.error === null && rows.length === 0}
          empty={<EmptyState icon={UserCheck} title={t("onboarding.queue.empty")} />}
          skeletonRows={4}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employee_id} pageSize={15} />
        </StateBoundary>
      </div>
    </section>
  );
}
