// Automatic colors, None and transparency on the map, on the land color of the app's Light and of its Dark basemap,
// each scene compiled for that basemap's tone. The generated cases that use one of the new values (legend/caseList.ts
// `buildColorCases`) get the checks every lab case gets, read against that ground; hand-made scenes read the pixels
// each rule decides, with the expected colors taken from the color rules (colors.ts) over the colors the style sets.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labelPair, onColor, shade, textAgainst } from "@/lib/style/colors";
import type { JsonObject } from "@/lib/style/json";

import { known } from "../legend/known";
import { colorLabCases, usesNewColorValue } from "./cases";
import {
  type Rect,
  type Rgb,
  colorMismatches,
  distance,
  drawnHidden,
  missingImages,
  notDrawn,
  over,
  readRect,
} from "./checks";
import {
  LAB_GROUNDS,
  type LabCase,
  type LabGround,
  type LabGroup,
  SAMPLE_SIZE,
  type Scene,
  closeScenes,
  renderScene,
} from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

// The scenes' errors once more: those the map reported after a test changed it.
afterEach(() => {
  expect(closeScenes(scenes)).toEqual([]);
});

async function scene(c: LabCase, ground: LabGround, groups?: LabGroup[]): Promise<Scene> {
  const drawn = await renderScene(c, { ground, ...(groups ? { groups } : {}) });
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

/** How far a drawn channel may be from the expected one, of 255. */
const TOLERANCE = 10;
/** How many pixels of a read must have the expected color: one pixel could be an edge's blend of two colors. */
const MIN_PIXELS = 3;

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** How many pixels of a rectangle of the map are within TOLERANCE of a color. */
const count = (s: Scene, rect: Rect, want: Rgb): number =>
  readRect(s, rect).filter((pixel) => distance(pixel, want) <= TOLERANCE).length;

/** The middle of a sample: clear of its outline. */
const middle = ([x, y]: [number, number]): Rect => ({ x: x - 4, y: y - 4, w: 8, h: 8 });

/** A strip across a polygon sample's left edge, where an outline at the center of the edge is drawn. */
const leftEdge = ([x, y]: [number, number]): Rect => ({
  x: x - SAMPLE_SIZE / 2 - 2,
  y: y - 10,
  w: 4,
  h: 20,
});

const style = (doc: JsonObject): JsonObject => ({ version: "1.0.0", kind: "vector", ...doc });

const labCase = (id: string, geometry: LabCase["geometry"], doc: JsonObject): LabCase => ({
  id,
  style: style(doc),
  geometry,
  zoom: 10,
  fields: { category: "string", name: "string" },
});

/** Categories `a` and `b` of `category`, each with its own fill. */
const twoFills = (a: string, b: string): JsonObject => ({
  id: "kind",
  field: "category",
  method: "categories",
  classes: [
    { values: ["a"], name: "A", fill: { color: a } },
    { values: ["b"], name: "B", fill: { color: b } },
  ],
});

const GREEN = "#2bb381";
const ORANGE = "#d95f02";

const GROUNDS = [LAB_GROUNDS.light, LAB_GROUNDS.dark];

describe.each(GROUNDS.map((g) => [g.name, g] as const))("on the %s ground", (_, ground) => {
  const land = rgb(ground.color);

  it("the map's ground is the basemap's land color, and the compiler gets the basemap's tone", async () => {
    const s = await scene(labCase("ground", "polygon", { symbol: { fill: { color: GREEN } } }), ground);
    expect(count(s, { x: 2, y: 2, w: 6, h: 6 }, land)).toBe(36);
    expect(s.input?.tone).toBe(ground.tone);
    expect(s.ground).toEqual(land);
  });

  it("an Auto outline is the shade of its fill, the fixed one and each class's", async () => {
    const fixed = await scene(
      labCase("outline-fixed", "polygon", {
        symbol: { fill: { color: GREEN }, outline: { color: "auto", width: 6 } },
      }),
      ground
    );
    expect(count(fixed, leftEdge(fixed.placed[0].pixel), rgb(shade(GREEN)))).toBeGreaterThanOrEqual(
      MIN_PIXELS
    );

    const classes = await scene(
      labCase("outline-classes", "polygon", {
        symbol: { fill: { color: "#888888" }, outline: { color: "auto", width: 6 } },
        classify: [twoFills(GREEN, ORANGE)],
      }),
      ground
    );
    const byClass = Object.fromEntries(classes.placed.map((p) => [p.entry.id, p.pixel]));
    for (const [entry, fill] of [
      ["a", GREEN],
      ["b", ORANGE],
    ]) {
      const pixel = classes.placed.find((p) => p.entry.values?.[0] === entry)?.pixel;
      expect(pixel, `${entry} in ${JSON.stringify(byClass)}`).toBeDefined();
      expect(count(classes, leftEdge(pixel!), rgb(shade(fill))), entry).toBeGreaterThanOrEqual(MIN_PIXELS);
    }
  });

  it("a fill at None leaves the ground, and its Auto outline keeps the shade of the layer's color", async () => {
    const s = await scene(
      labCase("fill-none", "polygon", {
        symbol: { fill: { color: `${GREEN}00` }, outline: { color: "auto", width: 6 } },
      }),
      ground
    );
    const pixel = s.placed[0].pixel;
    expect(count(s, middle(pixel), land)).toBe(64);
    expect(count(s, leftEdge(pixel), rgb(shade(GREEN)))).toBeGreaterThanOrEqual(MIN_PIXELS);
  });

  it("a class at None leaves the ground, the other class draws its fill", async () => {
    const s = await scene(
      labCase("class-none", "polygon", {
        symbol: { fill: { color: "#888888" } },
        classify: [twoFills(GREEN, `${ORANGE}00`)],
      }),
      ground
    );
    const at = (value: string) => s.placed.find((p) => p.entry.values?.[0] === value)!.pixel;
    expect(count(s, middle(at("a")), rgb(GREEN))).toBe(64);
    expect(count(s, middle(at("b")), land)).toBe(64);
  });

  it("a color at 50 % blends with the ground", async () => {
    const s = await scene(labCase("half", "polygon", { symbol: { fill: { color: `${GREEN}80` } } }), ground);
    const want = over({ color: `${GREEN}80` }, 1, land)!;
    expect(count(s, middle(s.placed[0].pixel), want)).toBe(64);
    // Not the color itself, and not the ground.
    expect(distance(want, rgb(GREEN))).toBeGreaterThan(TOLERANCE);
    expect(distance(want, land)).toBeGreaterThan(TOLERANCE);
  });

  it("an Auto casing is the shade of its line", async () => {
    const s = await scene(
      labCase("casing", "line", {
        symbol: { line: { color: ORANGE, width: 6 }, casing: { color: "auto", width: 3 } },
      }),
      ground
    );
    const [x, y] = s.placed[0].pixel;
    // The casing lies 3 to 6 px from the line's middle, on both sides.
    const above: Rect = { x: x - 20, y: y - 5.5, w: 40, h: 2 };
    expect(count(s, above, rgb(shade(ORANGE)))).toBeGreaterThanOrEqual(MIN_PIXELS);
    expect(count(s, { x: x - 20, y: y - 1, w: 40, h: 2 }, rgb(ORANGE))).toBeGreaterThanOrEqual(MIN_PIXELS);
  });

  /** A large bold label on one point, its text and halo set by `label`, over a small marker in `color`. */
  const labelled = (id: string, color: string, label: JsonObject): LabCase =>
    labCase(id, "point", {
      symbol: {
        marker: { shape: "circle", color, size: 4 },
        label: {
          text: "WWW",
          size: 32,
          font: { weight: "bold" },
          placement: "center",
          ...label,
          halo: { width: 4, ...(label.halo as JsonObject) },
        },
      },
    });
  const LABEL_AT: LabGroup[] = [{ at: [320, 240], points: [{}] }];
  const LABEL_BOX: Rect = { x: 250, y: 210, w: 140, h: 60 };

  it.each([GREEN, "#ffd23f", "#1f3a93"])(
    "a label with text and halo on Auto draws the label pair of %s for the basemap",
    async (color) => {
      const pair = labelPair(color, ground.tone);
      // At halo width 0 the text alone is drawn, in the pair's text color: which of the two is the text.
      const bare = await scene(
        labelled("pair-text", color, { color: "auto", halo: { color: "auto", width: 0 } }),
        ground,
        LABEL_AT
      );
      expect(count(bare, LABEL_BOX, rgb(pair.text)), `text ${pair.text}`).toBeGreaterThanOrEqual(40);
      expect(count(bare, LABEL_BOX, rgb(pair.halo)), `no halo ${pair.halo}`).toBeLessThan(MIN_PIXELS);
      const s = await scene(
        labelled("pair", color, { color: "auto", halo: { color: "auto" } }),
        ground,
        LABEL_AT
      );
      expect(count(s, LABEL_BOX, rgb(pair.text)), `text ${pair.text}`).toBeGreaterThanOrEqual(40);
      expect(count(s, LABEL_BOX, rgb(pair.halo)), `halo ${pair.halo}`).toBeGreaterThanOrEqual(40);
    }
  );

  it.each([GREEN, "#ffd23f", "#1f3a93"])(
    "a label with text on Auto beside a white halo set by hand draws the text read on that halo, for %s",
    async (color) => {
      const s = await scene(
        labelled("white-halo", color, { color: "auto", halo: { color: "#ffffff" } }),
        ground,
        LABEL_AT
      );
      const text = textAgainst(color, "#ffffff", ground.tone);
      expect(count(s, LABEL_BOX, rgb(text)), `text ${text}`).toBeGreaterThanOrEqual(40);
      expect(count(s, LABEL_BOX, rgb("#ffffff"))).toBeGreaterThanOrEqual(40);
    }
  );

  it.each(["#ffd23f", GREEN, "#f28e2b", "#1f3a93", "#000000"])(
    "an Auto icon on a %s marker is white or dark, whichever reads on it",
    async (color) => {
      const s = await scene(
        labCase("icon", "point", {
          symbol: { marker: { shape: "circle", color, size: 40, icon: "goat:park", icon_color: "auto" } },
        }),
        ground
      );
      const [x, y] = s.placed[0].pixel;
      const box: Rect = { x: x - 12, y: y - 12, w: 24, h: 24 };
      const want = onColor(color);
      const other = want === "#ffffff" ? "#3a3541" : "#ffffff";
      expect(count(s, box, rgb(want)), want).toBeGreaterThanOrEqual(20);
      expect(count(s, box, rgb(other)), other).toBeLessThan(MIN_PIXELS);
    }
  );
});

/** Takes the labels of the features off the map and waits until the map has drawn without them: a point's label sits
 * on its sample's middle, where the sample's color is read. The label layer is the one `labelLayers` makes
 * (compile/labels.ts, part "label": id `<layer>-label`); a cluster's number is another part and stays. The labels'
 * colors are read by the scenes above. */
async function hideFeatureLabels(s: Scene): Promise<void> {
  const id = `${s.input?.id}-label`;
  if (!s.map.getLayer(id)) return;
  s.map.setLayoutProperty(id, "visibility", "none");
  const idle = s.map.once("idle");
  s.map.triggerRepaint();
  await idle;
}

describe("generated cases with an automatic color, None or a transparency", () => {
  const cases = colorLabCases().filter((c) => usesNewColorValue(c.legendCase!));

  it("are drawn: every generated case that uses a new value and that the lab can draw", () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  // Each case is drawn as generated, labels included, and checked so: what it reports, the images it asks for, every
  // sample drawn where it is placed (a label never counts as its marker: features are found by id on their own
  // layers) and none drawn that its class hides. Its colors are read with the labels taken off.
  it.each(cases.flatMap((c) => GROUNDS.map((g) => [c.id, g.name, c, g] as const)))(
    "%s on the %s ground",
    async (_, __, c, ground) => {
      const s = await renderScene(c, { ground });
      scenes.push(s);
      const drawn = {
        missingImages: missingImages(s),
        notDrawn: notDrawn(s).map((p) => `${p.section}/${p.entry.id}`),
        drawnHidden: drawnHidden(s).map((p) => `${p.section}/${p.entry.id}`),
      };
      await hideFeatureLabels(s);
      const found = { errors: s.errors, ...drawn, colorMismatches: colorMismatches(s) };
      const difference = known("lab", c.legendCase!);
      const expected = { errors: [], missingImages: [], notDrawn: [], drawnHidden: [], colorMismatches: [] };
      if (difference?.finding) {
        expect(found[difference.finding].length, difference.reason).toBeGreaterThan(0);
        expect({ ...found, [difference.finding]: [] }).toEqual(expected);
      } else expect(found).toEqual(expected);
    }
  );
});

// The one place a point's label still hides its own marker (legend/known.ts): the label on the marker by choice. Once
// both are drawn, this turns red until the known difference is removed.
describe("a label on a marker that collides", () => {
  it("placement center on an icon: the label hides it, a known difference", async () => {
    const c = {
      id: "collide",
      style: {
        version: "1.0.0",
        kind: "vector",
        symbol: {
          marker: { shape: "icon", icon: "goat:park", size: 24 },
          label: { text: "{name}", placement: "center" },
        },
      },
      geometry: "point" as const,
      zoom: 10,
      fields: { name: "string" as const },
    };
    expect(known("lab", c)?.finding).toBe("notDrawn");
    const s = await renderScene(c, { groups: [{ at: [320, 240], points: [{ name: "Town Hall" }] }] });
    scenes.push(s);
    expect(s.errors).toEqual([]);
    const count = (part: string) => s.map.queryRenderedFeatures({ layers: [`collide-${part}`] }).length;
    expect({ marker: count("icon"), label: count("label") }).toEqual({ marker: 0, label: 1 });
  });
});

/** Areas in three classes, outlined on Auto and labelled with text and halo on Auto: one class at None, one at 50 %. */
const AREAS = labCase("auto-colors-areas", "polygon", {
  symbol: {
    fill: { color: "#888888" },
    outline: { color: "auto", width: 3 },
    label: { text: "{category}", color: "auto", halo: { color: "auto" } },
  },
  classify: [
    {
      id: "kind",
      field: "category",
      method: "categories",
      classes: [
        { values: ["Forest"], name: "Forest", fill: { color: GREEN } },
        { values: ["Lake"], name: "Lake", fill: { color: "#1f3a9300" } },
        { values: ["Field"], name: "Field", fill: { color: `${ORANGE}80` } },
      ],
    },
  ],
});

/** Points in three colors with a label that starts with text and halo on Auto. */
const POINT_LABELS = labCase("auto-colors-point-labels", "point", {
  symbol: {
    marker: { shape: "circle", color: GREEN, size: 10 },
    label: { text: "{name}", color: "auto", halo: { color: "auto" } },
  },
  classify: [
    {
      id: "kind",
      field: "category",
      method: "categories",
      classes: [
        { values: ["a"], name: "Green", marker: { color: GREEN } },
        { values: ["b"], name: "Yellow", marker: { color: "#ffd23f" } },
        { values: ["c"], name: "Dark blue", marker: { color: "#1f3a93" } },
      ],
    },
  ],
});

const NAMED_POINTS: LabGroup[] = [
  { at: [140, 200], points: [{ category: "a", name: "Riverside Park" }] },
  { at: [320, 200], points: [{ category: "b", name: "Hill Street School" }] },
  { at: [500, 200], points: [{ category: "c", name: "Central Station" }] },
];

// A small set of scenes compared with screenshots (as screenshots.lab.test.tsx does), on both grounds: areas with an
// Auto outline, None and a transparency, and point labels on Auto. Baselines are made on Linux.
describe.skipIf(!navigator.userAgent.includes("Linux"))("screenshots", () => {
  it.each(
    GROUNDS.flatMap((ground) => [
      [`auto-colors-areas-${ground.name}`, AREAS, ground, undefined] as const,
      [`auto-colors-point-labels-${ground.name}`, POINT_LABELS, ground, NAMED_POINTS] as const,
    ])
  )("%s", async (name, c, ground, groups) => {
    const s = await scene(c, ground, groups);
    await expect(s.root).toMatchScreenshot(name);
  });
});
