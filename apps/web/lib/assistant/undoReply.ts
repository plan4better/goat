import type { DynamicToolUIPart } from "ai";

import { type MapChange, mapChangeOfUndo } from "@/lib/assistant/mapEdits";
import type { StyleChange } from "@/lib/assistant/styleEdits";
import type { Restored, UndoneMap, UndoneStyle, UndoneWorkflow } from "@/lib/assistant/transport";
import type { AssistantMessage } from "@/lib/assistant/types";
import type { WorkflowChange } from "@/lib/assistant/workflowEdits";

/**
 * The tool that runs the dock's Undo of an earlier answer on a typed request
 * ("undo that"). Its result carries what went back in the shapes of the Undo
 * route's reply, so the page follows it as it follows the button's.
 */
export const UNDO_CHANGES_TOOL = "undo_changes";

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);
const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOf = (value: unknown): number | null => (typeof value === "number" ? value : null);
const wholeOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const restoredOf = (value: unknown): UndoneWorkflow[] =>
  rows(value).flatMap((row) => {
    const workflowId = textOf(row.workflow_id);
    const projectId = textOf(row.project_id);
    return workflowId && projectId ? [{ workflowId, projectId, revision: numberOf(row.revision) }] : [];
  });

/** The style a row names, or null when it names none. */
export const styleOf = (row: Row): { projectId: string; layerProjectId: number; styleId: string } | null => {
  const projectId = textOf(row.project_id);
  const layerProjectId = wholeOf(row.layer_project_id);
  const styleId = textOf(row.style_id);
  return projectId && layerProjectId !== null && styleId ? { projectId, layerProjectId, styleId } : null;
};

const restoredStylesOf = (value: unknown): UndoneStyle[] =>
  rows(value).flatMap((row) => {
    const style = styleOf(row);
    return style
      ? [
          {
            ...style,
            revision: numberOf(row.revision),
            removed: row.removed === true,
            partial: row.partial === true,
          },
        ]
      : [];
  });

const restoredMapOf = (value: unknown): UndoneMap | null => {
  if (!isRow(value)) return null;
  const projectId = textOf(value.project_id);
  if (!projectId) return null;
  const layers = Array.isArray(value.layers)
    ? value.layers.map(wholeOf).filter((id): id is number => id !== null)
    : [];
  return {
    projectId,
    layers,
    tree: value.tree === true,
    groups: value.groups === true,
    basemap: value.basemap === true,
    scene: value.scene === true,
  };
};

const textsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** What an Undo wrote back, from the parts of its reply; a part that is missing reads as nothing. */
export const restoredOfReply = (
  workflows: unknown,
  styles: unknown,
  map: unknown,
  notRestored: unknown
): Restored => ({
  workflows: restoredOf(workflows),
  styles: restoredStylesOf(styles),
  map: restoredMapOf(map),
  notRestored: textsOf(notRestored),
});

/** What a finished `undo_changes` step came to. */
export interface TypedUndo {
  /** `undone`, `changed` (the rest is asked about), `nothing`, `under_way` or `failed`. */
  status: string;
  /** The run whose answer's changes went back, or are asked about. */
  runId: string | null;
  restored: Restored;
  /** A second call of the same answer: the first one's result again, nothing more went back. */
  repeated: boolean;
}

export function typedUndo(part: DynamicToolUIPart): TypedUndo | null {
  if (part.state !== "output-available" || part.toolName !== UNDO_CHANGES_TOOL) return null;
  const output = isRow(part.output) ? part.output : {};
  return {
    status: textOf(output.status) ?? "",
    runId: textOf(output.run_id),
    restored: restoredOfReply(output.workflows, output.styles, output.map, output.not_restored),
    repeated: output.repeated_call !== undefined,
  };
}

/**
 * What a finished `undo_changes` step wrote back for the page to follow: a
 * result that took the changes back, or took back a part and asks about the
 * rest. Null for any other result, and for a repeated call's result, which is
 * the first one's again.
 */
export function undoneByStep(part: DynamicToolUIPart): Restored | null {
  const undo = typedUndo(part);
  if (!undo || undo.repeated || (undo.status !== "undone" && undo.status !== "changed")) return null;
  return undo.restored;
}

/** Whether an Undo wrote anything back. */
export const wroteBack = ({ workflows, styles, map }: Restored): boolean =>
  workflows.length > 0 || styles.length > 0 || map !== null;

const typedUndos = (messages: AssistantMessage[]) =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          if (part.type !== "dynamic-tool") return [];
          const undo = typedUndo(part);
          return undo
            ? [{ ...undo, key: `${message.id}:${part.toolCallId}`, toolCallId: part.toolCallId }]
            : [];
        })
  );

/** What the typed undos of `messages` wrote back (`undoneByStep`), each keyed by its answer and step. */
export const typedUndoEdits = (
  messages: AssistantMessage[]
): Array<{ key: string; toolCallId: string; restored: Restored }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          if (part.type !== "dynamic-tool") return [];
          const restored = undoneByStep(part);
          return restored
            ? [{ key: `${message.id}:${part.toolCallId}`, toolCallId: part.toolCallId, restored }]
            : [];
        })
  );

/**
 * The runs whose answers a typed undo of `messages` took back: their Undo
 * reads Undone, as after a press on it. A result that asks about the rest
 * leaves it Undo, and so does one that names no run, and one with a style
 * core stored nothing of (that style is still to take back).
 */
export const runsUndoneByWords = (messages: AssistantMessage[]): Set<string> =>
  new Set(
    typedUndos(messages).flatMap(({ status, runId, restored }) =>
      runId && (status === "nothing" || (status === "undone" && !restored.notRestored.includes("style")))
        ? [runId]
        : []
    )
  );

/**
 * What the typed undos of `messages` wrote back, by the run whose answer they
 * took back (`undoneByStep`, in order): that answer says what of it went back
 * and what did not, as after a press on its Undo.
 */
export const typedRestores = (messages: AssistantMessage[]): Map<string, Restored[]> => {
  const byRun = new Map<string, Restored[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const runId = typedUndo(part)?.runId;
      const restored = undoneByStep(part);
      if (runId && restored) byRun.set(runId, [...(byRun.get(runId) ?? []), restored]);
    }
  }
  return byRun;
};

/** What the page does to follow what an Undo wrote back (the dock's actions). */
export interface FollowUndoneDeps {
  followWorkflowChanges: (changes: WorkflowChange[]) => void;
  followStyleChanges: (changes: StyleChange[]) => void;
  followMapChange: (change: MapChange) => void;
}

/**
 * Has the page follow what an Undo wrote back, the reply of the Undo button
 * and the result of a typed undo alike: the open workflow loads the stored
 * version, the map draws the styles, and the map page reads again what went
 * back of its map.
 */
export function followUndone(restored: Restored, actions: FollowUndoneDeps): void {
  if (restored.workflows.length) actions.followWorkflowChanges(restored.workflows);
  if (restored.styles.length) {
    actions.followStyleChanges(
      // The reply does not say whether the layer's active style or the style's name went back with it: the
      // layer's list of styles is read again.
      restored.styles.map(({ projectId, layerProjectId, styleId, revision, removed }) => ({
        projectId,
        layerProjectId,
        styleId,
        revision,
        listChanged: true,
        removed,
      }))
    );
  }
  if (restored.map) actions.followMapChange(mapChangeOfUndo(restored.map));
}
