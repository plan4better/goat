import type { DynamicToolUIPart } from "ai";

import { type MapChange, layerRemoval, mapEdit, mapEdits } from "@/lib/assistant/mapEdits";
import { type StyleChange, answerStyleEdits, styleEdit } from "@/lib/assistant/styleEdits";
import type { AssistantMessage } from "@/lib/assistant/types";
import { type WorkflowEdit, answerEdits, workflowEdit } from "@/lib/assistant/workflowEdits";

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

/** Whether a step saved one of the changes `answerChanges` counts: its line is one that Undo takes back. */
export const savesChange = (part: DynamicToolUIPart): boolean =>
  workflowEdit(part) !== null ||
  styleEdit(part) !== null ||
  (!!mapEdit(part)?.change && layerRemoval(part) !== "only");
