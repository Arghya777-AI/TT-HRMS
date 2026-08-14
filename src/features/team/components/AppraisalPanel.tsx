/**
 * AppraisalPanel — the review a manager actually writes.
 *
 * ── WHY THIS SITS BELOW THE ATTENDANCE FIGURES, NOT ABOVE THEM ──────────────
 *
 * /team/performance showed attendance and said, correctly, that it was "evidence
 * you can take into a review rather than a number nothing stands behind". The
 * review now exists (043900) and this is where it is written — deliberately
 * underneath that evidence, so the manager scrolls past the hours, the lateness
 * and the overtime before typing a judgement.
 *
 * Nothing on this screen turns one into the other. There is no button that fills
 * a rating from punctuality, and the two are never multiplied.
 *
 * ── NO AVERAGE IS SHOWN ─────────────────────────────────────────────────────
 *
 * The competency lines are not summed into anything. `overall_rating` is a
 * separate answer the reviewer gives, because averaging four judgements into 3.25
 * makes "solid everywhere" and "outstanding at the job, poor with colleagues" the
 * same number — and the second is the one that needs a conversation.
 */
import { useState } from "react";
import { ClipboardList, Send, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { Notice } from "@/features/admin/components/Notice";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  MANAGER_COMMENT_MIN_LENGTH,
  RATING_VALUES,
  reviewBlockers,
  type Appraisal,
} from "../api/appraisals.api";
import {
  useAppraisalCycles,
  useAppraisalRatings,
  useAppraisals,
  useSaveRating,
  useShareAppraisal,
  useSubmitManagerReview,
} from "../hooks/useAppraisals";

const APPRAISAL_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  not_started: { label: t("teamExtra.appr.status.notStarted"), tone: "neutral" },
  self_submitted: { label: t("teamExtra.appr.status.selfDone"), tone: "info" },
  manager_submitted: { label: t("teamExtra.appr.status.reviewed"), tone: "warn" },
  shared: { label: t("teamExtra.appr.status.shared"), tone: "success" },
  acknowledged: { label: t("teamExtra.appr.status.acknowledged"), tone: "success" },
};

export interface AppraisalPanelProps {
  /** employee_id → display name, for the rows. */
  readonly nameOf: (employeeId: string) => string;
}

export function AppraisalPanel({ nameOf }: AppraisalPanelProps) {
  const cycles = useAppraisalCycles();
  const [cycleId, setCycleId] = useState<string | null>(null);
  const chosen = cycleId ?? cycles.data?.[0]?.id ?? null;
  const appraisals = useAppraisals(chosen);
  const [openId, setOpenId] = useState<string | null>(null);

  const cycle = (cycles.data ?? []).find((c) => c.id === chosen) ?? null;

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="appr-panel">
      <h2 id="appr-panel" className="flex items-center gap-2 font-display text-lg font-semibold">
        <ClipboardList className="size-4" aria-hidden />
        {t("teamExtra.appr.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("teamExtra.appr.hint")}</p>

      <StateBoundary
        loading={cycles.isLoading}
        error={cycles.error ?? undefined}
        onRetry={() => void cycles.refetch()}
        isEmpty={cycles.data !== undefined && cycles.data.length === 0}
        empty={
          <EmptyState
            icon={ClipboardList}
            title={t("teamExtra.appr.noCycle.title")}
            hint={t("teamExtra.appr.noCycle.hint")}
          />
        }
        skeletonRows={2}
      >
        {(cycles.data ?? []).length > 1 ? (
          <select
            aria-label={t("teamExtra.appr.pickCycle")}
            className="mt-3 h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={chosen ?? ""}
            onChange={(e) => {
              setCycleId(e.target.value);
              setOpenId(null);
            }}
          >
            {(cycles.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}

        {cycle === null ? null : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("teamExtra.appr.period", {
              from: fmtCivilDate(cycle.period_from),
              to: fmtCivilDate(cycle.period_to),
            })}
          </p>
        )}

        <StateBoundary
          loading={appraisals.isLoading}
          error={appraisals.error ?? undefined}
          onRetry={() => void appraisals.refetch()}
          isEmpty={appraisals.data !== undefined && appraisals.data.length === 0}
          empty={
            <EmptyState
              icon={ClipboardList}
              title={t("teamExtra.appr.none.title")}
              hint={t("teamExtra.appr.none.hint")}
            />
          }
          skeletonRows={3}
        >
          <ul className="mt-3 space-y-2">
            {(appraisals.data ?? []).map((a) => (
              <li key={a.id} className="rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium leading-snug">{nameOf(a.employee_id)}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.self_submitted_at === null
                        ? t("teamExtra.appr.noSelf")
                        : t("teamExtra.appr.selfIn", {
                            at: fmtDateTime(a.self_submitted_at),
                          })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip status={a.status} map={APPRAISAL_CHIP} />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpenId(openId === a.id ? null : a.id)}
                    >
                      {openId === a.id ? t("teamExtra.appr.close") : t("teamExtra.appr.review")}
                    </Button>
                  </div>
                </div>
                {openId === a.id ? <ReviewForm appraisal={a} /> : null}
              </li>
            ))}
          </ul>
        </StateBoundary>
      </StateBoundary>
    </section>
  );
}

/** One person's review: the competency lines, then the verdict. */
function ReviewForm({ appraisal }: { readonly appraisal: Appraisal }) {
  const ratings = useAppraisalRatings(appraisal.id);
  const saveRating = useSaveRating();
  const submit = useSubmitManagerReview();
  const share = useShareAppraisal();

  const [comment, setComment] = useState(appraisal.manager_comment ?? "");
  const [overall, setOverall] = useState<number | null>(appraisal.overall_rating);

  const blockers = reviewBlockers(comment, overall);
  /* Submitted already: the lines and the verdict are the record now. Sharing is
     the only thing left, and it is a separate, deliberate act. */
  const submitted = appraisal.manager_submitted_at !== null;

  return (
    <div className="mt-3 border-t pt-3">
      <StateBoundary
        loading={ratings.isLoading}
        error={ratings.error ?? undefined}
        onRetry={() => void ratings.refetch()}
        skeletonRows={3}
      >
        <ul className="space-y-2">
          {(ratings.data ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">{r.label}</span>
              <span className="flex items-center gap-3">
                {/* What the person said about themselves, shown but never copied
                    into the manager's answer — they are two opinions. */}
                <span className="text-xs text-muted-foreground">
                  {t("teamExtra.appr.self", { n: dash(r.self_rating) })}
                </span>
                <span className="flex gap-1">
                  {RATING_VALUES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-label={t("teamExtra.appr.rate", { label: r.label, n: String(v) })}
                      aria-pressed={r.manager_rating === v}
                      disabled={submitted || saveRating.isPending}
                      className={
                        "size-8 rounded-md border text-xs font-medium transition-colors " +
                        (r.manager_rating === v
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input hover:border-primary/50")
                      }
                      onClick={() =>
                        saveRating.mutate({
                          input: { ratingId: r.id, patch: { manager_rating: v } },
                          reason: `performance review: rate "${r.label}" as ${String(v)} of 5`,
                        })
                      }
                    >
                      {v}
                    </button>
                  ))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </StateBoundary>

      {appraisal.self_comment === null ? null : (
        <div className="mt-3 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("teamExtra.appr.theirWords")}
          </p>
          <p className="mt-1 text-sm">{appraisal.self_comment}</p>
        </div>
      )}

      <div className="mt-3">
        <label htmlFor={`overall-${appraisal.id}`} className="text-sm font-medium">
          {t("teamExtra.appr.overall")}
        </label>
        {/* STATED, not averaged from the lines above — see the file header. */}
        <p className="mt-0.5 text-xs text-muted-foreground">{t("teamExtra.appr.overallHint")}</p>
        <div className="mt-1.5 flex gap-1" id={`overall-${appraisal.id}`}>
          {RATING_VALUES.map((v) => (
            <button
              key={v}
              type="button"
              aria-label={t("teamExtra.appr.overallRate", { n: String(v) })}
              aria-pressed={overall === v}
              disabled={submitted}
              className={
                "size-9 rounded-md border text-sm font-medium transition-colors " +
                (overall === v
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input hover:border-primary/50")
              }
              onClick={() => setOverall(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor={`comment-${appraisal.id}`} className="text-sm font-medium">
          {t("teamExtra.appr.comment")}
        </label>
        <textarea
          id={`comment-${appraisal.id}`}
          rows={3}
          disabled={submitted}
          maxLength={4000}
          className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          placeholder={t("teamExtra.appr.commentHint", {
            n: String(MANAGER_COMMENT_MIN_LENGTH),
          })}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      {submit.userMessage === null ? null : (
        <div className="mt-2">
          <Notice tone="error">{submit.userMessage}</Notice>
        </div>
      )}
      {share.userMessage === null ? null : (
        <div className="mt-2">
          <Notice tone="error">{share.userMessage}</Notice>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {submitted ? (
          <Button
            size="sm"
            disabled={share.isPending || appraisal.shared_at !== null}
            onClick={() =>
              share.mutate({
                input: { appraisalId: appraisal.id },
                reason: "performance review: share the completed review with the employee",
              })
            }
          >
            <Share2 className="mr-2 size-4" aria-hidden />
            {appraisal.shared_at === null
              ? t("teamExtra.appr.share")
              : t("teamExtra.appr.sharedAt", { at: fmtDateTime(appraisal.shared_at) })}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={blockers.length > 0 || submit.isPending}
            title={blockers.length > 0 ? t("teamExtra.appr.blocked") : undefined}
            onClick={() => {
              if (overall === null) return;
              submit.mutate({
                input: { appraisalId: appraisal.id, comment, overallRating: overall },
                reason: "performance review: submit the completed review",
              });
            }}
          >
            <Send className="mr-2 size-4" aria-hidden />
            {submit.isPending ? t("teamExtra.appr.submitting") : t("teamExtra.appr.submit")}
          </Button>
        )}
      </div>

      {blockers.length > 0 && !submitted ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("teamExtra.appr.blocked")}</p>
      ) : null}
    </div>
  );
}
