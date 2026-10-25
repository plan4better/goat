import type { DynamicToolUIPart } from "ai";

/**
 * What a result card stands for: a public catalog dataset, or the user's own
 * project, dataset, bundle or layer in a project. New kinds (workflows,
 * layouts, templates) are added here and in `itemActions`.
 */
export type ItemKind = "catalog" | "project" | "dataset" | "layer" | "bundle" | "workflow" | "layout";

export interface ResultItem {
  kind: ItemKind;
  /** The catalog record's id, the project's or dataset's UUID, or a layer's `layer_project_id`. */
  id: string;
  /** The project a layer, workflow or layout is in. */
  projectId?: string | null;
  /** The dataset behind a layer, or a dataset's own id: what a preview shows and Add adds. */
  datasetId?: string | null;
  projectName?: string | null;
  title: string;
  /** A layer's type and geometry, a bundle's type, a catalog record's layer type. */
  detail?: string | null;
  /** A catalog record's publisher and licence. */
  publisher?: string | null;
  license?: string | null;
  /** A layer whose data the user cannot read. */
  locked?: boolean;
  /** The answer's one line on why the item matters for the question. */
  note?: string | null;
}

/** Items under a heading (none for a single ungrouped list). */
export interface CardGroup {
  title?: string | null;
  items: ResultItem[];
}

/** The tools that create a workflow; their result names it in `groups`, as `core_show_items` does. */
export const CREATE_WORKFLOW_TOOLS = ["workflow_create", "workflow_create_from_template"] as const;

/** The tools that add a dataset to the open project: a catalog dataset, or one of the user's own. */
export const ADD_LAYER_TOOLS = ["project_add_catalog_layer", "project_add_dataset"] as const;

/** The tools that change the user's content (risk "write" in the assistant's tool registry). */
export const WRITE_TOOLS = [...CREATE_WORKFLOW_TOOLS, ...ADD_LAYER_TOOLS, "workflow_run"] as const;

/**
 * The tools whose result the dock shows as cards: an answer shows the last list
 * of each show tool, and every workflow it created.
 */
export const SHOW_TOOLS = ["catalog_show_records", "core_show_items", ...CREATE_WORKFLOW_TOOLS] as const;

/** The tools whose `groups` list the user's own items: what `core_show_items` names, and a created workflow. */
const OWN_ITEM_TOOLS: ReadonlySet<string> = new Set<string>(["core_show_items", ...CREATE_WORKFLOW_TOOLS]);

/** The most cards one tool result shows: the show tools show the first this many items the model names. */
export const MAX_CARDS = 10;

const OWN_KINDS: ReadonlySet<string> = new Set([
  "project",
  "dataset",
  "layer",
  "bundle",
  "workflow",
  "layout",
]);
/** Kinds that live inside a project and name it. */
const IN_A_PROJECT: ReadonlySet<string> = new Set(["layer", "workflow", "layout"]);

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

const catalogItem = (row: Row): ResultItem | null => {
  const id = text(row.id);
  if (!id) return null;
  return {
    kind: "catalog",
    id,
    title: text(row.title) ?? id,
    detail: text(row.type),
    publisher: text(row.publisher),
    license: text(row.license),
    note: text(row.note),
  };
};

const ownItem = (row: Row): ResultItem | null => {
  const id = text(row.id);
  const kind = text(row.kind);
  if (!id || !kind || !OWN_KINDS.has(kind)) return null;
  if (IN_A_PROJECT.has(kind) && !text(row.project_id)) return null;
  return {
    kind: kind as ItemKind,
    id,
    projectId: text(row.project_id),
    datasetId: text(row.dataset_id),
    projectName: text(row.project_name),
    title: text(row.name) ?? id,
    detail: text(row.detail),
    locked: row.locked === true,
    note: text(row.note),
  };
};

const toGroups = (raw: unknown, key: "records" | "items", item: (row: Row) => ResultItem | null) =>
  (Array.isArray(raw) ? raw : [])
    .filter(isRow)
    .map((group) => ({
      title: text(group.title),
      items: (Array.isArray(group[key]) ? group[key] : [])
        .filter(isRow)
        .map(item)
        .filter((value): value is ResultItem => value !== null),
    }))
    .filter((group) => group.items.length > 0);

/**
 * The items an answer points to, grouped: what one of its `SHOW_TOOLS` steps
 * named, in the answer's order. Search results are not shown as cards: an
 * answer searches several times, and its first hits are rarely what it ends up
 * pointing to. Catalog results stored before the groups list the records flat
 * under `shown`; they become one group without a heading.
 */
export function shownGroups(part: DynamicToolUIPart): CardGroup[] {
  if (part.state !== "output-available") return [];
  const output = isRow(part.output) ? part.output : {};
  // A created workflow is such an item: its card opens it in its project's editor.
  if (OWN_ITEM_TOOLS.has(part.toolName)) return toGroups(output.groups, "items", ownItem);
  if (part.toolName !== "catalog_show_records") return [];
  if (Array.isArray(output.groups)) return toGroups(output.groups, "records", catalogItem);
  return toGroups([{ records: output.shown }], "records", catalogItem);
}

/** One item's identity: a layer's id is only unique within its project. */
export const itemKey = (item: ResultItem): string => [item.kind, item.projectId ?? "", item.id].join(":");

/**
 * Each item once, in its first group, and at most `MAX_CARDS` of one tool
 * result. `seen` holds what the answer's earlier results showed: those items
 * are left out, and the ones kept here are added to it.
 */
export const uniqueGroups = (groups: CardGroup[], seen: Set<string> = new Set()): CardGroup[] => {
  let kept = 0;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const key = itemKey(item);
        if (kept >= MAX_CARDS || seen.has(key)) return false;
        seen.add(key);
        kept += 1;
        return true;
      }),
    }))
    .filter((group) => group.items.length > 0);
};
