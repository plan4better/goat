"use client";

import { useEffect, useState } from "react";

import { createdWorkflows } from "@/lib/assistant/createdWorkflows";
import type { AssistantMessage } from "@/lib/assistant/types";

import { useDockActions } from "@/components/assistant/DockActions";

/**
 * Workflows this tab handed to the dock already. A chat mounts again when the
 * dock expands or reconnects, and the running answer then replays from its
 * start; a repeated create answers with the first workflow again. Neither
 * opens it a second time.
 */
const handled = new Set<string>();

/** Tests: forget the workflows handed over, as a fresh tab would. */
export function resetHandedOverWorkflows(): void {
  handled.clear();
}

/**
 * Hands each workflow the running answer creates to the dock once (contract
 * "Created workflows"); the dock opens it when the page allows. The workflows
 * of the conversation as this chat mounted with it were created before: a
 * stored conversation never opens one.
 */
export function useOpenCreatedWorkflows(
  messages: AssistantMessage[],
  initialMessages: AssistantMessage[]
): void {
  const actions = useDockActions();
  const [before] = useState<ReadonlySet<string>>(
    () => new Set(createdWorkflows(initialMessages).map((workflow) => workflow.id))
  );
  useEffect(() => {
    for (const workflow of createdWorkflows(messages)) {
      if (before.has(workflow.id) || handled.has(workflow.id)) continue;
      handled.add(workflow.id);
      void actions.openCreatedWorkflow(workflow.projectId, workflow.id);
    }
  }, [messages, actions, before]);
}
