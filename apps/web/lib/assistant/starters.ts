import { type Translate, plain } from "@/lib/assistant/chips";
import type { AssistantSurfaceId, PageContext } from "@/lib/assistant/types";

/** What a starter needs from the page; without it, it is not offered. */
type Need = "layers" | "layer_name" | "selected_layer" | "viewport" | "workflow" | "record" | "edit";

interface StarterSpec {
  /** A sentence start: picking it fills the composer instead of sending. */
  draft?: boolean;
  needs?: Need;
}

/** Every starter, by its key (`assistant_starter_<key>`). */
const STARTERS: Record<string, StarterSpec> = {
  // An empty project has no layers to ask about.
  layers: { needs: "layers" },
  layer_fields: { needs: "layer_name" },
  selected_layer: { needs: "selected_layer" },
  view_data: { needs: "viewport" },
  // Both end in a workflow created in the project, which a viewer may not do.
  walk: { draft: true, needs: "edit" },
  workflow: { draft: true, needs: "edit" },
  datasets: { draft: true },
  help_project: {},
  open_workflow: { needs: "workflow" },
  check_workflow: { needs: "workflow" },
  commercial: {},
  updated: {},
  selected_record: { needs: "record" },
  cycling_projects: {},
  population: {},
  help: {},
};

export const STARTER_KEYS = Object.keys(STARTERS);

/** The starters each surface draws from, in the order they show. */
const POOLS: Record<AssistantSurfaceId, string[]> = {
  "project.map": [
    "layers",
    "layer_fields",
    "selected_layer",
    "view_data",
    "walk",
    "workflow",
    "datasets",
    "help_project",
  ],
  "project.workflows": ["open_workflow", "check_workflow", "workflow", "walk", "layers", "help_project"],
  "project.layouts": ["layers", "layer_fields", "datasets", "help_project"],
  "project.dashboard": ["layers", "layer_fields", "datasets", "help_project"],
  catalog: ["selected_record", "datasets", "commercial", "updated"],
  none: ["cycling_projects", "datasets", "population", "help"],
};

export const MAX_STARTERS = 4;

/** The longest layer name a starter quotes: a longer one would wrap its card over several lines. */
export const MAX_STARTER_LAYER_NAME = 40;

/** What the page has that a starter can refer to. */
export interface StarterContext {
  selectedLayer?: boolean;
  viewport?: boolean;
  /** A workflow is open in Workflows mode. */
  workflow?: boolean;
  /** A catalog record is selected. */
  selectedRecord?: boolean;
  /** The open project's layer names. */
  layerNames?: string[];
  /** The user may change the open project (add layers, create workflows). */
  canEdit?: boolean;
}

/** A drawn starter: its key, and for `layer_fields` the layer it names. */
export interface StarterPick {
  key: string;
  name?: string;
}

/** A starter as the start page shows it. */
export interface Starter {
  key: string;
  text: string;
  draft: boolean;
}

/** The starter context of the context a message carries (the chips the user removed are gone). */
export function starterContext(
  context: PageContext | null,
  layerNames: string[] = [],
  canEdit = false
): StarterContext {
  return {
    selectedLayer: context?.surface === "project.map" && context.selected_layer_project_id !== undefined,
    viewport: context?.surface === "project.map" && !!context.viewport,
    workflow: context?.surface === "project.workflows" && !!context.workflow_id,
    selectedRecord: context?.surface === "catalog" && !!context.selected_record_id,
    layerNames,
    canEdit,
  };
}

/** The project's layer names a starter can quote. */
const quotable = (ctx: StarterContext): string[] =>
  (ctx.layerNames ?? []).filter((name) => name.length <= MAX_STARTER_LAYER_NAME);

const has = (need: Need | undefined, ctx: StarterContext): boolean => {
  switch (need) {
    case undefined:
      return true;
    case "layers":
      return !!ctx.layerNames?.length;
    case "layer_name":
      return quotable(ctx).length > 0;
    case "selected_layer":
      return !!ctx.selectedLayer;
    case "viewport":
      return !!ctx.viewport;
    case "workflow":
      return !!ctx.workflow;
    case "record":
      return !!ctx.selectedRecord;
    case "edit":
      return !!ctx.canEdit;
  }
};

/**
 * Up to four starters for the start page, drawn at random (`random` as
 * `Math.random`) from the surface's starters whose context the page has,
 * in the pool's order. `layer_fields` draws the layer it names.
 */
export function pickStarters(
  surface: AssistantSurfaceId,
  ctx: StarterContext,
  random: () => number
): StarterPick[] {
  const eligible = POOLS[surface].filter((key) => has(STARTERS[key].needs, ctx));
  // Fisher-Yates: the first MAX_STARTERS of a shuffled copy.
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const chosen = new Set(shuffled.slice(0, MAX_STARTERS));
  const names = quotable(ctx);
  return eligible
    .filter((key) => chosen.has(key))
    .map((key) =>
      key === "layer_fields" ? { key, name: names[Math.floor(random() * names.length)] } : { key }
    );
}

/**
 * The drawn starters whose context the page still has (a deselected layer, a
 * closed workflow or a removed layer takes its starter along), translated now,
 * so they follow the language. A layer name is user text, so it is not escaped.
 */
export function showStarters(picks: StarterPick[], ctx: StarterContext, t: Translate): Starter[] {
  return picks
    .filter(
      ({ key, name }) => has(STARTERS[key].needs, ctx) && (name === undefined || quotable(ctx).includes(name))
    )
    .map(({ key, name }) => ({
      key,
      text: t(`assistant_starter_${key}`, name === undefined ? undefined : plain({ name })),
      draft: !!STARTERS[key].draft,
    }));
}
