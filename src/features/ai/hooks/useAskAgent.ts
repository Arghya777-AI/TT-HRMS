/**
 * useAskAgent — one question, one answer, and the thread that connects them.
 *
 * THE TURNS ARE HELD IN COMPONENT STATE, not React Query cache. An answer is not a
 * cacheable read of server state: asking the same question twice legitimately costs
 * tokens again and may legitimately differ (the underlying attendance moved). Caching it
 * by question text would show yesterday's figures for today's question, which is the one
 * failure this whole product is built to avoid.
 *
 * The SERVER owns the conversation. `conversation_id` comes back from the first answer and
 * is sent with the next question; ownership and scope are re-checked there every time, so
 * a stolen id buys nothing. The thread on screen is a view of turns this tab has seen — it
 * is not the source of truth, and it is deliberately not restored across reloads.
 */
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ZodError } from "zod";
import { TTApiError } from "@/shared/api/invoke";
import { t } from "@/shared/i18n/en";
import { askAgent, type AskResponse } from "../api/aiAgent.api";

export interface AskTurn {
  /** Stable key for the list; the server's `message_id` once we have one. */
  id: string;
  question: string;
  answer: AskResponse | null;
  /** A caller-safe sentence when the ask failed. */
  error: string | null;
}

export interface AskAgentState {
  turns: readonly AskTurn[];
  isAsking: boolean;
  /** The question currently in flight, so the UI can echo it while waiting. */
  pending: string | null;
  ask: (question: string, mode?: "panel" | "analyst") => void;
  reset: () => void;
}


/**
 * Turn a failure into a sentence a person can act on.
 *
 * THIS EXISTED AS `error.message` AND PUT A ZOD DUMP ON SCREEN. A `ZodError`'s `message`
 * IS the serialised list of issues, so a schema mismatch printed this to the reader:
 *
 *   [ { "code": "invalid_type", "expected": "string", "received": "undefined",
 *       "path": [ "spec", "blocks", 1, "series", 0, "colour" ], "message": "Required" } ]
 *
 * Which tells an employee asking about their attendance precisely nothing, and reads as a
 * broken product rather than a bad answer. The detail is not thrown away — it goes to the
 * console, where the person who can act on it will look.
 *
 * A SERVER REFUSAL KEEPS ITS OWN WORDS. `TTApiError.problem.detail` was written by the
 * side that refused and is more specific than any sentence here.
 */
function explainAskError(error: unknown): string {
  if (error instanceof TTApiError) {
    const detail = error.problem.detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
    return t("ai.error.server");
  }
  if (error instanceof ZodError) {
    // Kept for whoever is debugging; never shown.
    console.error("ai-agent answer failed validation", error.issues);
    return t("ai.error.shape");
  }
  if (error instanceof Error) {
    /*
      A zod error that has been wrapped loses `instanceof` but keeps the dump in its
      message. Anything that looks like a serialised issue list is treated the same way
      rather than pasted on screen — the shape of the string is the giveaway.
    */
    const looksLikeIssueList = /"code"\s*:\s*"invalid_/.test(error.message) ||
      /^\s*\[\s*\{/.test(error.message);
    if (looksLikeIssueList) {
      console.error("ai-agent answer failed validation", error);
      return t("ai.error.shape");
    }
    return error.message;
  }
  return t("ai.error.unknown");
}

export function useAskAgent(): AskAgentState {
  const [turns, setTurns] = useState<readonly AskTurn[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: (input: { question: string; mode: "panel" | "analyst" }) =>
      askAgent({
        message: input.question,
        mode: input.mode,
        ...(conversationId !== undefined ? { conversationId } : {}),
      }),
  });

  const ask = useCallback(
    (question: string, mode: "panel" | "analyst" = "panel") => {
      const trimmed = question.trim();
      // The function's own floor is 2 characters; refusing here saves a round trip and
      // a token spend on something that cannot be a question.
      if (trimmed.length < 2 || mutation.isPending) return;
      setPending(trimmed);
      mutation.mutate(
        { question: trimmed, mode },
        {
          onSuccess: (answer) => {
            setConversationId(answer.conversation_id);
            setTurns((prior) => [
              ...prior,
              { id: answer.message_id, question: trimmed, answer, error: null },
            ]);
            setPending(null);
          },
          onError: (error: unknown) => {
            /*
              The turn is KEPT, with the failure attached. Dropping the question on error
              would leave the reader staring at an empty page wondering whether they had
              pressed anything — and they would ask again, spending tokens twice.
            */
            setTurns((prior) => [
              ...prior,
              {
                id: `err-${prior.length}`,
                question: trimmed,
                answer: null,
                error: explainAskError(error),
              },
            ]);
            setPending(null);
          },
        },
      );
    },
    // `conversationId` is deliberately NOT a dependency: it is read inside `mutationFn`,
    // which closes over the current render's value, not inside `ask`. Listing it would
    // claim a dependency this callback does not have.
    [mutation],
  );

  const reset = useCallback(() => {
    setTurns([]);
    setPending(null);
    // A new thread server-side too: the next ask carries no conversation_id.
    setConversationId(undefined);
  }, []);

  return { turns, isAsking: mutation.isPending, pending, ask, reset };
}
