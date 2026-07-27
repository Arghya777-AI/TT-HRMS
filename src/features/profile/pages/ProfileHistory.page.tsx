/**
 * E-07.8 · /me/profile/history — every change to MY record: who, what,
 * from → to, when, and why.
 *
 * Two sources merged by `useRecordHistory` (history.api.buildRecordHistory):
 * applied change requests and lifecycle events, newest first. The attribution
 * distinguishes "you", "HR on your behalf" (the assisted-mode case for
 * kiosk-only staff), "HR" and "the system" — the reference product rendered
 * all four identically, which is exactly the ambiguity an audit trail exists
 * to remove.
 *
 * Pending/rejected change requests are a separate card above the history: a
 * request that has not been applied is a promise, not a change, and mixing the
 * two invites "but it says it changed" support calls.
 *
 * @route /me/profile/history
 */
import { CircleDashed, History } from "lucide-react";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { fmtDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { ProfileShell } from "../components/ProfileShell";
import { ProfileCard } from "../components/FieldRow";
import { useChangeRequests, useMyProfile, useOrgLabels, useRecordHistory } from "../hooks/useProfile";
import type { HistoryActor } from "../api/history.api";

const REQUEST_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("profile.history.req.pending"), tone: "warn" },
  approved: { label: t("profile.history.req.approved"), tone: "success" },
  rejected: { label: t("profile.history.req.rejected"), tone: "danger" },
  cancelled: { label: t("profile.history.req.cancelled"), tone: "neutral" },
};

function actorLabel(actor: HistoryActor): string {
  switch (actor) {
    case "you":
      return t("profile.history.actor.you");
    case "hr_on_your_behalf":
      return t("profile.history.actor.hrForYou");
    case "hr":
      return t("profile.history.actor.hr");
    case "system":
      return t("profile.history.actor.system");
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return t("profile.history.notSet");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default function ProfileHistoryPage() {
  const profile = useMyProfile();
  const orgLabels = useOrgLabels();
  const history = useRecordHistory();
  const requests = useChangeRequests();

  const openRequests = (requests.data ?? []).filter((r) => r.applied_at === null);
  const entries = history.data ?? [];

  return (
    <ProfileShell
      title={t("profile.history.title")}
      subtitle={t("profile.history.subtitle")}
      profile={profile.data}
      orgLabels={orgLabels.data}
      loading={profile.isPending}
      error={profile.error}
      onRetry={() => void profile.refetch()}
      partialError={requests.error}
      partialLabel={t("profile.history.partial")}
    >
      {openRequests.length > 0 ? (
        <ProfileCard
          icon={CircleDashed}
          title={t("profile.history.open.title")}
          description={t("profile.history.open.hint")}
        >
          <ul className="divide-y">
            {openRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{r.field_label}</p>
                  <p className="text-xs text-muted-foreground">
                    {renderValue(r.old_value)} → {renderValue(r.new_value)}
                    {" · "}
                    {fmtDateTime(r.requested_at)}
                  </p>
                  {r.decision_comment !== null ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("profile.history.decision", { comment: r.decision_comment })}
                    </p>
                  ) : null}
                </div>
                <StatusChip status={r.status} map={REQUEST_CHIP} />
              </li>
            ))}
          </ul>
        </ProfileCard>
      ) : null}

      <StateBoundary
        loading={history.isPending}
        error={history.error}
        onRetry={() => void history.refetch()}
        isEmpty={entries.length === 0}
        empty={
          <EmptyState
            icon={History}
            title={t("profile.history.empty.title")}
            hint={t("profile.history.empty.hint")}
          />
        }
        skeletonRows={5}
      >
        <ProfileCard icon={History} title={t("profile.history.applied.title")} description={t("profile.history.applied.hint")}>
          <ol className="relative space-y-0 border-l pl-5">
            {entries.map((entry) => (
              <li key={entry.id} className={cn("relative py-3", entry.reversed && "opacity-60")}>
                <span
                  className="absolute -left-[1.4rem] top-4 size-2.5 rounded-full border-2 border-background bg-primary"
                  aria-hidden
                />
                <p className="text-sm font-medium">
                  {entry.what}
                  {entry.reversed ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {t("profile.history.reversed")}
                    </span>
                  ) : null}
                </p>
                <p className="num mt-0.5 text-xs text-muted-foreground">
                  {renderValue(entry.from)} → {renderValue(entry.to)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtDateTime(entry.occurredAt)} · {actorLabel(entry.actor)}
                  {entry.reason !== null
                    ? " · " + t("profile.history.because", { reason: entry.reason })
                    : null}
                </p>
              </li>
            ))}
          </ol>
        </ProfileCard>
      </StateBoundary>
    </ProfileShell>
  );
}
