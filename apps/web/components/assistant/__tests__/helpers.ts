import type { UIMessageChunk } from "ai";
import { vi } from "vitest";

import type { DockActions } from "@/components/assistant/DockActions";

/** Dock actions as spies. */
export function dockActions() {
  return {
    openRecord: vi.fn(),
    openProject: vi.fn(),
    openInProjectMode: vi.fn(),
    openCreatedWorkflow: vi.fn(async (_projectId: string, _workflowId: string) => true),
    followWorkflowChanges: vi.fn(),
    unsavedWorkflowChanges: vi.fn((_workflowIds: string[]) => false),
    previewDataset: vi.fn(),
    previewBundle: vi.fn(),
    zoomToLayer: vi.fn(),
    addToProject: vi.fn(async () => ({ layers: [7], undo: vi.fn(async () => undefined) })),
    openInProject: vi.fn(async () => undefined),
    openCatalog: vi.fn(),
    newConversationHere: vi.fn(),
  } satisfies DockActions;
}

export const START: UIMessageChunk[] = [{ type: "start", messageId: "a1" }, { type: "start-step" }];
export const FINISH: UIMessageChunk[] = [{ type: "finish-step" }, { type: "finish" }];
export const text = (value: string, id = "t1"): UIMessageChunk[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: value },
  { type: "text-end", id },
];

/**
 * A response stream: closed, open forever (a running answer), or broken after
 * its chunks were read (pull-based, so an error does not discard them).
 */
export function stream(
  chunks: UIMessageChunk[],
  end: "close" | "hang" | Error = "close"
): ReadableStream<UIMessageChunk> {
  let next = 0;
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next]);
        next += 1;
        return undefined;
      }
      if (end === "close") controller.close();
      else if (end instanceof Error) controller.error(end);
      else return new Promise<void>(() => undefined);
      return undefined;
    },
  });
}

/** The first chunks, then the rest once `rest` resolves, then the end. */
export function gatedStream(
  first: UIMessageChunk[],
  rest: Promise<UIMessageChunk[]>
): ReadableStream<UIMessageChunk> {
  let queue = [...first];
  let waited = false;
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (!queue.length && !waited) {
        waited = true;
        queue = await rest;
      }
      const chunk = queue.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

/** What the AI SDK throws when a run request is refused (APICallError). */
export const refusal = (statusCode: number, detail: Record<string, unknown>) =>
  Object.assign(new Error("refused"), { statusCode, responseBody: JSON.stringify({ detail }) });
