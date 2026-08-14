/**
 * /me/performance — your own review, once your manager has shared it.
 *
 * ── WHY THIS SCREEN CAN SHOW NOTHING FOR WEEKS ──────────────────────────────
 *
 * An appraisal exists from the moment a cycle opens, and this screen will not
 * show it until it has been SHARED. That is not a rendering choice: the policy
 * `appr__self_select` is `employee_id = me AND shared_at IS NOT NULL`, so an
 * unshared review is not returned to this session at all.
 *
 * The reason is worth stating where somebody will read it. A manager's working
 * draft is not a verdict, and a rating glimpsed halfway through a cycle is read
 * as one — after which no amount of "it wasn't final" undoes the conversation
 * that follows. So the screen says plainly that a review may exist and not be
 * visible yet, rather than implying nobody has written one.
 *
 * ── ACKNOWLEDGING IS NOT AGREEING ───────────────────────────────────────────
 *
 * The button says "I have read this", and the note beside it is the employee's
 * own words on the record. A system that made acknowledgement look like consent
 * would make the record worse, not better: the one thing an employee can be sure
 * of is that they read it.
 *
 * @route /me/performance
 */
import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { Notice } from "@/features/admin/components/Notice";
import { confirmSubmitted } from "@/shared/ui/confirmSubmitted";
import { fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { RATING_MAX, type Appraisal } from "../api/appraisals.api";
import {
  useAcknowledgeAppraisal,
  useAppraisalRatings,
  useMyAppraisals,
} from "../hooks/useAppraisals";

export default function MyPerformancePage() {
  const mine = useMyAppraisals();
  const rows = mine.data ?? [];

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title={t("me.perf.title")}
        subtitle={t("me.perf.subtitle")}
      />

      <StateBoundary
        loading={mine.isLoading}
        error={mine.error ?? undefined}
        onRetry={() => void mine.refetch()}
        isEmpty={mine.data !== undefined && rows.length === 0}
        empty={
          <EmptyState
            icon={ClipboardList}
            title={t("me.perf.empty.title")}
            hint={t("me.perf.empty.hint")}
          />
        }
        skeletonRows={3}
      >
        <div className="space-y-4">
          {rows.map((a) => (
            <AppraisalCard key={a.id} appraisal={a} />
          ))}
        </div>
      </StateBoundary>

      <div className="mt-4">
        <Notice tone="note">{t("me.perf.whenVisible")}</Notice>
      </div>
    </div>
  );
}

function AppraisalCard({ appraisal }: { readonly appraisal: Appraisal }) {
  const ratings = useAppraisalRatings(appraisal.id);
  const ack = useAcknowledgeAppraisal();
  const [note, setNote] = useState("");

  const acknowledged = appraisal.employee_ack_at !== null;

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-display text-lg font-semibold">
            {t("me.perf.overall", {
              n: dash(appraisal.overall_rating),
              max: String(RATING_MAX),
            })}
          </p>
          {appraisal.shared_at === null ? null : (
            <p className="text-xs text-muted-foreground">
              {t("me.perf.sharedAt", { at: fmtDateTime(appraisal.shared_at) })}
            </p>
          )}
        </div>
      </div>

      {appraisal.manager_comment === null ? null : (
        <div className="mt-3 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("me.perf.managerWords")}
          </p>
          <p className="mt-1 whitespace-pre-line text-sm">{appraisal.manager_comment}</p>
        </div>
      )}

      <StateBoundary
        loading={ratings.isLoading}
        error={ratings.error ?? undefined}
        onRetry={() => void ratings.refetch()}
        skeletonRows={2}
      >
        <ul className="mt-3 space-y-1.5">
          {(ratings.data ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{r.label}</span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{t("me.perf.youSaid", { n: dash(r.self_rating) })}</span>
                <span className="num font-medium text-foreground">
                  {t("me.perf.theySaid", { n: dash(r.manager_rating) })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </StateBoundary>

      {acknowledged ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t("me.perf.acknowledgedAt", { at: fmtDateTime(appraisal.employee_ack_at ?? "") })}
        </p>
      ) : (
        <div className="mt-4 border-t pt-3">
          <label htmlFor={`ack-${appraisal.id}`} className="text-sm font-medium">
            {t("me.perf.ackLabel")}
          </label>
          {/* Reading is not agreeing, and the wording is careful about that. */}
          <p className="mt-0.5 text-xs text-muted-foreground">{t("me.perf.ackHint")}</p>
          <textarea
            id={`ack-${appraisal.id}`}
            rows={2}
            maxLength={2000}
            className="mt-1.5 w-full rounded-md border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {ack.userMessage === null ? null : (
            <div className="mt-2">
              <Notice tone="error">{ack.userMessage}</Notice>
            </div>
          )}
          <Button
            className="mt-3"
            size="sm"
            disabled={ack.isPending}
            onClick={() =>
              ack.mutate(
                {
                  input: { appraisalId: appraisal.id, note },
                  reason: "my review: record that I have read it",
                },
                {
                  onSuccess: () => {
                    confirmSubmitted(t("me.perf.ackDone"), {
                      detail: t("me.perf.ackDoneDetail"),
                    });
                  },
                },
              )
            }
          >
            {ack.isPending ? t("me.perf.acking") : t("me.perf.ack")}
          </Button>
        </div>
      )}
    </section>
  );
}
