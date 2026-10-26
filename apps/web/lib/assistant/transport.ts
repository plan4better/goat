import { DefaultChatTransport, type TextUIPart } from "ai";
import { getSession } from "next-auth/react";

import type { ChangedBy } from "@/lib/api/changedElsewhere";
import { readAssistantError } from "@/lib/assistant/errors";
import { assistantFetch, assistantUrl, authHeaders } from "@/lib/assistant/http";
import type {
  AnswerFeedback,
  AskAnswer,
  AssistantMessage,
  ConversationDetail,
  ConversationRecord,
  Locale,
  PageContext,
  Rating,
} from "@/lib/assistant/types";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

export interface TransportOptions {
  /** The run that was active when the conversation was loaded; read at reconnect time. */
  getActiveRunId?: () => string | null | undefined;
  getLocale?: () => Locale;
}

/**
 * The newest user message: the only one the server needs (it keeps the
 * history), with the ask card answer it carries as `answer` (contract "The ask card").
 */
export function lastUserMessage(messages: AssistantMessage[]): {
  id: string;
  text: string;
  answer?: AskAnswer;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = message.parts
      .filter((part): part is TextUIPart => part.type === "text")
      .map((part) => part.text)
      .join("");
    const answer = message.metadata?.answer;
    return answer ? { id: message.id, text, answer } : { id: message.id, text };
  }
  throw new Error("There is no message to send.");
}

/**
 * The user's refresh token, so a detached run outlives the access token (spec
 * §6.5 fallback, plan 3). None without a session (AUTH=False).
 */
async function refreshToken(): Promise<string | null> {
  try {
    const session = await getSession();
    const token = (session as { refresh_token?: unknown } | null)?.refresh_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * The AI SDK transport for one conversation (spec §6.1/§6.2).
 *
 * Only the new message goes to the server, with the context of the page it was
 * sent from (passed as `sendMessage(..., { body: { context } })`). Regenerating
 * an answer is not offered (spec §1 non-goals). `useChat({ resume: true })`
 * reconnects through `/stream`, which replays from the start of the run; the
 * dock only does that with a fresh chat (Task 9).
 */
export function createAssistantTransport(
  conversationId: string,
  options: TransportOptions = {}
): DefaultChatTransport<AssistantMessage> {
  const base = `${ASSISTANT_BASE_URL}/conversations/${conversationId}`;
  return new DefaultChatTransport<AssistantMessage>({
    api: `${base}/runs`,
    prepareSendMessagesRequest: async ({ messages, body, trigger }) => {
      if (trigger !== "submit-message") throw new Error("The assistant does not regenerate answers.");
      const context = (body as { context?: PageContext | null } | undefined)?.context ?? null;
      const refresh = await refreshToken();
      return {
        body: {
          message: lastUserMessage(messages),
          context,
          locale: options.getLocale?.() ?? "en",
          ...(refresh ? { refresh_token: refresh } : {}),
        },
        headers: await authHeaders(),
      };
    },
    prepareReconnectToStreamRequest: async () => {
      const runId = options.getActiveRunId?.();
      return {
        api: runId ? `${base}/stream?run_id=${encodeURIComponent(runId)}` : `${base}/stream`,
        headers: await authHeaders(),
      };
    },
  });
}

export const createConversation = (originSurface: string, projectId?: string | null) =>
  assistantFetch<ConversationRecord>("/conversations", {
    method: "POST",
    body: { origin_surface: originSurface, project_id: projectId ?? null },
  });

export async function fetchConversation(conversationId: string): Promise<ConversationDetail> {
  const body = await assistantFetch<{
    conversation: ConversationRecord;
    messages: AssistantMessage[];
    active_run_id: string | null;
    access?: "ok" | "lost";
    project_name?: string | null;
    feedback?: Record<string, AnswerFeedback>;
  }>(`/conversations/${conversationId}`);
  return {
    conversation: body.conversation,
    messages: body.messages,
    activeRunId: body.active_run_id ?? null,
    access: body.access ?? "ok",
    projectName: body.project_name ?? null,
    feedback: body.feedback ?? {},
  };
}

/** Rates an answer, or with `rating` null removes the rating. */
export const saveFeedback = (
  conversationId: string,
  messageId: string,
  rating: Rating | null,
  comment: string | null = null
) =>
  assistantFetch<{ rating: Rating | null; comment: string | null }>(
    `/conversations/${conversationId}/messages/${messageId}/feedback`,
    { method: "PUT", body: { rating, comment } }
  );

/** Server-side stop. `useChat().stop()` only drops the connection when resume is on. */
export const cancelAssistantRun = (conversationId: string) =>
  assistantFetch<void>(`/conversations/${conversationId}/cancel`, { method: "POST" });

/** A workflow the dock's Undo wrote back, and the revision that gave it (null when core named none). */
export interface UndoneWorkflow {
  workflowId: string;
  projectId: string;
  revision: number | null;
}

/** A workflow saved since the answer's edits: who and when, when core named them. */
export interface ChangedSince {
  id: string;
  revision: number | null;
  updatedAt: string | null;
  updatedBy: ChangedBy | null;
  /** Saved between two of the answer's edits rather than after them. */
  between: boolean;
}

/**
 * How an Undo went: the workflows went back, or some were changed since the
 * answer's edits and the dock asks before it writes over them (`force`).
 * Those that went back are listed either way.
 */
export type UndoOutcome =
  | { kind: "undone"; restored: UndoneWorkflow[] }
  | { kind: "changed"; restored: UndoneWorkflow[]; changed: ChangedSince[] };

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => typeof row === "object" && row !== null) : [];
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOf = (value: unknown): number | null => (typeof value === "number" ? value : null);

const restoredOf = (value: unknown): UndoneWorkflow[] =>
  rows(value).flatMap((row) => {
    const workflowId = textOf(row.workflow_id);
    const projectId = textOf(row.project_id);
    return workflowId && projectId ? [{ workflowId, projectId, revision: numberOf(row.revision) }] : [];
  });

const changedOf = (value: unknown): ChangedSince[] =>
  rows(value).flatMap((row) => {
    const id = textOf(row.workflow_id);
    const by = row.updated_by;
    return id
      ? [
          {
            id,
            revision: numberOf(row.revision),
            updatedAt: textOf(row.updated_at),
            updatedBy: typeof by === "object" && by !== null ? (by as ChangedBy) : null,
            between: row.between === true,
          },
        ]
      : [];
  });

/**
 * Writes back what an answer's workflow edits replaced (the dock's Undo).
 * With `force`, also over changes made since. Throws the service's refusal
 * (`already_undone`, `undo_not_allowed`, ...) as an AssistantRequestError.
 */
export async function undoAnswer(conversationId: string, runId: string, force = false): Promise<UndoOutcome> {
  const response = await fetch(
    assistantUrl(`/conversations/${conversationId}/runs/${encodeURIComponent(runId)}/undo`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ force }),
    }
  );
  if (response.ok) {
    const body = (await response.json()) as { workflows?: unknown };
    return { kind: "undone", restored: restoredOf(body.workflows) };
  }
  if (response.status === 409) {
    const text = await response.text();
    try {
      const detail = (JSON.parse(text) as { detail?: Row }).detail;
      if (detail?.code === "changed_since") {
        return { kind: "changed", restored: restoredOf(detail.undone), changed: changedOf(detail.workflows) };
      }
    } catch {
      // Not JSON: a refusal like any other.
    }
    throw await readAssistantError(new Response(text, { status: 409 }));
  }
  throw await readAssistantError(response);
}
