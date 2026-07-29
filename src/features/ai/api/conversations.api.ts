/**
 * conversations.api.ts — your past conversations with the assistant.
 *
 * THE DATA WAS ALWAYS THERE. `ai_conversations` and `ai_messages` have recorded every
 * turn since the assistant shipped, with `aic__self_read` scoping conversations to
 * their owner and `aim__via_conversation_read` letting messages through only for a
 * conversation you can already see. What did not exist was a screen, so a person could
 * ask a question, close the tab, and have no way back to the answer.
 *
 * NO RLS LOGIC LIVES HERE, and there is nothing to add: the policies already answer
 * "whose conversation is this". This module reads and formats.
 *
 * WHAT IS DELIBERATELY EXCLUDED FROM THE TRANSCRIPT
 * ------------------------------------------------
 *   · `redacted` rows. A row is marked redacted when its content had to be removed;
 *     showing it as an empty bubble implies the assistant said nothing when in fact
 *     something was taken out. The count of them is surfaced instead, so the reader
 *     knows the transcript is not complete rather than believing it is.
 *   · `tool` rows. A tool result is the raw table the assistant read, not part of the
 *     conversation, and it can hold columns the reader is not entitled to see in that
 *     shape. The narrative already states what it found.
 *   · `system` rows. These are the server talking to itself — validation repair
 *     instructions and operational caveats. Not conversation.
 *
 * That leaves `user` and `assistant`, which is what a person means by "my conversation".
 */
import { z } from "zod";
import { dbTimestampNullable, dbUuid, eq, selectMany, updateRow } from "@/shared/api/query";

export const AI_CONVERSATIONS_TABLE = "ai_conversations";
export const AI_MESSAGES_TABLE = "ai_messages";

/** How many conversations the list will show. Beyond this, search is the answer. */
export const CONVERSATION_LIMIT = 100;

export const conversationSchema = z.object({
  id: dbUuid,
  /** First 60 characters of the opening question — the DB sets it at creation. */
  title: z.string().nullable(),
  scope: z.string(),
  surface: z.string().nullable(),
  message_count: z.number(),
  started_at: z.string(),
  last_message_at: dbTimestampNullable,
  is_archived: z.boolean(),
  pinned: z.boolean(),
});

export type Conversation = z.infer<typeof conversationSchema>;

const CONVERSATION_COLUMNS =
  "id, title, scope, surface, message_count, started_at, last_message_at, is_archived, pinned";

/**
 * My conversations, newest activity first.
 *
 * Ordered by `last_message_at` and not `started_at`: a conversation returned to
 * yesterday is more use than one opened last week and abandoned. NULLS LAST because a
 * conversation with no messages has nothing to show.
 */
export async function fetchMyConversations(signal?: AbortSignal): Promise<Conversation[]> {
  return selectMany(AI_CONVERSATIONS_TABLE, conversationSchema, {
    columns: CONVERSATION_COLUMNS,
    order: [
      { column: "pinned", ascending: false },
      { column: "last_message_at", ascending: false, nullsFirst: false },
    ],
    limit: CONVERSATION_LIMIT,
    ...(signal ? { signal } : {}),
  });
}

/** One turn in a transcript. */
export const transcriptMessageSchema = z.object({
  id: dbUuid,
  sequence: z.number(),
  role: z.string(),
  content: z.string().nullable(),
  recorded_at: z.string(),
  redacted: z.boolean(),
});

export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

export interface Transcript {
  readonly messages: TranscriptMessage[];
  /**
   * Rows the transcript does NOT contain. Stated rather than hidden: a reader must be
   * able to tell "nothing was said" from "something was removed".
   */
  readonly redactedCount: number;
}

/**
 * The readable transcript of one conversation.
 *
 * Fetches `user` and `assistant` rows including redacted ones, then splits them, so
 * the count of what is missing is honest. Filtering redacted rows in the query would
 * make them invisible and unmentionable.
 */
export async function fetchTranscript(
  conversationId: string,
  signal?: AbortSignal,
): Promise<Transcript> {
  const rows = await selectMany(AI_MESSAGES_TABLE, transcriptMessageSchema, {
    columns: "id, sequence, role, content, recorded_at, redacted",
    filters: [eq("conversation_id", conversationId)],
    order: [{ column: "sequence", ascending: true }],
    limit: 500,
    ...(signal ? { signal } : {}),
  });
  const conversational = rows.filter((m) => m.role === "user" || m.role === "assistant");
  /*
    NULL CONTENT IS NOT REDACTION, and conflating them made the screen tell a lie.

    Every turn persists an `assistant` row for the TOOL-CALL step, whose `content` is
    null because that step produced no prose — it called `get_leave_balances` and
    stopped. Counting those as withheld put "1 message is not shown because its content
    was removed" under a complete, unredacted transcript. Nothing had been removed.

    So the two are now separated: a null-content row is structural and simply is not a
    message, while `redacted` means a human or a process took content out and the reader
    must be told. Only the latter is counted.
  */
  return {
    messages: conversational.filter((m) => !m.redacted && m.content !== null),
    redactedCount: conversational.filter((m) => m.redacted).length,
  };
}

/**
 * Archive or restore a conversation.
 *
 * `aic__self_update` grants UPDATE on the owner's own row, and `is_archived` is what
 * the assistant's own conversation lookup filters on — so archiving a conversation
 * also stops it being continued, which is the behaviour somebody means by "clear this
 * from my list".
 *
 * NOT A DELETE. `ai_messages` is the record of what the assistant was asked and
 * answered, and an audit trail that a person can erase is not one. Archiving hides it
 * from their list and leaves it recorded.
 */
export async function setConversationArchived(
  conversationId: string,
  archived: boolean,
): Promise<Conversation> {
  return updateRow(
    AI_CONVERSATIONS_TABLE,
    [eq("id", conversationId)],
    { is_archived: archived },
    conversationSchema,
    {
      // ≥10 characters, like every audited write in this system.
      reason: archived
        ? "employee archived their own assistant conversation"
        : "employee restored their own assistant conversation",
      columns: CONVERSATION_COLUMNS,
    },
  );
}
