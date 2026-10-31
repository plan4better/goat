import useSWR, { mutate } from "swr";

import { assistantFetch } from "@/lib/assistant/http";
import type { ConversationSummary } from "@/lib/assistant/types";
import { ASSISTANT_BASE_URL } from "@/lib/constants";

export const CONVERSATIONS_KEY = "assistant:conversations";

export const listConversations = ({ projectId, q }: { projectId?: string | null; q?: string }) =>
  assistantFetch<ConversationSummary[]>("/conversations", {
    query: { project_id: projectId ?? undefined, q: q?.trim() || undefined, limit: "100" },
  });

/** One list's cache key: the full history without arguments. */
const conversationsKey = (projectId?: string | null, q?: string) => [
  CONVERSATIONS_KEY,
  projectId ?? "",
  q?.trim() ?? "",
];

const fetchConversations = (args: string[]) => listConversations({ projectId: args[1] || null, q: args[2] });

/** The history (spec §10): one project's conversations, or all of them. */
export function useConversations({
  projectId,
  q,
  enabled = true,
}: {
  projectId?: string | null;
  q?: string;
  enabled?: boolean;
}) {
  const key = enabled && ASSISTANT_BASE_URL ? conversationsKey(projectId, q) : null;
  const {
    data,
    error,
    isLoading,
    mutate: revalidate,
  } = useSWR<ConversationSummary[]>(key, fetchConversations, { revalidateOnFocus: false });
  return { conversations: data ?? [], error, isLoading, mutate: revalidate };
}

/**
 * Reads the full history, or with `projectId` that project's conversations (the
 * start page's recent ones), into the cache before the dock first opens: the dock
 * then shows it at once and reads it again in the background, as on every later
 * open. A failed read leaves the cache as it was.
 */
export function warmConversations(projectId?: string | null): void {
  if (!ASSISTANT_BASE_URL) return;
  const key = conversationsKey(projectId);
  void mutate<ConversationSummary[]>(key, fetchConversations(key), { revalidate: false }).catch(
    () => undefined
  );
}

export const updateConversation = (id: string, patch: { title?: string | null; project_id?: string }) =>
  assistantFetch<ConversationSummary>(`/conversations/${id}`, { method: "PATCH", body: patch });

export const deleteConversation = (id: string) =>
  assistantFetch<void>(`/conversations/${id}`, { method: "DELETE" });

/** Revalidate every history list (after a run ended, a rename, a delete). */
export const refreshConversationLists = () =>
  mutate((key) => Array.isArray(key) && key[0] === CONVERSATIONS_KEY);
