import type { DynamicToolUIPart } from "ai";

import type { AssistantMessage } from "@/lib/assistant/types";

/** The tool that changes a layer's style, or adds one to the layer. */
export const STYLE_UPDATE_TOOL = "style_update";

/** A style changed elsewhere (an assistant edit, the dock's Undo of one) and the revision that left it. */
export interface StyleChange {
  projectId: string;
  layerProjectId: number;
  styleId: string;
  /** Null when it is not known: the map page then reads the style. */
  revision: number | null;
  /** The layer's list of styles changed too: a style was created, made the active one, renamed, or removed by an
   * undo, or an undo switched the active one back. */
  listChanged: boolean;
  /** The style is gone (the undo of a created style). */
  removed?: boolean;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/**
 * The change a finished `style_update` step saved, else null: an edit that
 * created no style, switched no active style, renamed none and kept the
 * revision saved nothing.
 */
export function styleEdit(part: DynamicToolUIPart): StyleChange | null {
  if (part.state !== "output-available" || part.toolName !== STYLE_UPDATE_TOOL) return null;
  const output = isRow(part.output) ? part.output : {};
  const projectId = typeof output.project_id === "string" ? output.project_id : null;
  const styleId = typeof output.style_id === "string" ? output.style_id : null;
  const layerProjectId = whole(output.layer_project_id);
  if (!projectId || !styleId || layerProjectId === null) return null;
  const revision = whole(output.revision_after);
  const listChanged = output.created === true || output.made_active === true || output.renamed === true;
  const moved = revision !== null && revision !== whole(output.revision_before);
  if (!listChanged && !moved) return null;
  return { projectId, layerProjectId, styleId, revision, listChanged };
}

const toolParts = (message: AssistantMessage): DynamicToolUIPart[] =>
  message.parts.filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool");

/** The style changes an answer saved, in order. */
export const answerStyleEdits = (message: AssistantMessage): StyleChange[] =>
  message.role !== "assistant"
    ? []
    : toolParts(message)
        .map(styleEdit)
        .filter((edit): edit is StyleChange => edit !== null);

/** Every style change the answers of `messages` saved, each keyed by its answer and step, with its tool call. */
export const styleEdits = (
  messages: AssistantMessage[]
): Array<StyleChange & { key: string; toolCallId: string }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : toolParts(message).flatMap((part) => {
          const edit = styleEdit(part);
          return edit
            ? [{ ...edit, key: `${message.id}:${part.toolCallId}`, toolCallId: part.toolCallId }]
            : [];
        })
  );
