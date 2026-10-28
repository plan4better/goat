// The layer tree's rows and what a change of them writes (spec 10 map state): the rows come from the project layers
// and groups with their map state; a moved row or a group opened or closed goes to the tree PUT, a layer's legend
// opened or closed to its map-state PATCH.
import type { ProjectLayerTreeNode, ProjectLayerTreeUpdate } from "@/lib/validations/project";

import type { BaseTreeItem } from "@/components/map/panels/layer/DraggableTreeView";

export interface ProjectTreeItem extends BaseTreeItem {
  data: ProjectLayerTreeNode;
  canExpand?: boolean;
}

const shown = (node: ProjectLayerTreeNode) => node.visible !== false;

/** The tree's rows: a hidden group is listed closed and without its children (the map keeps them, drawn hidden). */
export function formatApiDataForDnd(
  nodes: ProjectLayerTreeNode[],
  statusLabel?: (node: ProjectLayerTreeNode) => string | undefined
): ProjectTreeItem[] {
  const groups = new Map(nodes.filter((n) => n.type === "group").map((n) => [n.id, n]));
  const insideHiddenGroup = (node: ProjectLayerTreeNode) => {
    const seen = new Set<number>();
    for (let id = node.parent_id; id !== null && id !== undefined && !seen.has(id); ) {
      seen.add(id);
      const parent = groups.get(id);
      if (!parent) break;
      if (!shown(parent)) return true;
      id = parent.parent_id;
    }
    return false;
  };
  // Groups backed by a bundle have locked membership: layers can't be dragged into or out of them.
  const bundleGroupIds = new Set(nodes.filter((n) => n.type === "group" && n.bundle_id).map((n) => n.id));

  return nodes
    .filter((node) => !insideHiddenGroup(node))
    .map((node) => {
      const isGroup = node.type === "group";
      const isBundleMember = !isGroup && !!node.parent_id && bundleGroupIds.has(node.parent_id);
      return {
        id: `${node.type}-${node.id}`,
        parentId: node.parent_id ? `group-${node.parent_id}` : null,
        label: node.name,
        collapsed: isGroup ? node.expanded === false : node.legend_expanded === false,
        isGroup,
        labelInfo: isGroup ? undefined : statusLabel?.(node),
        data: node,
        // A hidden group cannot be opened.
        canExpand: isGroup ? shown(node) : undefined,
        // Bundle-group lock: member layers can't be dragged at all, and nothing can be dropped into the group. The
        // group itself stays a drop target so it can be reordered; membership is enforced on drop.
        isBundleGroup: isGroup && !!node.bundle_id,
        dragDisabled: isBundleMember,
        dropDisabled: isBundleMember,
      };
    });
}

const idOf = (item: ProjectTreeItem) => Number(item.id.split("-")[1]);
const parentOf = (item: ProjectTreeItem) => (item.parentId ? Number(item.parentId.split("-")[1]) : null);

/** The tree PUT: every row's order and parent, and each group open or closed. */
export function formatDndDataForApi(items: ProjectTreeItem[]): ProjectLayerTreeUpdate {
  return {
    items: items.map((item, index) => ({
      id: idOf(item),
      type: item.data.type,
      order: index,
      parent_id: parentOf(item),
      ...(item.data.type === "group" ? { expanded: !item.collapsed } : {}),
    })),
  };
}

/** What a change of the rows writes: the layers whose legend opened or closed (with legend_expanded), and whether the
 * order, a parent or a group's open state changed (the tree PUT). */
export function treeChanges(
  before: ProjectTreeItem[],
  after: ProjectTreeItem[]
): { legends: Array<[number, boolean]>; tree: boolean } {
  const previous = new Map(before.map((item, index) => [item.id, { item, index }]));
  const legends: Array<[number, boolean]> = [];
  let tree = before.length !== after.length;
  after.forEach((item, index) => {
    const old = previous.get(item.id);
    if (!old) {
      tree = true;
      return;
    }
    if (old.index !== index || old.item.parentId !== item.parentId) tree = true;
    if (!!old.item.collapsed !== !!item.collapsed) {
      if (item.data.type === "group") tree = true;
      else legends.push([idOf(item), !item.collapsed]);
    }
  });
  return { legends, tree };
}
