import { type MapChange, layerRemoval, mapEdits } from "@/lib/assistant/mapEdits";
import { type StyleChange, answerStyleEdits } from "@/lib/assistant/styleEdits";
import type { AssistantMessage } from "@/lib/assistant/types";
import { type WorkflowEdit, answerEdits } from "@/lib/assistant/workflowEdits";

/** What an answer saved, by kind, in order: the dock's Undo shows only for an answer with some. */
export interface AnswerChanges {
  workflows: WorkflowEdit[];
  styles: StyleChange[];
  /**
   * One per map step that stored something Undo can put back; a step that only moved the view is not one, nor one
   * that only removed layers.
   */
  map: MapChange[];
  /** The answer removed a layer: it does not come back with Undo. */
  layersRemoved: boolean;
}

export function answerChanges(message: AssistantMessage): AnswerChanges {
  const removals = new Map(
    message.role === "assistant"
      ? message.parts.flatMap((part) =>
          part.type === "dynamic-tool" ? [[part.toolCallId, layerRemoval(part)] as const] : []
        )
      : []
  );
  return {
    workflows: answerEdits(message),
    styles: answerStyleEdits(message),
    map: mapEdits([message]).flatMap(({ change, toolCallId }) =>
      change && removals.get(toolCallId) !== "only" ? [change] : []
    ),
    layersRemoved: [...removals.values()].some((removal) => removal !== null),
  };
}

export const hasChanges = (changes: AnswerChanges): boolean =>
  changes.workflows.length > 0 || changes.styles.length > 0 || changes.map.length > 0;
