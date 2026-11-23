// Clusters on the map, over points placed in groups whose sizes and values the cases know (cases.ts CLUSTER_GROUPS):
// what each cluster counts and shows, read from the features MapLibre draws, and the legend's cluster entry beside it.
import { Color } from "@maplibre/maplibre-gl-style-spec";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileLayer } from "@/lib/style/compile";
import { parseMarkerImage } from "@/lib/style/compile/markerImage";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { applyCompiled } from "@/lib/style/render/apply";

import { CLUSTER_GROUPS, CLUSTER_ZOOM, type LabCaseOf, labCases } from "./cases";
import { type LabGroup, type Scene, closeScenes, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

// The scenes' errors once more: those the map reported after a test changed it.
afterEach(() => {
  expect(closeScenes(scenes)).toEqual([]);
});

const labCase = (id: string): LabCaseOf => labCases().find((c) => c.id === id)!;

async function scene(c: LabCaseOf): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** How far from its group's pixel a cluster or a point of the group is looked for. */
const REACH = 24;

/** The features the map draws on the scene's layer whose id ends in `-part` (the compiler's part names: `marker`,
 * `icon`, `cluster-marker`, `cluster-icon`, `cluster-label`, `cluster-badge`) within REACH of a group's pixel. */
function drawnNear(s: Scene, part: string, group: LabGroup): MapGeoJSONFeature[] {
  const layer = `${s.input!.id}-${part}`;
  expect(s.map.getLayer(layer), `layer ${layer}`).toBeDefined();
  const [x, y] = group.at;
  return s.map.queryRenderedFeatures(
    [
      [x - REACH, y - REACH],
      [x + REACH, y + REACH],
    ],
    { layers: [layer] }
  );
}

/** The one cluster drawn on a layer near a group. */
function clusterNear(s: Scene, part: string, group: LabGroup): MapGeoJSONFeature {
  const found = drawnNear(s, part, group);
  expect(found.length, `clusters on ${part} near ${group.at}`).toBeGreaterThan(0);
  expect(new Set(found.map((f) => f.id)).size, `clusters on ${part} near ${group.at}`).toBe(1);
  expect(found[0].properties.point_count).toBeDefined();
  return found[0];
}

/** How many single points (no cluster) a layer draws near a group. */
const singlesNear = (s: Scene, part: string, group: LabGroup) =>
  new Set(
    drawnNear(s, part, group)
      .filter((f) => f.properties.point_count === undefined)
      .map((f) => f.id)
  ).size;

/** The text a symbol feature draws, as MapLibre evaluated it. */
function textOf(f: MapGeoJSONFeature): string {
  const field = f.layer.layout?.["text-field"] as unknown;
  if (isObject(field) && Array.isArray(field.sections))
    return field.sections.map((section) => (isObject(section) ? String(section.text) : "")).join("");
  return String(field ?? "");
}

const imageOf = (f: MapGeoJSONFeature) => {
  const image = f.layer.layout?.["icon-image"] as unknown;
  return isObject(image) ? String(image.name) : String(image ?? "");
};

/** A circle's drawn diameter. */
const diameter = (f: MapGeoJSONFeature) => 2 * Number(f.layer.paint?.["circle-radius"]);

const hex = (value: unknown) => {
  const color = value instanceof Color ? value : Color.parse(String(value));
  return color ? color.toString() : String(value);
};

/** The next idle frame, over and over, until `done` holds (clustering again runs in the worker). */
async function until(s: Scene, done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i++) {
    const idle = s.map.once("idle");
    s.map.triggerRepaint();
    await idle;
  }
}

/** The legend's cluster entry. */
function clusterEntry(s: Scene) {
  const section = s.legend?.sections.find((sec) => sec.id === "cluster");
  expect(section?.kind).toBe("entries");
  return section?.kind === "entries" ? section.entries[0] : undefined;
}

describe("clusters drawn as circles", () => {
  const groups = CLUSTER_GROUPS.circle;

  it("a group of N points draws one cluster that counts N, with its count on it", async () => {
    const s = await scene(labCase("cluster-circle"));
    for (const group of groups) {
      const circle = clusterNear(s, "cluster-marker", group);
      expect(circle.properties.point_count).toBe(group.points.length);
      expect(textOf(clusterNear(s, "cluster-label", group))).toBe(String(group.points.length));
    }
  });

  it("circle sizes follow the count within the cluster symbol's sizes", async () => {
    const c = labCase("cluster-circle");
    const s = await scene(c);
    const render = c.style.render as JsonObject;
    const size = ((render.symbol as JsonObject).marker as JsonObject).size as JsonObject;
    const [smallest, largest] = size.range as [number, number];
    const sizes = groups.map((group) => diameter(clusterNear(s, "cluster-marker", group)));
    for (const d of sizes) {
      expect(d).toBeGreaterThanOrEqual(smallest - 0.5);
      expect(d).toBeLessThanOrEqual(largest + 0.5);
    }
    // More points, a larger circle.
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("at cluster_until_zoom each group draws its points one by one", async () => {
    const s = await scene({ ...labCase("cluster-circle"), zoom: CLUSTER_ZOOM + 2 });
    for (const group of groups.slice(0, 2)) {
      expect(drawnNear(s, "cluster-marker", group)).toEqual([]);
      expect(singlesNear(s, "marker", group)).toBe(group.points.length);
    }
  });
});

describe("clusters drawn like the points, icons by category", () => {
  const [majority, tie, aloneA, aloneB] = CLUSTER_GROUPS.icons;

  it("a cluster draws the icon of the category most of its points have, the first class's on a tie", async () => {
    const s = await scene(labCase("cluster-icons"));
    // The single points of each category show what that category's icon is on the map.
    const [iconA] = drawnNear(s, "icon", aloneA).map(imageOf);
    const [iconB] = drawnNear(s, "icon", aloneB).map(imageOf);
    expect(iconA).toBeTruthy();
    expect(iconB).toBeTruthy();
    expect(iconA).not.toBe(iconB);

    // Three of A and one of B.
    expect(imageOf(clusterNear(s, "cluster-icon", majority))).toBe(iconA);
    // Two of each, the B points first: the first class, A.
    expect(imageOf(clusterNear(s, "cluster-icon", tie))).toBe(iconA);
  });

  it("the badge sits at the marker's upper right in the badge color, its number in the label color", async () => {
    const s = await scene(labCase("cluster-icons"));
    const badge = clusterEntry(s)?.swatch.badge;
    expect(badge).toBeDefined();
    for (const group of [majority, tie]) {
      const drawn = clusterNear(s, "cluster-badge", group);
      expect(drawn.properties.point_count).toBe(group.points.length);
      expect(textOf(drawn)).toBe(String(group.points.length));
      const [dx, dy] = drawn.layer.layout?.["icon-offset"] as [number, number];
      expect(dx).toBeGreaterThan(0);
      expect(dy).toBeLessThan(0);
      const image = parseMarkerImage(imageOf(drawn));
      expect(image, imageOf(drawn)).not.toBeNull();
      expect(hex(image!.fill)).toBe(hex(badge!.color));
      expect(hex(image!.stroke)).toBe(hex(badge!.ring));
      expect(hex(drawn.layer.paint?.["text-color"])).toBe(hex(badge!.text));
    }
  });
});

describe("cluster values from a field", () => {
  it("a label showing the sum of a field shows the sum of the group's values", async () => {
    const s = await scene(labCase("cluster-sum"));
    for (const group of CLUSTER_GROUPS.sum) {
      const sum = group.points.reduce((total, p) => total + Number(p.amount), 0);
      expect(textOf(clusterNear(s, "cluster-label", group))).toBe(String(sum));
    }
  });

  it("a size by the mean follows the mean, within the legend's sizes", async () => {
    const s = await scene(labCase("cluster-mean"));
    const sizesRow = s.legend?.sections.find((sec) => sec.kind === "sizes");
    expect(sizesRow?.kind).toBe("sizes");
    const legendSizes =
      sizesRow?.kind === "sizes" ? sizesRow.samples.map((sample) => Number(sample.swatch.marker?.size)) : [];
    const [smallest, largest] = [Math.min(...legendSizes), Math.max(...legendSizes)];

    const means = CLUSTER_GROUPS.mean.map(
      (group) => group.points.reduce((total, p) => total + Number(p.amount), 0) / group.points.length
    );
    const sizes = CLUSTER_GROUPS.mean.map((group, i) => {
      expect(textOf(clusterNear(s, "cluster-label", group))).toBe(String(means[i]));
      return diameter(clusterNear(s, "cluster-marker", group));
    });
    for (const d of sizes) {
      expect(d).toBeGreaterThanOrEqual(smallest - 0.5);
      expect(d).toBeLessThanOrEqual(largest + 0.5);
    }
    expect(means[1]).toBeGreaterThan(means[0]);
    expect(sizes[1]).toBeGreaterThan(sizes[0]);
  });
});

it("a count of 1,234 points reads 1.2 k", async () => {
  const s = await scene(labCase("cluster-short"));
  const [group] = CLUSTER_GROUPS.short;
  expect(clusterNear(s, "cluster-marker", group).properties.point_count).toBe(1234);
  expect(textOf(clusterNear(s, "cluster-label", group))).toBe("1.2 k");
});

describe("a change of the cluster settings clusters the loaded points again", () => {
  const [group] = CLUSTER_GROUPS.circle;

  /** Applies the case with its render changed over the scene, recording the sources added and removed. */
  async function change(s: Scene, render: JsonObject): Promise<string[]> {
    const calls: string[] = [];
    const { addSource, removeSource } = s.map;
    s.map.addSource = (id, source) => {
      calls.push(`add ${id}`);
      return addSource.call(s.map, id, source);
    };
    s.map.removeSource = (id) => {
      calls.push(`remove ${id}`);
      return removeSource.call(s.map, id);
    };
    const style = { ...s.style, render: { ...(s.style.render as JsonObject), ...render } };
    const next = compileLayer({ ...s.input!, style: style as unknown as LayerStyle });
    applyCompiled(s.map, s.compiled, next);
    await until(s, () => drawnNear(s, "cluster-marker", group).length === 0);
    return calls;
  }

  it("a new until zoom draws single points at the map's zoom, from the same source", async () => {
    const s = await scene(labCase("cluster-circle"));
    const source = s.map.getSource(s.input!.id);
    expect(clusterNear(s, "cluster-marker", group).properties.point_count).toBe(group.points.length);

    expect(await change(s, { cluster_until_zoom: CLUSTER_ZOOM })).toEqual([]);

    expect(s.map.getSource(s.input!.id)).toBe(source);
    expect(drawnNear(s, "cluster-marker", group)).toEqual([]);
    expect(singlesNear(s, "marker", group)).toBe(group.points.length);
  });

  it("a merge distance below the points' spacing draws them one by one, from the same source", async () => {
    const s = await scene(labCase("cluster-circle"));
    const source = s.map.getSource(s.input!.id);

    expect(await change(s, { radius: 1 })).toEqual([]);

    expect(s.map.getSource(s.input!.id)).toBe(source);
    expect(drawnNear(s, "cluster-marker", group)).toEqual([]);
    expect(singlesNear(s, "marker", group)).toBe(group.points.length);
  });
});
