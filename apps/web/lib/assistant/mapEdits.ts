import type { DynamicToolUIPart } from "ai";

import type { UndoneMap } from "@/lib/assistant/transport";
import type { AssistantMessage } from "@/lib/assistant/types";

/** The tool that changes the map: its layers' state, names and filters, the tree, the basemap, the scene, the view. */
export const MAP_UPDATE_TOOL = "map_update";

/** A view the page is asked to show: a camera or a box to fit, the 2D or 3D mode, the projection. Never stored. */
export interface ViewTarget {
  camera?: { center?: [number, number]; zoom?: number; pitch?: number; bearing?: number };
  /** [west, south, east, north]. */
  bbox?: [number, number, number, number];
  mode?: "2d" | "3d";
  projection?: "mercator" | "globe";
}

/** What of a project's map was changed elsewhere (an assistant step, the dock's Undo of one): what the page reads again. */
export interface MapChange {
  projectId: string;
  /** The layer rows: names, filters, added or removed layers. */
  layers: boolean;
  /** The map document: visibility, position, active style, order. */
  state: boolean;
  groups: boolean;
  basemap: boolean;
  scene: boolean;
}

type Row = Record<string, unknown>;
type Flags = Partial<Omit<MapChange, "projectId">>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numbers = (value: unknown, length: number): number[] | null =>
  Array.isArray(value) && value.length === length && value.every(finite) ? (value as number[]) : null;

const GROUP: Flags = { groups: true, state: true };

/** What an applied operation changed; `fields` names what a `set_layer` set. */
function touched(op: unknown, fields: unknown): Flags {
  switch (op) {
    case "set_layer": {
      // An operation that names no fields may have set any of them.
      if (!Array.isArray(fields) || !fields.length) return { layers: true, state: true };
      return { layers: fields.includes("name"), state: fields.some((field) => field !== "name") };
    }
    case "filter":
      return { layers: true };
    case "remove_layer":
      return { layers: true, state: true };
    case "move":
      return { layers: true, state: true, groups: true };
    case "add_group":
    case "rename_group":
    case "set_group":
    case "remove_group":
      return GROUP;
    case "set_basemap":
      return { basemap: true };
    case "set_scene":
      return { scene: true };
    default:
      // `set_view` is the page's to apply: nothing of it is stored.
      return {};
  }
}

const changeOf = (projectId: string, all: Flags[]): MapChange => {
  const any = (flag: keyof Flags) => all.some((flags) => flags[flag] === true);
  return {
    projectId,
    layers: any("layers"),
    state: any("state"),
    groups: any("groups"),
    basemap: any("basemap"),
    scene: any("scene"),
  };
};
/** Two changes of one project's map as one: what either touched. */
export const mergedMapChange = (a: MapChange, b: MapChange): MapChange => changeOf(a.projectId, [a, b]);

const changesAny = ({ layers, state, groups, basemap, scene }: MapChange): boolean =>
  layers || state || groups || basemap || scene;

/** The view a result asks for, with only the parts the map can use; null when none is left. */
function viewOf(value: unknown): ViewTarget | null {
  if (!isRow(value)) return null;
  const view: ViewTarget = {};
  if (isRow(value.camera)) {
    const camera: NonNullable<ViewTarget["camera"]> = {};
    const center = numbers(value.camera.center, 2);
    if (center) camera.center = center as [number, number];
    for (const key of ["zoom", "pitch", "bearing"] as const) {
      const number = value.camera[key];
      if (finite(number)) camera[key] = number;
    }
    if (Object.keys(camera).length) view.camera = camera;
  }
  const bbox = numbers(value.bbox, 4);
  if (bbox) view.bbox = bbox as [number, number, number, number];
  if (value.mode === "2d" || value.mode === "3d") view.mode = value.mode;
  if (value.projection === "mercator" || value.projection === "globe") view.projection = value.projection;
  return Object.keys(view).length ? view : null;
}

/** What a finished `map_update` step left to follow, else null. */
export interface MapEdit {
  projectId: string;
  toolCallId: string;
  /** What the step changed on the server; null when it only moved the view. */
  change: MapChange | null;
  /** The view the step asks the page to show. */
  view: ViewTarget | null;
}

/**
 * What a finished `map_update` step left to follow: the operations it applied (also when a later one failed) as
 * the caches they touch, and the view it asks for. Null for a step that applied nothing and asks for no view.
 */
export function mapEdit(part: DynamicToolUIPart): MapEdit | null {
  if (part.state !== "output-available" || part.toolName !== MAP_UPDATE_TOOL) return null;
  const output = isRow(part.output) ? part.output : {};
  const projectId = typeof output.project_id === "string" ? output.project_id : null;
  if (!projectId) return null;
  const applied = Array.isArray(output.applied) ? output.applied.filter(isRow) : [];
  const all = changeOf(
    projectId,
    applied.map((op) => touched(op.op, op.fields))
  );
  const change = changesAny(all) ? all : null;
  const view = viewOf(output.view);
  if (!change && !view) return null;
  return { projectId, toolCallId: part.toolCallId, change, view };
}

/**
 * Whether a finished `map_update` step removed layers: "only" when that is all it stored (nothing of it comes back
 * with Undo), "some" beside other changes, else null.
 */
export function layerRemoval(part: DynamicToolUIPart): "only" | "some" | null {
  if (part.state !== "output-available" || part.toolName !== MAP_UPDATE_TOOL) return null;
  const output = isRow(part.output) ? part.output : {};
  const stored = (Array.isArray(output.applied) ? output.applied.filter(isRow) : []).filter(
    (op) => op.op !== "set_view"
  );
  if (!stored.some((op) => op.op === "remove_layer")) return null;
  return stored.every((op) => op.op === "remove_layer") ? "only" : "some";
}

/** Every map change and view the answers of `messages` left, each keyed by its answer and step. */
export const mapEdits = (messages: AssistantMessage[]): Array<MapEdit & { key: string }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          const edit = part.type === "dynamic-tool" ? mapEdit(part) : null;
          return edit ? [{ ...edit, key: `${message.id}:${edit.toolCallId}` }] : [];
        })
  );

/** Where the dock keeps the way back from the view a step showed, beside the undo functions of applied proposals. */
export const viewUndoKey = (toolCallId: string): string => `view:${toolCallId}`;

/** What the page reads again after the dock's Undo wrote a map back. */
export function mapChangeOfUndo(map: UndoneMap): MapChange {
  return changeOf(map.projectId, [
    // A layer's entry does not say whether its name, its filter or its map state went back.
    map.layers.length ? { layers: true, state: true } : {},
    map.tree ? touched("move", null) : {},
    map.groups ? GROUP : {},
    { basemap: map.basemap, scene: map.scene },
  ]);
}
