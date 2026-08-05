/**
 * /me/ask — TTHR Assistant, powered by Regal Lab.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THE BACKEND WAS ALREADY HERE
 *
 * `supabase/functions/ai-agent` has been deployed and keyed for days — 3,600 lines that
 * resolve the caller's scope in SQL, run a fixed set of vetted tools, validate the model's
 * output against fourteen deterministic checks, recompute every displayed figure from the
 * tool results it cited, and bill tokens into `ai_usage_ledger`. It had no screen, so none
 * of it was reachable. This page is that screen and nothing more: it renders what the
 * function returns and computes none of it.
 *
 * WHAT A READER GETS
 *
 *  · a narrative answer, in the function's own words;
 *  · up to eight infographic blocks — KPI rows, line and bar charts, donuts, tables,
 *    timelines, progress bars, gauges — drawn in the product's own validated palette;
 *  · the PROVENANCE of every block: which tool, how many rows, whether it was truncated;
 *  · the caveats the function attached, which are part of the answer, not decoration;
 *  · suggested follow-ups, which are just questions — clicking one asks it;
 *  · Excel and PDF of any table block, through the same report writer the analytics
 *    screens use, so an exported figure is formatted identically to the on-screen one.
 *
 * WHAT IT REFUSES TO DO
 *
 *  · It does not format a number. Every figure is the server's `display` string.
 *  · It does not restore a thread across reloads. The server owns the conversation; a
 *    thread rebuilt from local storage could show a turn the server no longer stands
 *    behind, and answers about salary are not something to resurrect from a cache.
 *  · It does not hide the cost. When the function reports one, it is shown.
 *
 * @route /me/ask
 */
import { useMemo, useState, type FormEvent } from "react";
import { Loader2, MessagesSquare, Mic, MicOff, RotateCcw, Send, Sparkles, Volume2, VolumeX } from "lucide-react";
import { Link } from "react-router-dom";
import { useVoiceInput, useVoiceOutput } from "../hooks/useVoice";
import { RichText } from "../components/RichText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { t } from "@/shared/i18n/en";
import { istToday } from "@/lib/datetime";
import { exportReport, type ExportColumn, type ExportFormat } from "@/lib/exportReport";
import { defaultFilters } from "@/lib/analyticsFilters";
import { SpecBlockView } from "../components/SpecBlocks";
import { useAskAgent, type AskTurn } from "../hooks/useAskAgent";
import type { AskResponse, SpecBlock } from "../api/aiAgent.api";

/** Openers, so nobody has to guess what it can answer. */
const SUGGESTIONS: readonly string[] = [
  "How many days did I work this month?",
  "Show my attendance trend over the last three months",
  "What is my leave balance, and what expires soon?",
  "Was I late at any point this month?",
];

/** A table block is the only shape with rows worth exporting. */
function exportableTables(spec: AskResponse["spec"]): SpecBlock[] {
  return spec.blocks.filter((b) => b.type === "table" && b.table != null && b.table.rows.length > 0);
}

/**
 * Export one table block.
 *
 * Cells are already the server's formatted strings, so every column is declared as
 * `text`: re-parsing "₹12,340" back to a number so the writer could format it again is
 * exactly the double-formatting this page exists to avoid. The writer's own heading block
 * still records the question, the period and the generation time.
 */
async function downloadTable(
  block: SpecBlock,
  question: string,
  format: ExportFormat,
): Promise<void> {
  const table = block.table;
  if (!table) return;
  type Row = Record<string, string>;
  const rows: Row[] = table.rows.map((cells) => {
    const row: Row = {};
    table.columns.forEach((col, i) => {
      const cell = cells[i];
      row[col.key] = cell === null || cell === undefined ? "" : String(cell);
    });
    return row;
  });
  const columns: ExportColumn<Row>[] = table.columns.map((col) => ({
    key: col.key,
    header: col.label,
    format: "text",
  }));
  await exportReport<Row>({
    title: block.title !== "" ? block.title : t("ai.export.title"),
    subtitle: question,
    columns,
    rows,
    format,
    filename: block.title !== "" ? block.title : "regal-lab-answer",
    // The assistant answers about the signed-in person over a period it chose itself,
    // so there is no filter bar behind this. `defaultFilters` gives the writer a
    // well-formed period for its heading rather than a fabricated narrowing.
    filters: defaultFilters(),
  });
}

function Turn({ turn }: { turn: AskTurn }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  // Per-turn, so pressing "read this" on one answer stops the other: the hook cancels
  // any utterance in flight, which is what somebody means by it.
  const speech = useVoiceOutput();
  const tables = useMemo(
    () => (turn.answer === null ? [] : exportableTables(turn.answer.spec)),
    [turn.answer],
  );

  return (
    <article className="space-y-3">
      {/* The question, echoed — so a long thread stays readable. */}
      <div className="flex justify-end">
        <p className="max-w-[46rem] rounded-lg rounded-br-sm bg-secondary px-3.5 py-2 text-sm">
          {turn.question}
        </p>
      </div>

      {turn.error !== null ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {turn.error}
        </div>
      ) : null}

      {turn.answer !== null ? (
        <div className="space-y-3">
          {/* The narrative is markdown-lite by contract; rendering it as plain text put
              literal ** around every emphasised figure. RichText parses three inline forms
              and nothing else, into elements rather than HTML. */}
          {turn.answer.spec.narrative !== "" ? (
            <RichText
              text={turn.answer.spec.narrative}
              className="max-w-[52rem] text-sm leading-relaxed"
            />
          ) : null}

          {turn.answer.spec.blocks.map((block, i) => (
            <SpecBlockView key={`${block.type}-${i}`} block={block} />
          ))}

          {/* Caveats are part of the answer. They sit BELOW the figures, where somebody
              who has just read a number will see them, not above where they are skipped. */}
          {turn.answer.spec.caveats.length > 0 ? (
            <ul className="space-y-1 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed">
              {turn.answer.spec.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          ) : null}

          {/*
            READ IT ALOUD. Only the narrative is spoken — a synthesiser reading a
            fifteen-row roster is unusable, and the narrative is the part written as
            sentences. It is on the device, so nothing is sent anywhere, unlike
            dictation on Chromium.
          */}
          {speech.supported && turn.answer.spec.narrative.trim() !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                speech.speaking ? speech.stop() : speech.speak(turn.answer?.spec.narrative ?? "")}
              aria-pressed={speech.speaking}
            >
              {speech.speaking ? (
                <VolumeX className="mr-2 size-4" aria-hidden />
              ) : (
                <Volume2 className="mr-2 size-4" aria-hidden />
              )}
              {speech.speaking ? t("ai.voice.stopReading") : t("ai.voice.readAloud")}
            </Button>
          ) : null}

          {tables.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {(["csv", "pdf"] as const).map((format) => (
                <Button
                  key={format}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(format);
                    void Promise.all(
                      tables.map((block) => downloadTable(block, turn.question, format)),
                    ).finally(() => setBusy(null));
                  }}
                >
                  {busy === format ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  {format === "csv" ? t("ai.export.excel") : t("ai.export.pdf")}
                </Button>
              ))}
            </div>
          ) : null}

          {/*
            NO PER-ANSWER COST. It used to print "This answer cost ₹8.45" under
            every reply. Spend is somebody else's job — HR reading their own
            attendance has no decision to make with that number, and pricing a
            question in front of the person asking it discourages them from
            asking. The figure is still recorded: `ai_usage_ledger` keeps every
            paisa and the admin sees the monthly total on AI Configuration and
            Analytics · AI, which is where a budget is actually managed.
          */}
        </div>
      ) : null}
    </article>
  );
}

export default function AskPage() {
  const { turns, isAsking, pending, ask, reset } = useAskAgent();
  const [draft, setDraft] = useState("");

  /*
    Dictated text is APPENDED to whatever is already in the box, not substituted for it.
    Somebody who typed half a question and then reached for the microphone means "and
    also this"; replacing their typing would silently destroy it.
  */
  const voice = useVoiceInput((text) =>
    setDraft((prev) => (prev.trim() === "" ? text : `${prev.trim()} ${text}`)),
  );
  const [mode, setMode] = useState<"panel" | "analyst">("panel");

  function submit(event: FormEvent) {
    event.preventDefault();
    ask(draft, mode);
    setDraft("");
  }

  return (
    <div className="container py-6">
      <PageHeader
        icon={Sparkles}
        title={t("ai.title")}
        // The attribution rides on the subtitle rather than the title: "TTHR Assistant" is
        // what people will call it, and a title carrying its vendor is a title nobody says
        // out loud. It stays on screen either way.
        subtitle={`${t("ai.poweredBy")} · ${t("ai.subtitle")}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              ALWAYS PRESENT, not only when there are turns. Past conversations are
              exactly what somebody wants when this screen is EMPTY — they came back to
              re-read an answer, and a link that appears only after you ask something new
              is the one place it is no use. The command palette also finds it, but
              nobody searches for a screen they do not know exists.
            */}
            <Button asChild variant="ghost" size="sm">
              <Link to="/me/ask/history">
                <MessagesSquare className="mr-2 size-4" aria-hidden />
                {t("ai.history.link")}
              </Link>
            </Button>
            {turns.length > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={reset}>
                <RotateCcw className="mr-2 size-4" aria-hidden />
                {t("ai.newThread")}
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mx-auto max-w-4xl space-y-6">
        {turns.length === 0 && pending === null ? (
          <EmptyState
            icon={Sparkles}
            title={t("ai.empty.title")}
            hint={t("ai.empty.hint")}
          />
        ) : null}

        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}

        {pending !== null ? (
          <article className="space-y-3">
            <div className="flex justify-end">
              <p className="max-w-[46rem] rounded-lg rounded-br-sm bg-secondary px-3.5 py-2 text-sm">
                {pending}
              </p>
            </div>
            {/*
              An answer takes 15–25 seconds because the function may run several tool
              round-trips before it says anything. Naming the stage beats a bare spinner:
              a reader who knows it is reading their attendance will wait, and one who
              thinks it has hung will press the button again and spend tokens twice.
            */}
            <div className="flex items-center gap-2.5 rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("ai.thinking")}
            </div>
          </article>
        ) : null}

        {turns.length === 0 && pending === null ? (
          <div className="flex flex-wrap gap-2">
            {/* `text-left`: these labels are whole questions, and a wrapped question reads
                better left-aligned than centred. Wrapping itself is the Button base's job. */}
            {SUGGESTIONS.map((s) => (
              <Button
                key={s}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => ask(s, mode)}
                disabled={isAsking}
                className="text-left"
              >
                {s}
              </Button>
            ))}
          </div>
        ) : null}

        {/* Follow-ups from the LAST answer only: the model suggests them in the context of
            what it just said, and offering an older turn's follow-ups would ask a question
            about figures that have scrolled away. */}
        {(() => {
          const last = turns[turns.length - 1];
          const followups = last?.answer?.spec.followups ?? [];
          if (followups.length === 0 || isAsking) return null;
          return (
            <div className="flex flex-wrap gap-2">
              {followups.map((f) => (
                <Button key={f} type="button" variant="outline" size="sm" onClick={() => ask(f, mode)}>
                  {f}
                </Button>
              ))}
            </div>
          );
        })()}

        {/* Same home-indicator clearance as the admin action bar: the composer is the one
            control on this page and it sat in the swipe area on an iPhone. */}
        <form onSubmit={submit} className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] flex gap-2 rounded-lg border bg-card p-2 shadow-sm">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("ai.placeholder")}
            aria-label={t("ai.placeholder")}
            maxLength={2_000}
            disabled={isAsking}
          />
          {/*
            DICTATION FILLS THE BOX, IT DOES NOT SEND. Recognition mishears exactly the
            words these questions are made of — Aadhaar, lakh, names — so a question sent
            unread costs a wrong answer. Hidden entirely where the browser has no
            SpeechRecognition (Firefox) rather than failing on click.
          */}
          {voice.supported ? (
            <span className="relative inline-flex shrink-0">
              {/*
                THE PULSE IS THE MICROPHONE'S ACTUAL LEVEL, not a keyframe animation. Two
                rings scale with `voice.level`, which a WebAudio analyser measures from the
                live stream — so it moves when somebody speaks, and stays still when the
                microphone is hearing nothing. That second case is the useful one: a decorative
                pulse would keep throbbing at a muted microphone and tell the reader their
                question was being heard when it was not.

                The outer ring lags the inner one and fades as it grows, which is what reads
                as a pulse spreading outward rather than a circle changing size.
              */}
              {voice.listening ? (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-md bg-primary/30 transition-transform duration-100 ease-out motion-reduce:hidden"
                    style={{ transform: `scale(${1 + voice.level * 0.9})`, opacity: 0.55 - voice.level * 0.35 }}
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-md bg-primary/40 transition-transform duration-75 ease-out motion-reduce:hidden"
                    style={{ transform: `scale(${1 + voice.level * 0.45})` }}
                  />
                </>
              ) : null}
              <Button
                type="button"
                size="sm"
                className="relative"
                variant={voice.listening ? "default" : "outline"}
                disabled={isAsking}
                onClick={() => {
                  // `start` is async — it asks the browser for the microphone before it
                  // begins listening, which is what raises the permission dialog.
                  if (voice.listening) voice.stop();
                  else void voice.start();
                }}
                aria-pressed={voice.listening}
                title={voice.isCloudRecognition ? t("ai.voice.cloudHint") : t("ai.voice.localHint")}
              >
                {voice.listening ? (
                  <MicOff className="size-4" aria-hidden />
                ) : (
                  <Mic className="size-4" aria-hidden />
                )}
                <span className="sr-only">
                  {voice.listening ? t("ai.voice.stop") : t("ai.voice.start")}
                </span>
              </Button>
            </span>
          ) : null}
          <Button
            type="button"
            variant={mode === "analyst" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode(mode === "analyst" ? "panel" : "analyst")}
            title={t("ai.mode.hint")}
          >
            {mode === "analyst" ? t("ai.mode.analyst") : t("ai.mode.panel")}
          </Button>
          <Button type="submit" size="sm" disabled={isAsking || draft.trim().length < 2}>
            {isAsking ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
            <span className="sr-only">{t("ai.send")}</span>
          </Button>
        </form>

        {/* The microphone's own state, under the composer where it is being used.
            `listening` is said out loud too: a person who cannot see the button change
            colour has no other signal that the microphone is open. */}
        {voice.error !== null ? (
          <p className="text-center text-xs text-destructive" role="status">{voice.error}</p>
        ) : voice.listening ? (
          <p className="text-center text-xs text-primary" role="status">
            {/*
              `level === 0` while listening is not nothing to say: the microphone is open and
              picking up silence, which is exactly the state somebody needs told about when
              it is muted at the operating system or they are too far away from it.
            */}
            {voice.level === 0 ? t("ai.voice.listeningSilent") : t("ai.voice.listening")}
          </p>
        ) : null}

        <p className="text-center text-xs text-muted-foreground/70">
          {t("ai.scopeNote", { today: istToday() })}
        </p>
      </div>
    </div>
  );
}
