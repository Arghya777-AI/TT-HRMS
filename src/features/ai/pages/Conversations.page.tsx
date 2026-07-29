/**
 * §·/me/ask/history — the conversations you have had with the assistant.
 *
 * WHY IT EXISTS. Every turn has been recorded in `ai_conversations` / `ai_messages`
 * since the assistant shipped, and there was no way to look at any of it. Ask a
 * question, close the tab, and the answer was gone — which also meant nobody could
 * check what they had been told last month, and "the assistant said I had nine days"
 * was unfalsifiable.
 *
 * ONE PANE, NOT TWO. A master/detail split looks like the obvious shape and is the
 * wrong one on a phone, which is where most people will read this: it either hides
 * the list or hides the transcript. Rows expand in place instead, so the list is
 * never lost and the transcript is never behind a back button.
 *
 * THE TRANSCRIPT IS LOADED ON OPEN, not with the list. A hundred conversations of
 * twenty turns is two thousand rows nobody asked for; the list is a list.
 *
 * DOWNLOAD USES THE SAME BRANDED WRITER as every other export in the product
 * (`exportReport`), so a conversation saved for a dispute looks like a company
 * document and carries the generation time. Both formats are offered because they
 * answer different needs: Excel for someone assembling evidence across several
 * conversations, PDF for someone attaching one to an email.
 *
 * ARCHIVING IS NOT DELETING, and the copy says so. `ai_messages` is the record of
 * what the assistant was asked and answered; an audit trail a person can erase is
 * not an audit trail. Archiving takes it off their list and out of the continue-this
 * lookup, and leaves it recorded.
 *
 * @route /me/ask/history
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessagesSquare,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { shouldRetryQuery } from "@/shared/api/query";
import { exportReport, type ExportColumn, type ExportFormat } from "@/lib/exportReport";
import { asArray } from "@/lib/asArray";
import { fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { defaultFilters } from "@/lib/analyticsFilters";
import {
  fetchMyConversations,
  fetchTranscript,
  setConversationArchived,
  type Conversation,
  type TranscriptMessage,
} from "../api/conversations.api";
import { RichText } from "../components/RichText";

const LIST_KEY = ["ai", "conversations"] as const;

/** The title the DB stored, or a fallback — never an empty heading. */
function titleOf(c: Conversation): string {
  const title = (c.title ?? "").trim();
  return title === "" ? t("ai.history.untitled") : title;
}

async function downloadTranscript(
  conversation: Conversation,
  messages: readonly TranscriptMessage[],
  format: ExportFormat,
): Promise<void> {
  type Row = { when: string; who: string; said: string };
  const rows: Row[] = messages.map((m) => ({
    when: fmtDateTime(m.recorded_at),
    who: m.role === "user" ? t("ai.history.you") : t("ai.history.assistant"),
    said: m.content ?? "",
  }));
  const columns: ExportColumn<Row>[] = [
    { key: "when", header: t("ai.history.col.when"), format: "text" },
    { key: "who", header: t("ai.history.col.who"), format: "text" },
    { key: "said", header: t("ai.history.col.said"), format: "text" },
  ];
  await exportReport<Row>({
    title: t("ai.history.export.title"),
    subtitle: titleOf(conversation),
    columns,
    rows,
    format,
    filename: `conversation-${conversation.id.slice(0, 8)}`,
    // A conversation is not the result of a filter bar. `defaultFilters()` gives the
    // writer a well-formed period for its heading instead of a fabricated narrowing —
    // the same reason the answer export passes it.
    filters: defaultFilters(),
  });
}

function TranscriptView({ conversation }: { conversation: Conversation }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const transcript = useQuery({
    queryKey: ["ai", "transcript", conversation.id],
    queryFn: ({ signal }) => fetchTranscript(conversation.id, signal),
    retry: shouldRetryQuery,
  });

  return (
    <StateBoundary
      loading={transcript.isPending}
      error={transcript.error}
      onRetry={() => void transcript.refetch()}
      skeletonRows={3}
    >
      <div className="space-y-3 border-t px-4 py-4">
        {(transcript.data?.messages ?? []).map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[46rem] rounded-lg px-3 py-2 text-sm",
              m.role === "user"
                ? "ml-auto bg-primary/10"
                : "bg-muted/60",
            )}
          >
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {m.role === "user" ? t("ai.history.you") : t("ai.history.assistant")}
              {" · "}
              {fmtDateTime(m.recorded_at)}
            </p>
            {/* Same renderer as the live answer, so a conversation read back looks like the
                conversation as it happened. RichText produces elements, not HTML, so there
                is no second injection surface — which was the reason this was plain text. */}
            <RichText text={m.content ?? ""} />
          </div>
        ))}

        {/* A transcript that is missing something must say so. Silence would read as
            "this is everything". */}
        {(transcript.data?.redactedCount ?? 0) > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("ai.history.redacted", {
              n: formatNumber(transcript.data?.redactedCount ?? 0),
            })}
          </p>
        ) : null}

        {(transcript.data?.messages.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ai.history.emptyTranscript")}</p>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {(["csv", "pdf"] as const).map((format) => (
              <Button
                key={format}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(format);
                  void downloadTranscript(conversation, transcript.data?.messages ?? [], format)
                    .finally(() => setBusy(null));
                }}
              >
                {busy === format ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                {format === "csv" ? t("ai.export.excel") : t("ai.export.pdf")}
              </Button>
            ))}
          </div>
        )}
      </div>
    </StateBoundary>
  );
}

function ConversationRow({ conversation }: { conversation: Conversation }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archive = useMutation({
    mutationFn: () => setConversationArchived(conversation.id, !conversation.is_archived),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: LIST_KEY });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start gap-2 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{titleOf(conversation)}</span>
            <span className="block text-xs text-muted-foreground">
              {t("ai.history.meta", {
                turns: formatNumber(conversation.message_count),
                when: fmtDateTime(conversation.last_message_at ?? conversation.started_at),
              })}
              {conversation.is_archived ? ` · ${t("ai.history.archived")}` : ""}
            </span>
          </span>
        </button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={archive.isPending}
          onClick={() => archive.mutate()}
          aria-label={conversation.is_archived
            ? t("ai.history.restoreAria", { name: titleOf(conversation) })
            : t("ai.history.archiveAria", { name: titleOf(conversation) })}
        >
          {conversation.is_archived ? (
            <ArchiveRestore className="size-4" aria-hidden />
          ) : (
            <Archive className="size-4" aria-hidden />
          )}
        </Button>
      </div>

      {error !== null ? (
        <p className="px-4 pb-2 text-xs text-destructive">{error}</p>
      ) : null}

      {open ? <TranscriptView conversation={conversation} /> : null}
    </li>
  );
}

export default function ConversationsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const list = useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) => fetchMyConversations(signal),
    retry: shouldRetryQuery,
  });

  const all = asArray(list.data);
  const rows = showArchived ? all : all.filter((c) => !c.is_archived);
  const archivedCount = all.filter((c) => c.is_archived).length;

  return (
    <div className="container py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold">
            <MessagesSquare className="size-5 text-muted-foreground" aria-hidden />
            {t("ai.history.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("ai.history.subtitle")}</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/me/ask">
            <Sparkles className="mr-2 size-4" aria-hidden />
            {t("ai.history.askNew")}
          </Link>
        </Button>
      </div>

      {archivedCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-3"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived
            ? t("ai.history.hideArchived")
            : t("ai.history.showArchived", { n: formatNumber(archivedCount) })}
        </Button>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          isEmpty={!list.isPending && list.error === null && rows.length === 0}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title={t("ai.history.empty.title")}
              hint={t("ai.history.empty.hint")}
            />
          }
          skeletonRows={5}
        >
          <ul className="space-y-2">
            {rows.map((c) => <ConversationRow key={c.id} conversation={c} />)}
          </ul>
        </StateBoundary>
      </div>
    </div>
  );
}
