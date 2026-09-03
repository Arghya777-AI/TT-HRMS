/**
 * OffHoursApprovals — the punches waiting on a decision.
 *
 * ── WHAT A DECISION DOES, WHICH IS WHY IT ASKS FOR A REASON ──────────────────
 * APPROVE stamps the punch. The hours were always in the day's figure; approving is what
 * releases them into the monthly total, so payroll sees them.
 *
 * REJECT voids it. The hours leave the day as well as the month — the honest outcome of "these
 * were not worked". It is not a delete: who refused it and why stay on the row forever.
 *
 * Both are irreversible through this screen and both change somebody's pay, so both go through
 * the reason dialog every other consequential admin action here uses. The employee sees that
 * sentence, which is the main argument for making it a real one.
 *
 * ── WHY THE DISTANCE IS ON EVERY ROW ─────────────────────────────────────────
 * The question an administrator is actually answering is "were they where they say they were".
 * The reason is what the employee typed; the distance from the venue is the one fact on the row
 * they did not choose. Shown together, deliberately.
 */
import { useMemo } from "react";
import { CalendarClock, Check, FileWarning, Globe, MapPin, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { fmtCivilDate } from "@/lib/datetime";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { openStreetMapUrl } from "@/lib/punchPlace";
import { distanceFromVenue, formatDistance, type VenuePoint } from "@/lib/venueDistance";
import { useReasonPrompt } from "../hooks/useReasonPrompt";
import { DocumentOpenButtons } from "@/features/docs/components/DocumentOpenButtons";
import { usePendingApprovalPunches, useDecideOffHoursPunch } from "../hooks/useAttendanceRecords";
import type { PendingApprovalPunch } from "../api/attendance.api";

export interface OffHoursApprovalsProps {
  /** The venue, for the distance on each row. Null when its coordinates are unset. */
  readonly venue: VenuePoint | null;
}

/** Postgres `numeric` arrives as a string; `Number(null)` is 0, which is a real coordinate. */
function num(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function OffHoursApprovals({ venue }: OffHoursApprovalsProps): React.JSX.Element {
  const pending = usePendingApprovalPunches();
  const decide = useDecideOffHoursPunch();
  const prompt = useReasonPrompt<{ punch: PendingApprovalPunch; approve: boolean }>();

  const rows = useMemo(() => pending.data ?? [], [pending.data]);
  const deciding = decide.isPending ? (prompt.target?.punch.id ?? null) : null;
  const approving = prompt.target?.approve === true;

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
            <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {t("admin.offHours.title")}
            {rows.length > 0 ? (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                {rows.length}
              </span>
            ) : null}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("admin.offHours.subtitle")}</p>
        </div>
      </div>

      <StateBoundary
        loading={pending.isLoading}
        error={pending.error ?? undefined}
        onRetry={() => void pending.refetch()}
        skeletonRows={3}
      >
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title={t("admin.offHours.empty.title")} hint={t("admin.offHours.empty.hint")} />
          </div>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => {
              const lat = num(row.lat);
              const lng = num(row.lng);
              const accuracyMetres = num(row.location_accuracy_m);
              const distance =
                lat === null || lng === null
                  ? null
                  : distanceFromVenue({ latitude: lat, longitude: lng, accuracyMetres }, venue);
              const href =
                lat === null || lng === null
                  ? null
                  : openStreetMapUrl({ latitude: lat, longitude: lng, accuracyMetres });

              return (
                <li key={row.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {row.display_name}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {row.employee_code}
                      </span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {fmtCivilDate(row.ist_date)} · {row.ist_time ?? "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Globe className="size-3 shrink-0" aria-hidden />
                        {t("admin.offHours.viaWeb")}
                      </span>
                      {/* The fact they did not choose, beside the one they typed. */}
                      {href === null ? (
                        <span>{t("admin.offHours.noLocation")}</span>
                      ) : (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            "inline-flex items-center gap-1 underline decoration-dotted underline-offset-2",
                            distance !== null && !distance.withinFence ? "text-warning" : "",
                          )}
                        >
                          <MapPin className="size-3 shrink-0" aria-hidden />
                          {distance === null
                            ? t("admin.offHours.venueUnset")
                            : formatDistance(distance.metres)}
                        </a>
                      )}
                    </p>
                    {/* Their own words, quoted rather than paraphrased. */}
                    <p className="mt-1 rounded-md bg-muted/40 px-2 py-1 text-sm">
                      {row.reason ?? t("admin.offHours.noReason")}
                    </p>

                    {/*
                      ── THE PROOF ────────────────────────────────────────────
                      "I don't want to pay so much and I don't want to keep on verifying all
                      that. So it's better they attach screenshots for check-in and check out."

                      Opened through `document-access`, which logs the view BEFORE it mints a
                      URL — for evidence that decides whether overtime is paid, that trail is
                      the point.

                      ABSENCE IS STATED, in words. The form makes the picture mandatory, so a
                      null here means the upload failed and the punch was recorded anyway
                      rather than losing somebody's evening. Rendering nothing would let an
                      approver assume a photograph exists and never open it.
                    */}
                    {row.proof_document_id !== null ? (
                      <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border px-2 py-1">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
                          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          {t("admin.offHours.proof.attached")}
                        </span>
                        <DocumentOpenButtons
                          documentId={row.proof_document_id}
                          title={t("admin.offHours.proof.attached")}
                          variant="icon"
                        />
                      </div>
                    ) : (
                      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warning">
                        <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        {t("admin.offHours.proof.missing")}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={deciding !== null}
                      onClick={() => prompt.ask({ punch: row, approve: true })}
                    >
                      <Check className="mr-1.5 size-3.5" aria-hidden />
                      {t("admin.offHours.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={deciding !== null}
                      onClick={() => prompt.ask({ punch: row, approve: false })}
                    >
                      <X className="mr-1.5 size-3.5" aria-hidden />
                      {t("admin.offHours.reject")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </StateBoundary>

      <ReasonDialog
        open={prompt.isOpen}
        title={
          approving
            ? t("admin.offHours.approve.title", { name: prompt.target?.punch.display_name ?? "" })
            : t("admin.offHours.reject.title", { name: prompt.target?.punch.display_name ?? "" })
        }
        description={
          approving ? t("admin.offHours.approve.description") : t("admin.offHours.reject.description")
        }
        minLength={10}
        confirmLabel={approving ? t("admin.offHours.approve") : t("admin.offHours.reject")}
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={(reason) => {
          const target = prompt.target;
          if (target === null) return;
          decide.save({ punchId: target.punch.id, approve: target.approve }, reason);
          prompt.close();
        }}
        onCancel={() => prompt.close()}
      />
    </section>
  );
}
