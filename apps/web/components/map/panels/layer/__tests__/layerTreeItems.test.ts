import { describe, expect, it } from "vitest";

import type { ProjectLayerTreeNode } from "@/lib/validations/project";

import {
  type ProjectTreeItem,
  formatApiDataForDnd,
  formatDndDataForApi,
  treeChanges,
} from "@/components/map/panels/layer/layerTreeItems";

const group = (id: number, extra: Partial<ProjectLayerTreeNode> = {}): ProjectLayerTreeNode => ({
  id,
  type: "group",
  name: `G${id}`,
  order: 0,
  extent: "",
  ...extra,
});
const layer = (id: number, extra: Partial<ProjectLayerTreeNode> = {}): ProjectLayerTreeNode => ({
  id,
  type: "layer",
  name: `L${id}`,
  order: 0,
  extent: "",
  ...extra,
});

describe("layer tree items", () => {
  it("map state opens the tree: a group's expanded, a layer's legend_expanded; a hidden group shows no children", () => {
    const items = formatApiDataForDnd([
      group(1, { expanded: false }),
      group(2, { visible: false }),
      layer(5, { parent_id: 1, legend_expanded: false }),
      layer(6, { parent_id: 2 }),
      layer(7),
    ]);
    expect(items.map((i) => [i.id, i.collapsed, i.canExpand])).toEqual([
      ["group-1", true, true],
      ["group-2", false, false],
      ["layer-5", true, undefined],
      ["layer-7", false, undefined],
    ]);
  });

  it("the tree PUT carries order, parent and a group's expanded, never properties", () => {
    const items = formatApiDataForDnd([group(1), layer(5, { parent_id: 1 }), layer(7)]);
    const collapsed = items.map((i) => (i.id === "group-1" ? { ...i, collapsed: true } : i));
    expect(formatDndDataForApi(collapsed)).toEqual({
      items: [
        { id: 1, type: "group", order: 0, parent_id: null, expanded: false },
        { id: 5, type: "layer", order: 1, parent_id: 1 },
        { id: 7, type: "layer", order: 2, parent_id: null },
      ],
    });
  });

  it("collapsing a legend sends legend_expanded false; moving or folding a group goes to the tree PUT", () => {
    const before: ProjectTreeItem[] = formatApiDataForDnd([group(1), layer(5, { parent_id: 1 }), layer(7)]);
    const legend = before.map((i) => (i.id === "layer-5" ? { ...i, collapsed: true } : i));
    expect(treeChanges(before, legend)).toEqual({ legends: [[5, false]], tree: false });
    const folded = before.map((i) => (i.id === "group-1" ? { ...i, collapsed: true } : i));
    expect(treeChanges(before, folded)).toEqual({ legends: [], tree: true });
    const moved = [before[0], before[2], before[1]];
    expect(treeChanges(before, moved)).toEqual({ legends: [], tree: true });
    const reparented = before.map((i) => (i.id === "layer-7" ? { ...i, parentId: "group-1" } : i));
    expect(treeChanges(before, reparented).tree).toBe(true);
  });
});
