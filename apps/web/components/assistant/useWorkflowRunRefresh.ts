"use client";

import { useEffect, useRef } from "react";
import { mutate } from "swr";

import { refreshJobLists } from "@/lib/api/processes";
import { projectLayersKey } from "@/lib/api/projects";
import type { AssistantMessage, WorkflowRunData } from "@/lib/assistant/types";

/**
 * The run parts of the answers, each keyed by its answer and part: a later answer that
 * waits on a job an earlier one left running carries the same part id.
 */
const runParts = (messages: AssistantMessage[]): Array<{ key: string; data: WorkflowRunData }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) =>
          part.type === "data-workflow-run"
            ? [{ key: `${message.id}:${part.id ?? String(part.data.job_id)}`, data: part.data }]
            : []
        )
  );

/** What a change of a run part is told by: its status and the layers it saved. */
const stateOf = (data: WorkflowRunData): string => `${data.status}:${data.saved}`;

/**
 * Keeps the page in step with the workflow runs of the running answer: the job lists are
 * read again when a run starts or changes state (the Workflows canvas finds the run there),
 * and the project's layer list when a run reports saved layers, whatever its status. The
 * runs of the conversation as this chat mounted with it are not read again.
 */
export function useWorkflowRunRefresh(
  messages: AssistantMessage[],
  initialMessages: AssistantMessage[]
): void {
  const seen = useRef<Map<string, string> | null>(null);
  if (seen.current === null) {
    seen.current = new Map(runParts(initialMessages).map(({ key, data }) => [key, stateOf(data)]));
  }
  useEffect(() => {
    const known = seen.current;
    if (!known) return;
    for (const { key, data } of runParts(messages)) {
      const state = stateOf(data);
      if (known.get(key) === state) continue;
      known.set(key, state);
      void refreshJobLists();
      if (data.saved > 0) void mutate(projectLayersKey(data.project_id));
    }
  }, [messages]);
}
