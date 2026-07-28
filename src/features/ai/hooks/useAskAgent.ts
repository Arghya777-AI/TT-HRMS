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
                error: error instanceof Error ? error.message : String(error),
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
