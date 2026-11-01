import type { DynamicToolUIPart } from "ai";

import { ADD_LAYER_TOOLS } from "@/lib/assistant/items";
import type { AssistantMessage } from "@/lib/assistant/types";

const ADD_TOOLS: ReadonlySet<string> = new Set<string>(ADD_LAYER_TOOLS);
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

/** A finished add step that put layers into a project: its key and project. */
export interface LayerAdd {
  key: string;
  projectId: string;
}

/** Every add step of `messages` that added at least one layer, in order. */
export const layerAdds = (messages: AssistantMessage[]): LayerAdd[] =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts
          .filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")
          .flatMap((part) => {
            if (part.state !== "output-available" || !ADD_TOOLS.has(part.toolName)) return [];
            const output = isRow(part.output) ? part.output : {};
            const projectId = typeof output.project_id === "string" ? output.project_id : null;
            const layers = Array.isArray(output.layers) ? output.layers : [];
            return projectId && layers.length > 0
              ? [{ key: `${message.id}:${part.toolCallId}`, projectId }]
              : [];
          })
  );
