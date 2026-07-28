/**
 * E-13 · /me/policies/:slug — the reader, with the acknowledgement gate.
 *
 * The gate is the point of this screen. The checkbox is disabled until BOTH
 * conditions hold, and both numbers come from the database's own trigger
 * (`document_acknowledgements_ack_guard`, migration 025), not from a constant
 * invented here:
 *
 *   max scroll ≥ 90%   AND   time on page ≥ ceil(page_count × 8) seconds
 *
 * `max_scroll_percent` is a HIGH-WATER MARK: scrolling back up does not lower it,
 * because you cannot un-read a page. Dwell time only accrues while the tab is
 * actually visible — leaving the tab open in the background is not reading.
 *
 * The body text is not rendered because it does not exist as text: a policy is a
 * file in a private bucket, and the signed URL must be minted by the
 * `document-access` edge function (which writes the access log first). That
 * function is not deployed, so the reader shows every server-held fact about the
 * policy and says plainly why the file itself is not on screen.
 *
 * `:slug` is the `documents.id`. There is no `slug` column on the deployed table,
 * and minting one in the browser would make the URL unresolvable server-side.
 *
 * @route /me/policies/:slug
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileWarning, Info, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACK_SCROLL_GATE_PCT, ackDwellSeconds } from "../api/policies.api";
import { useAcknowledgePolicy, usePolicyDetail } from "../hooks/usePolicies";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seconds the tab has been visible since mount. Ticks once a second. */
function useVisibleDwellSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        setSeconds((s) => s + 1);
      }
    }, 1000);
    return () => window.clearInterval(handle);
  }, []);
  return seconds;
}

/**
 * High-water scroll depth of a scrollable element, 0–100.
 *
 * Content shorter than its container is 100% by definition — everything is
 * already on screen, so there is nothing left to scroll to.
 */
function useMaxScrollPercent() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pct, setPct] = useState(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    const next =
      scrollable <= 1 ? 100 : ((el.scrollTop + el.clientHeight) / el.scrollHeight) * 100;
    setPct((prev) => Math.min(100, Math.max(prev, Math.round(next))));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return { ref, pct, onScroll: measure };
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="num mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export default function PolicyReaderPage() {
  const { slug } = useParams<{ slug: string }>();
  const documentId = slug !== undefined && UUID_RE.test(slug) ? slug : null;

  const detail = usePolicyDetail(documentId);
  const acknowledge = useAcknowledgePolicy();

  const dwellSeconds = useVisibleDwellSeconds();
  const { ref, pct, onScroll } = useMaxScrollPercent();
  const [agreed, setAgreed] = useState(false);

  const doc = detail.data?.document ?? null;
  const ack = detail.data?.ack ?? null;
  const pageCount = doc?.page_count ?? ack?.documents?.page_count ?? null;
  const gateSeconds = useMemo(() => ackDwellSeconds(pageCount), [pageCount]);

  const scrollMet = pct >= ACK_SCROLL_GATE_PCT;
  const dwellMet = dwellSeconds >= gateSeconds;
  const gateMet = scrollMet && dwellMet;
  const alreadyAcked = ack?.acknowledged_at !== null && ack !== null;
  const ackText = t("policies.reader.ack");

  function onAcknowledge() {
    if (ack === null || !gateMet || !agreed) return;
    acknowledge.mutate(
      { ackId: ack.id, scrollPct: pct, readSeconds: dwellSeconds, text: ackText },
      {
        onSuccess: () => toast.success(t("policies.reader.ackDone")),
        onError: (error) =>
          toast.error(t("policies.reader.ackFailed"), {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  }

  const title = doc?.title ?? ack?.documents?.title ?? null;
  const categoryName =
    doc?.document_types?.name ?? ack?.documents?.document_types?.name ?? null;
  const version = doc?.current_version ?? ack?.documents?.current_version ?? null;
  const effectiveFrom = doc?.issue_date ?? ack?.documents?.issue_date ?? null;

  return (
    <div className="container max-w-4xl py-6">
      <PageHeader
        icon={ScrollText}
        title={title ?? t("policies.title.unavailable")}
        {...(categoryName !== null ? { subtitle: categoryName } : {})}
        actions={
          <Button variant="ghost" asChild>
            <Link to="/me/policies">
              <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
              {t("policies.reader.back")}
            </Link>
          </Button>
        }
      />

      <StateBoundary
        loading={detail.isLoading}
        error={detail.error ?? undefined}
        onRetry={() => void detail.refetch()}
        isEmpty={documentId === null || (detail.data !== undefined && doc === null && ack === null)}
        empty={
          <EmptyState
            icon={FileWarning}
            title={t("policies.reader.notFound.title")}
            hint={t("policies.reader.notFound.hint")}
            action={
              <Button asChild>
                <Link to="/me/policies">{t("policies.reader.back")}</Link>
              </Button>
            }
          />
        }
      >
        {/* Sticky reading-progress bar — the tracked number, stated. */}
        <div className="sticky top-0 z-10 -mx-4 mb-4 border-b bg-background/95 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-md sm:border">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className={cn("num", scrollMet ? "text-success" : "text-muted-foreground")}>
              {t("policies.reader.progress", { pct })}
            </span>
            <span className={cn("num", dwellMet ? "text-success" : "text-muted-foreground")}>
              {t("policies.reader.dwell", { seconds: dwellSeconds })}
            </span>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("policies.reader.progressLabel")}
          >
            <div
              className={cn("h-full rounded-full transition-all", scrollMet ? "bg-success" : "bg-primary")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* The reader body: every server-held fact, in a scroll-tracked container. */}
        <div
          ref={ref}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label={t("policies.reader.body")}
          className="max-h-[65vh] overflow-y-auto rounded-lg border bg-card p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
        >
          <h2 className="font-display text-lg font-semibold">{t("policies.reader.summary")}</h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Fact label={t("policies.col.version")} value={dash(version, (v) => `v${v}`)} />
            <Fact
              label={t("policies.col.effective")}
              value={dash(effectiveFrom, fmtCivilDate)}
            />
            <Fact label={t("policies.col.category")} value={dash(categoryName)} />
            <Fact
              label={t("policies.reader.pages")}
              value={dash(pageCount, (n) => String(n))}
            />
            <Fact label={t("policies.col.due")} value={dash(ack?.due_on ?? null, fmtCivilDate)} />
            <Fact
              label={t("policies.reader.assigned")}
              value={dash(ack?.assigned_at ?? null, fmtDateTime)}
            />
          </dl>

          <p className="mt-5 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t("policies.reader.body.unavailable")}
          </p>

          {doc === null && ack !== null ? (
            <p className="mt-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
              {t("policies.reader.documentWithheld")}
            </p>
          ) : null}
        </div>

        {/* The gate. */}
        <section className="mt-4 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="ack-heading">
          <h2 id="ack-heading" className="font-display text-base font-semibold">
            {t("policies.reader.ackHeading")}
          </h2>

          {alreadyAcked ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="success">{t("policies.ack.done")}</Badge>
              <span className="num text-muted-foreground">
                {t("policies.reader.acked", { when: fmtDateTime(ack.acknowledged_at ?? "") })}
              </span>
            </div>
          ) : ack === null ? (
            <p className="mt-3 text-sm text-muted-foreground">{t("policies.reader.noAck")}</p>
          ) : (
            <>
              <p
                className={cn(
                  "mt-3 text-sm",
                  gateMet ? "text-success" : "text-muted-foreground",
                )}
              >
                {gateMet
                  ? t("policies.reader.gateMet")
                  : t("policies.reader.gate", {
                      pct: ACK_SCROLL_GATE_PCT,
                      seconds: gateSeconds,
                    })}
              </p>

              <label
                className={cn(
                  "mt-4 flex items-start gap-2.5 text-sm",
                  !gateMet && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  checked={agreed}
                  disabled={!gateMet}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                />
                <span>{ackText}</span>
              </label>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={!gateMet || !agreed || acknowledge.isPending}
                  onClick={onAcknowledge}
                >
                  {acknowledge.isPending
                    ? t("policies.reader.acking")
                    : t("policies.reader.ackSubmit")}
                </Button>
                {ack.due_on !== null ? (
                  <span className="text-xs text-muted-foreground">
                    {t("policies.reader.due", { date: fmtCivilDate(ack.due_on) })}
                  </span>
                ) : null}
              </div>

              {acknowledge.isError ? (
                <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                  {t("policies.reader.ackFailed")}
                </p>
              ) : null}
            </>
          )}
        </section>
      </StateBoundary>
    </div>
  );
}
