import { describe, expect, it } from "vitest";

import type { MapResponse, StyleRead } from "@/lib/api/map";
import { renderLayersOf } from "@/lib/style/render/viewLayers";
import type { ProjectLayer, ProjectLayerGroup } from "@/lib/validations/project";

import {
  foldVisibility,
  joinMapLayers,
  publicMapLayers,
  publishedGroups,
  withMapGroups,
} from "@/hooks/map/useMapLayers";

const PROJECT = "00000000-0000-0000-0000-000000000001";
const row = (id: number, order: number, group: number | null = null, extra = {}) =>
  ({
    id,
    layer_id: `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`,
    name: `L${id}`,
    type: "feature",
    order,
    layer_project_group_id: group,
    locked: false,
    ...extra,
  }) as unknown as ProjectLayer;
const group = (id: number, order: number, parent: number | null = null) =>
  ({ id, name: `G${id}`, order, parent_id: parent, project_id: PROJECT }) as ProjectLayerGroup;
const style = (id: string): StyleRead => ({
  id,
  name: id,
  position: 0,
  revision: 1,
  document: { version: 1, kind: "vector" },
  issues: [],
  stale: false,
});

/** The map document core builds from the same rows (map_rows.build_map_document). */
const response = (hiddenGroup?: number): MapResponse => ({
  map: {
    version: 1,
    layers: [
      { type: "layer", id: 1, visible: true, style: "a" },
      {
        type: "group",
        id: 10,
        name: "G10",
        visible: hiddenGroup !== 10,
        children: [
          { type: "layer", id: 2, visible: true, style: "b" },
          {
            type: "group",
            id: 11,
            name: "G11",
            visible: true,
            children: [{ type: "layer", id: 3, visible: true }],
          },
        ],
      },
      { type: "layer", id: 4, visible: false, style: "d" },
    ],
  },
  styles: {
    "1": { active: style("a"), others: [{ id: "a2", name: "Other" }] },
    "2": { active: style("b"), others: [] },
    "4": { active: style("d"), others: [] },
  },
  unpublished: [],
});
const rows = [row(1, 0), row(2, 0, 10), row(3, 0, 11, { locked: true }), row(4, 2)];
const groups = [group(10, 1), group(11, 1, 10)];

describe("joinMapLayers", () => {
  it("layers come in the map document's depth-first order, top first", () => {
    const joined = joinMapLayers(rows, response());
    expect(joined.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(joined[0].style?.id).toBe("a");
    expect(joined[0].otherStyles).toEqual([{ id: "a2", name: "Other" }]);
  });

  it("a layer in a hidden group stays in the list with visible false", () => {
    const joined = joinMapLayers(rows, response(10));
    expect(joined.map((l) => [l.id, l.visible])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
    expect(joined[1].entry.visible).toBe(true);
  });

  it("a locked link and a snapshot without styles yield a layer without a style", () => {
    const locked = joinMapLayers(rows, response()).find((l) => l.id === 3);
    expect(locked?.style).toBeNull();
    const published = publicMapLayers({ layers: rows, map: response().map, styles: undefined });
    expect(published.map((l) => l.style)).toEqual([null, null, null, null]);
    const withStyles = publicMapLayers({
      layers: rows,
      map: response().map,
      styles: { "1": [style("a2"), style("a")] },
    });
    expect(withStyles[0].style?.id).toBe("a");
    expect(withStyles[0].otherStyles).toEqual([{ id: "a2", name: "a2" }]);
  });

  it("a viewer's style choice (the styles URL parameter) picks that named style; an unknown one is ignored", () => {
    const config = { layers: rows, map: response().map, styles: { "1": [style("a2"), style("a")] } };
    expect(publicMapLayers(config, { "1": "a2" })[0].style?.id).toBe("a2");
    expect(publicMapLayers(config, { "1": "gone" })[0].style?.id).toBe("a");
  });

  it("hiding a group keeps its layers mounted", () => {
    const layers = joinMapLayers(rows, response(10));
    const drawn = renderLayersOf(layers);
    // Layer 2 sits in the hidden group: still on the map, drawn invisible; layer 3 is locked (no style).
    expect(drawn.map((l) => [l.key, l.entry.visible])).toEqual([
      ["1", true],
      ["2", false],
      ["4", false],
    ]);
  });

  it("a viewer hiding a group or a layer folds into what is drawn, without removing anything", () => {
    const published = publicMapLayers({ layers: rows, map: response().map, styles: undefined });
    const hiddenGroup = foldVisibility(published, [
      { id: 10, parent_id: null, visible: false },
      { id: 11, parent_id: 10, visible: true },
    ]);
    expect(hiddenGroup.map((l) => [l.id, l.visible])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
    const shownAgain = foldVisibility(
      published.map((l) => (l.id === 4 ? { ...l, entry: { ...l.entry, visible: true } } : l)),
      [
        { id: 10, parent_id: null, visible: true },
        { id: 11, parent_id: 10, visible: true },
      ]
    );
    expect(shownAgain.map((l) => l.visible)).toEqual([true, true, true, true]);
  });

  it("the group rows take their visibility from the map document (its optimistic state included)", () => {
    expect(withMapGroups(groups, response(10).map).map((g) => [g.id, g.visible])).toEqual([
      [10, false],
      [11, true],
    ]);
    expect(withMapGroups(groups, undefined)).toBe(groups);
  });
});

describe("publishedGroups", () => {
  it("a snapshot converted from the old format hides the groups its map document hides", () => {
    // Converted snapshots keep their groups as they were (visibility and open state in `properties`); the map
    // document carries the visibility.
    const converted = [
      { ...group(10, 1), properties: { visibility: true, expanded: false } },
      { ...group(11, 1, 10), properties: { visibility: true } },
    ] as unknown as ProjectLayerGroup[];
    const groups = publishedGroups({ layer_groups: converted, map: response(10).map });
    expect(groups.map((g) => [g.id, g.visible, g.expanded])).toEqual([
      [10, false, false],
      [11, true, undefined],
    ]);
    const published = publicMapLayers({ layers: rows, map: response(10).map, styles: undefined });
    const drawn = foldVisibility(published, groups);
    expect(drawn.map((l) => [l.id, l.visible])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
  });
});
