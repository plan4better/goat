"use client";

import { useEffect } from "react";

import type { AssistantMessage } from "@/lib/assistant/types";
import { workflowEdits } from "@/lib/assistant/workflowEdits";

import { useDockActions } from "@/components/assistant/DockActions";

/**
 * The edits this tab handed to the page already, by answer and step: a chat
 * mounts again when the dock expands or reconnects, and a running answer then
 * replays from its start.
 */
const followed = new Set<string>();

/** Tests: forget the edits handed over, as a fresh tab would. */
export function resetFollowedWorkflowEdits(): void {
  followed.clear();
}

/**
 * Hands each workflow edit of the conversation's answers to the page once
 * (`followWorkflowChanges`): the Workflows editor loads it when that workflow
 * is open, as one step of its undo. That includes the edits of the
 * conversation as the chat mounted with it, since the conversation may be
 * read again right after the answer; the editor ignores a revision it holds
 * already.
 */
export function useFollowWorkflowEdits(
  messages: AssistantMessage[],
  initialMessages: AssistantMessage[]
): void {
  const actions = useDockActions();
  useEffect(() => {
    // The chat's messages start as the initial ones: each edit counts once.
    const fresh = workflowEdits([...initialMessages, ...messages]).filter((edit) => {
      if (followed.has(edit.key)) return false;
      followed.add(edit.key);
      return true;
    });
    if (fresh.length === 0) return;
    actions.followWorkflowChanges(fresh.map(({ workflowId, revision }) => ({ workflowId, revision })));
  }, [messages, initialMessages, actions]);
}
