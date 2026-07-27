/**
 * §14 · /admin/analytics/ai — AI Usage Analytics. Questions, cost, latency and
 * refusals.
 *
 * The LEDGER exists; the AGGREGATE does not. Migration 030 deploys
 * `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_usage_ledger` and
 * `ai_feedback`, all admin-readable under RLS and all append-only. Between them
 * they carry every input this screen needs — per-message `latency_ms` and
 * `stop_reason`, per-call token counts, `total_cost_usd` / `total_cost_inr`,
 * `billing_month`, and tool-scope denials as first-class rows.
 *
 * What is missing is the one thing that would let this screen be honest: a view
 * that AGGREGATES them. There is no `v_ai_usage_*` relation. Every figure this
 * screen is supposed to show — spend per month, median latency, refusal rate,
 * questions per employee — is a SUM, a PERCENTILE or a RATIO over the ledger, and
 * computing any of those in the browser is exactly the client-side business
 * arithmetic the build forbids. Two further reasons it must be server-side:
 *
 *   * `total_cost_inr` is `numeric(14,4)`, not integer paise. Adding floating
 *     currency in JavaScript and calling it a monthly bill is how a rounding
 *     defect becomes an invoice dispute.
 *   * a browser-side sum would be a sum over the ROWS THAT LOADED — capped at
 *     whatever limit the read used — and would silently under-report spend the
 *     moment usage outgrew one page.
 *
 * So this screen names the missing relation and stops. Budget, model and scope
 * are configured (and enforced) at /admin/settings/ai; that link is here because
 * it is the useful thing an administrator can actually do from this page today.
 *
 * @route /admin/analytics/ai
 */
import { Link } from "react-router-dom";
import { Sparkles, Cog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { t, type MessageKey } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";

const STATE_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  raw: { label: t("admin.aiuse.state.raw"), tone: "info" },
  missing: { label: t("admin.aiuse.state.missing"), tone: "warn" },
};

interface FigureRow {
  readonly id: string;
  readonly nameKey: MessageKey;
  /** The columns that WOULD feed it — named so the gap is actionable. */
  readonly inputs: string;
  readonly state: "raw" | "missing";
  readonly whyKey: MessageKey;
}

const FIGURES: readonly FigureRow[] = [
  {
    id: "spend",
    nameKey: "admin.aiuse.fig.spend.name",
    inputs: "ai_usage_ledger.total_cost_inr, billing_month",
    state: "missing",
    whyKey: "admin.aiuse.fig.spend.why",
  },
  {
    id: "tokens",
    nameKey: "admin.aiuse.fig.tokens.name",
    inputs: "ai_usage_ledger.input_tokens, output_tokens, cache_read_tokens",
    state: "missing",
    whyKey: "admin.aiuse.fig.tokens.why",
  },
  {
    id: "latency",
    nameKey: "admin.aiuse.fig.latency.name",
    inputs: "ai_messages.latency_ms",
    state: "missing",
    whyKey: "admin.aiuse.fig.latency.why",
  },
  {
    id: "refusals",
    nameKey: "admin.aiuse.fig.refusals.name",
    inputs: "ai_messages.stop_reason, ai_tool_calls (scope denials)",
    state: "missing",
    whyKey: "admin.aiuse.fig.refusals.why",
  },
  {
    id: "questions",
    nameKey: "admin.aiuse.fig.questions.name",
    inputs: "ai_conversations, ai_messages.role",
    state: "raw",
    whyKey: "admin.aiuse.fig.questions.why",
  },
  {
    id: "feedback",
    nameKey: "admin.aiuse.fig.feedback.name",
    inputs: "ai_feedback",
    state: "raw",
    whyKey: "admin.aiuse.fig.feedback.why",
  },
];

export default function AnalyticsAiPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={Sparkles}
        title={t("admin.aiuse.title")}
        subtitle={t("admin.aiuse.subtitle")}
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/settings/ai">
              <Cog className="mr-2 size-4" aria-hidden />
              {t("admin.aiuse.toConfig")}
            </Link>
          </Button>
        }
      />

      <div className="mt-4">
        <EmptyState
          icon={Sparkles}
          title={t("admin.aiuse.empty.title")}
          hint={t("admin.aiuse.empty.hint")}
          action={
            <Button variant="outline" asChild>
              <Link to="/admin/analytics/metrics">{t("admin.aiuse.toDictionary")}</Link>
            </Button>
          }
        />
      </div>

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold">{t("admin.aiuse.figures.heading")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.aiuse.figures.hint")}</p>
        <div className="mt-2 overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[13rem]">{t("admin.aiuse.col.figure")}</TableHead>
                <TableHead className="w-[9rem]">{t("admin.aiuse.col.state")}</TableHead>
                <TableHead className="w-[20rem]">{t("admin.aiuse.col.inputs")}</TableHead>
                <TableHead>{t("admin.aiuse.col.why")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {FIGURES.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="align-top font-medium">{t(row.nameKey)}</TableCell>
                  <TableCell className="align-top">
                    <StatusChip status={row.state} map={STATE_CHIP} />
                  </TableCell>
                  <TableCell className="align-top">
                    <code className="num break-words text-xs">{row.inputs}</code>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {t(row.whyKey)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="mt-6 space-y-2">
        <Notice tone="warning">{t("admin.aiuse.note.noView")}</Notice>
        <Notice tone="info">{t("admin.aiuse.note.currency")}</Notice>
        <Notice tone="info">{t("admin.aiuse.note.privacy")}</Notice>
      </div>
    </div>
  );
}
