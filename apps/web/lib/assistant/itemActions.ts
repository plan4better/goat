import type { ResultItem } from "@/lib/assistant/items";

export type ItemActionId =
  | "open_project"
  | "open_workflow"
  | "open_layout"
  | "zoom_to_layer"
  | "add_to_project"
  | "add_to_other_project";

export interface ItemAction {
  id: ItemActionId;
  /** The compact button text. */
  labelKey: string;
  /** What the button does in full: its tooltip and accessible name. */
  titleKey: string;
}

/** The page the card is shown on. */
export interface ItemActionContext {
  /** The project open on the page. */
  projectId: string | null;
  /** Layers can be added to that project: it is open and the user may edit it. */
  canAddToProject: boolean;
  /** The page shows the project's map, which can zoom to a layer (Map mode, not Workflows, Layouts or Dashboard). */
  canZoom: boolean;
  /** The open project's layer showing this dataset, if it has one. */
  layerOfDataset: (datasetId: string) => number | null;
}

/** What a card offers: at most one button, and whether it has a preview. */
export interface CardBehaviour {
  action: ItemAction | null;
  preview: boolean;
  /** The open project's layer the card stands for: Zoom fits the map to it. */
  layer?: number;
}

const OPEN_PROJECT: ItemAction = {
  id: "open_project",
  labelKey: "open",
  titleKey: "assistant_item_open_project",
};
const OPEN_WORKFLOW: ItemAction = {
  id: "open_workflow",
  labelKey: "open",
  titleKey: "assistant_item_open_workflow",
};
const OPEN_LAYOUT: ItemAction = {
  id: "open_layout",
  labelKey: "open",
  titleKey: "assistant_item_open_layout",
};
const ZOOM: ItemAction = {
  id: "zoom_to_layer",
  labelKey: "assistant_item_zoom",
  titleKey: "assistant_item_zoom_to_layer",
};
const ADD: ItemAction = {
  id: "add_to_project",
  labelKey: "assistant_item_add",
  titleKey: "assistant_result_add",
};
/** Outside a project the user may edit: pick the project first. */
const ADD_ELSEWHERE: ItemAction = {
  id: "add_to_other_project",
  labelKey: "assistant_item_add_choose",
  titleKey: "assistant_item_add_to_project_choose",
};

/**
 * In the open project: no preview, the project shows it already. Zoom where its
 * map is on the page; elsewhere no button, the card still knows its layer.
 */
export const inProject = (layer: number, context: Pick<ItemActionContext, "canZoom">): CardBehaviour => ({
  action: context.canZoom ? ZOOM : null,
  preview: false,
  layer,
});

/**
 * A result card's button and preview, by the item's kind and the page it is
 * shown on. The model only names the items; what can be done with them is
 * decided here. Adding needs a click: into the open project when the user may
 * edit it, else into a project the user picks.
 */
export function cardBehaviour(item: ResultItem, context: ItemActionContext): CardBehaviour {
  const add = context.canAddToProject ? ADD : ADD_ELSEWHERE;
  switch (item.kind) {
    case "project":
      // No preview: a project is its live map, a click on Open away. The one
      // the page shows needs no button either.
      return { action: item.id === context.projectId ? null : OPEN_PROJECT, preview: false };
    case "layer": {
      if (item.projectId === context.projectId) return inProject(Number(item.id), context);
      // A locked layer's dataset is not the user's to read or add.
      if (item.locked || !item.datasetId) return { action: null, preview: false };
      const layer = context.layerOfDataset(item.datasetId);
      return layer === null ? { action: add, preview: true } : inProject(layer, context);
    }
    case "dataset": {
      const layer = context.layerOfDataset(item.datasetId ?? item.id);
      return layer === null ? { action: add, preview: true } : inProject(layer, context);
    }
    case "catalog":
    case "bundle":
      return { action: add, preview: true };
    // Opened in their project's editor; no preview, as for a project.
    case "workflow":
      return { action: OPEN_WORKFLOW, preview: false };
    case "layout":
      return { action: OPEN_LAYOUT, preview: false };
    default:
      return { action: null, preview: false };
  }
}
