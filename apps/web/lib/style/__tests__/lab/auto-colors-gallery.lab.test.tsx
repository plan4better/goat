// The gallery of automatic colors, None and transparency: hand-made scenes for each rule and every generated case of
// the colors (legend/caseList.ts `buildColorCases`), each drawn by the lab on the Light, Dark and Satellite basemaps
// with the app's legend beside it, written as one self-contained page for looking at. Not a check: it runs only when
// asked, and writes the page to the path given.
//
//   AUTO_COLORS_GALLERY=/path/to/page.html [AUTO_COLORS_GALLERY_GROUNDS=/path/to/grounds] \
//     pnpm --filter @p4b/web lab lib/style/__tests__/lab/auto-colors-gallery.lab.test.tsx
//
// The grounds folder holds light.png, dark.png and satellite.png (640 x 480 at 2x) and a README.txt whose lines are
// printed at the page's foot (the pictures' attribution); without it the maps are drawn on plain colors. Both paths
// must lie inside the repository's folder, as the browser's file commands reach no further: a folder under the
// git-ignored `.superpowers/` keeps the pictures and the page out of the repository's files.
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";

import { DARK, LIGHT } from "@/lib/style/colors";
import { startingLabel } from "@/lib/style/editor/labels";
import { type JsonObject, isObject } from "@/lib/style/json";

import generatedCases from "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/legend_cases.json";
import { type GeneratedCases, type LegendCase, buildColorCases } from "../legend/caseList";
import { colorLabCases } from "./cases";
import facts from "./fixtures/h3/facts.json";
import styles from "./fixtures/h3/styles.json";
import {
  LAB_GROUNDS,
  type LabCase,
  type LabGround,
  type LabGroup,
  MAP,
  closeScenes,
  renderScene,
} from "./scene";

// Asked for by hand only: no build or cached task reads them (the lab config passes them in).
const ENV = process.env as Record<string, string | undefined>;
// eslint-disable-next-line turbo/no-undeclared-env-vars
const OUT = ENV.AUTO_COLORS_GALLERY;
// eslint-disable-next-line turbo/no-undeclared-env-vars
const GROUNDS_DIR = ENV.AUTO_COLORS_GALLERY_GROUNDS;

/** The page's largest size: every picture is inline. */
const MAX_BYTES = 14 * 1024 * 1024;
const WHOLE_MAP = { x: 0, y: 0, w: MAP.width, h: MAP.height };
const GROUND_NAMES = ["light", "dark", "satellite"] as const;
type GroundName = (typeof GROUND_NAMES)[number];
const GROUND_LABEL: Record<GroundName, string> = {
  light: "Light map",
  dark: "Dark map",
  satellite: "Satellite",
};

type Box = { x: number; y: number; w: number; h: number };

/** How a scene is turned into a picture: the map's device pixels per CSS pixel, the share of them kept, the WebP
 * quality, and the part of the map shown (around the features where none is given). */
interface Shot {
  pixelRatio: number;
  scale: number;
  quality: number;
  crop?: Box;
}

const LARGE: Shot = { pixelRatio: 2, scale: 1, quality: 0.92 };
const MEDIUM: Shot = { pixelRatio: 2, scale: 0.75, quality: 0.8 };
const COMPACT: Shot = { pixelRatio: 2, scale: 0.6, quality: 0.75 };

interface Picture {
  caption: string;
  src: string;
  width: number;
  height: number;
}

interface Tile {
  title: string;
  note?: string;
  id?: string;
  pictures: Picture[];
  legend?: Picture;
  keys: string[];
}

interface Section {
  id: string;
  title: string;
  intro: string;
  tiles: Tile[];
  /** Tiles laid out wide (the decision) or in a compact grid (the generated cases). */
  layout?: "wide" | "compact";
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const style = (doc: JsonObject): JsonObject => ({ version: "1.0.0", kind: "vector", ...doc });

const FIELDS = { name: "string", category: "string", amount: "number" } as const;

/** A hand-made case; its id is the layer's name the legend shows. */
const labCase = (name: string, geometry: LabCase["geometry"], doc: JsonObject, zoom = 10): LabCase => ({
  id: name,
  style: style(doc),
  geometry,
  zoom,
  fields: { ...FIELDS },
});

/** Categories of `category`, one class per entry, each with its own part. */
const classesOf = (part: string, entries: Array<[string, JsonObject]>): JsonObject => ({
  id: "kind",
  field: "category",
  method: "categories",
  classes: entries.map(([name, own]) => ({ values: [name], name, [part]: own })),
});

const GREEN = "#2bb381";
const YELLOW = "#ffd23f";
const ORANGE = "#f28e2b";
const BLUE = "#1f3a93";
const BLACK = "#000000";

// ---------------------------------------------------------------------------------------------------------------------
// Pictures

/** The part of the map the features of a scene take, with room for an outline and a label, inside the map. */
function aroundFeatures(points: Array<[number, number]>, reach: { x: number; y: number }): Box {
  if (!points.length) return WHOLE_MAP;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x0 = Math.max(0, Math.min(...xs) - reach.x);
  const y0 = Math.max(0, Math.min(...ys) - reach.y);
  const x1 = Math.min(MAP.width, Math.max(...xs) + reach.x);
  const y1 = Math.min(MAP.height, Math.max(...ys) + reach.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The map's canvas, cut to `crop` and scaled, as a WebP picture. */
function picture(canvas: HTMLCanvasElement, ratio: number, crop: Box, shot: Shot, caption: string): Picture {
  const width = Math.round(crop.w * ratio * shot.scale);
  const height = Math.round(crop.h * ratio * shot.scale);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const context = out.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    canvas,
    crop.x * ratio,
    crop.y * ratio,
    crop.w * ratio,
    crop.h * ratio,
    0,
    0,
    width,
    height
  );
  return { caption, src: out.toDataURL("image/webp", shot.quality), width, height };
}

/** The legend the scene drew beside its map, as the browser shows it; none where the layer has no legend. */
async function legendPicture(root: HTMLElement): Promise<Picture | undefined> {
  const legend = root.querySelector<HTMLElement>("[data-lab-legend]");
  if (!legend || !legend.childElementCount) return undefined;
  const { width, height } = legend.getBoundingClientRect();
  const base64 = (await page.screenshot({ element: legend, save: false })) as unknown as string;
  return { caption: "Legend", src: `data:image/png;base64,${base64}`, width, height };
}

/** Errors of every scene drawn, by tile: the page is written anyway, and the test fails on them afterwards. */
const sceneErrors: string[] = [];

/** Draws a case on each ground and takes its pictures, and its legend once; `closeUp` also takes that part of each
 * map at its full size. */
async function drawTile(
  c: LabCase,
  grounds: Record<GroundName, LabGround>,
  shot: Shot,
  opts: { groups?: LabGroup[]; reach?: { x: number; y: number }; closeUp?: Box } = {}
): Promise<{ pictures: Picture[]; legend?: Picture; closeUps: Picture[] }> {
  const pictures: Picture[] = [];
  const closeUps: Picture[] = [];
  let legend: Picture | undefined;
  for (const name of GROUND_NAMES) {
    const s = await renderScene(c, {
      ground: grounds[name],
      pixelRatio: shot.pixelRatio,
      ...(opts.groups ? { groups: opts.groups } : {}),
    });
    const groups = opts.groups ?? c.groups;
    const points = s.placed.length ? s.placed.map((p) => p.pixel) : (groups ?? []).map((g) => g.at);
    // One feature alone gets more of the map around it, kept at its full size: a small crop scaled up looks soft.
    const single = points.length === 1 && !shot.crop;
    const reach = opts.reach ?? (single ? { x: 120, y: 90 } : { x: 70, y: 56 });
    const crop = shot.crop ?? aroundFeatures(points, reach);
    const kept = single ? { ...shot, scale: 1 } : shot;
    pictures.push(picture(s.map.getCanvas(), s.map.getPixelRatio(), crop, kept, GROUND_LABEL[name]));
    if (opts.closeUp)
      closeUps.push(
        picture(s.map.getCanvas(), s.map.getPixelRatio(), opts.closeUp, shot, GROUND_LABEL[name])
      );
    if (!legend) legend = await legendPicture(s.root);
    sceneErrors.push(...closeScenes([s]).map((error) => `${c.id} on ${name}: ${error}`));
  }
  return { pictures, legend, closeUps };
}

/** A tile's pictures and legend from what `drawTile` took. */
const shown = (drawn: { pictures: Picture[]; legend?: Picture }): Pick<Tile, "pictures" | "legend"> => ({
  pictures: drawn.pictures,
  ...(drawn.legend ? { legend: drawn.legend } : {}),
});

// ---------------------------------------------------------------------------------------------------------------------
// The style lines shown with a tile: its color keys.

/** Each color key of a style (a key ending in `color`, a palette) with its value, as `path: value`, and with
 * `opacity` its opacity keys too (where a tile compares the two); the computed record a classification keeps for its
 * colors is left out. */
function colorKeys(doc: JsonObject, opts: { opacity?: boolean } = {}): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((item, i) => visit(item, `${path}[${i}]`));
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "computed") continue;
      const at = path ? `${path}.${key}` : key;
      if (key.endsWith("color") || key === "palette" || (opts.opacity && key === "opacity"))
        out.push(`${at}: ${JSON.stringify(value)}`);
      else visit(value, at);
    }
  };
  visit(doc, "");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 1: the starting halo of a point label.

const PLACES: Array<[string, string, [number, number]]> = [
  ["Parks", "Riverside Park", [110, 92]],
  ["Schools", "Hill Street School", [300, 120]],
  ["Stations", "Central Station", [500, 86]],
  ["Schools", "St. Anna School", [140, 230]],
  ["Stations", "Market Square", [340, 250]],
  ["Parks", "Old Town Garden", [520, 220]],
  ["Stations", "North Bridge", [100, 380]],
  ["Parks", "Sports Ground", [300, 390]],
  ["Schools", "Library", [500, 360]],
];

const PLACE_GROUPS: LabGroup[] = PLACES.map(([category, name, at]) => ({
  at,
  points: [{ category, name }],
}));

/** A point layer as it starts (a circle of size 10) in three colors by category, with the label a switch turns on:
 * text and halo from `startingLabel`, the size and placement left as they start, and the halo color given. */
function pointLabels(name: string, halo: string): LabCase {
  const label = startingLabel("point");
  return labCase(name, "point", {
    symbol: {
      marker: { shape: "circle", color: GREEN, size: 10 },
      label: { ...label, text: "{name}", halo: { ...(label.halo as JsonObject), color: halo } },
    },
    classify: [
      classesOf("marker", [
        ["Parks", { color: GREEN }],
        ["Schools", { color: YELLOW }],
        ["Stations", { color: BLUE }],
      ]),
    ],
  });
}

async function decision(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const auto = pointLabels("Places", "auto");
  const white = pointLabels("Places", LIGHT);
  // The names in the map's upper left, shown again at twice the size.
  const closeUp = aroundFeatures(
    PLACES.filter(([, , [x, y]]) => x < 320 && y < 240).map(([, , at]) => at),
    { x: 90, y: 40 }
  );
  const opts = { groups: PLACE_GROUPS, closeUp };
  const drawnAuto = await drawTile(auto, grounds, { ...LARGE, crop: WHOLE_MAP }, opts);
  const drawnWhite = await drawTile(white, grounds, { ...LARGE, crop: WHOLE_MAP }, opts);
  const tiles: Tile[] = GROUND_NAMES.flatMap((name, i): Tile[] => [
    {
      title: GROUND_LABEL[name],
      ...(name === "light"
        ? { note: "On the Light map the two are the same: Auto gives a white halo there." }
        : {}),
      pictures: [
        { ...drawnAuto.pictures[i], caption: "Halo Auto" },
        { ...drawnWhite.pictures[i], caption: "Halo white" },
      ],
      keys: [],
    },
    {
      title: `${GROUND_LABEL[name]}, close up at twice the size`,
      pictures: [
        { ...drawnAuto.closeUps[i], caption: "Halo Auto" },
        { ...drawnWhite.closeUps[i], caption: "Halo white" },
      ],
      keys: [],
    },
  ]);
  tiles.push({
    title: "What both draw",
    note:
      "The same layer twice: points in green, yellow and dark blue by category, label size 12 placed beside the " +
      "point, text on Auto. Only the halo's color differs.",
    pictures: [],
    ...(drawnAuto.legend ? { legend: drawnAuto.legend } : {}),
    keys: [
      "Halo Auto:",
      ...colorKeys(auto.style).filter((line) => line.includes("label")),
      "Halo white:",
      ...colorKeys(white.style).filter((line) => line.includes("label")),
    ],
  });
  return {
    id: "decide",
    title: "Decide: a point label's halo",
    intro:
      "A new point label starts with its text on Auto. Its halo can start on Auto too, as on lines and areas, or " +
      "plain white. Each row shows the same points on one map, Auto on the left and white on the right: pick the " +
      "one whose names read best on all three.",
    tiles,
    layout: "wide",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The second decision: the outline of a hexagon grid.

/** A hexagon layer over the lab's H3 tiles (fixtures/h3, as h3.lab.test.tsx draws them): the count of points in each
 * hexagon on the default palette, so neighbouring hexagons differ, with `outline` as given. */
function hexagons(outline: JsonObject | undefined): LabCase {
  const { classify: _classify, ...render } = styles.classes.render as JsonObject;
  return {
    id: "Hexagons",
    style: { ...(styles.classes as JsonObject), render: { ...render, ...(outline ? { outline } : {}) } },
    geometry: "point",
    zoom: facts.zoom,
    fields: { pop: "number" },
    source: { type: "tiles", id: "Hexagons", tiles: [`${location.origin}/lab-h3/{z}/{x}/{y}.pbf`] },
  };
}

async function hexagonDecision(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const white = hexagons(undefined);
  const auto = hexagons({ color: "auto" });
  // The map's middle, shown again at twice the size.
  const closeUp: Box = { x: MAP.width / 3, y: MAP.height / 3, w: MAP.width / 3, h: MAP.height / 3 };
  const drawnWhite = await drawTile(white, grounds, { ...LARGE, crop: WHOLE_MAP }, { closeUp });
  const drawnAuto = await drawTile(auto, grounds, { ...LARGE, crop: WHOLE_MAP }, { closeUp });
  const tiles: Tile[] = GROUND_NAMES.flatMap((name, i): Tile[] => [
    {
      title: GROUND_LABEL[name],
      pictures: [
        { ...drawnWhite.pictures[i], caption: "Outline white" },
        { ...drawnAuto.pictures[i], caption: "Outline Auto" },
      ],
      keys: [],
    },
    {
      title: `${GROUND_LABEL[name]}, close up at twice the size`,
      pictures: [
        { ...drawnWhite.closeUps[i], caption: "Outline white" },
        { ...drawnAuto.closeUps[i], caption: "Outline Auto" },
      ],
      keys: [],
    },
  ]);
  tiles.push({
    title: "What both draw",
    note:
      "The same hexagons twice, colored by how many points fall in each. The left one has no outline color set, " +
      "so it draws the white outline of 1 px a new hexagon layer starts with; the right one sets the outline to Auto.",
    pictures: [],
    ...(drawnWhite.legend ? { legend: drawnWhite.legend } : {}),
    keys: ["Outline white:", "render.outline: not set", "Outline Auto:", 'render.outline.color: "auto"'],
  });
  return {
    id: "decide-hexagons",
    title: "Decide: a hexagon grid's outline",
    intro:
      "A new hexagon layer draws a thin white line around every hexagon. With Auto each hexagon gets an edge in a " +
      "darker shade of its own color instead. Look at whether you prefer even white grid lines or edges that " +
      "belong to each hexagon, on all three maps.",
    tiles,
    layout: "wide",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 2: an icon on a marker and a cluster's number.

const MARKER_COLORS: Array<[string, string]> = [
  ["Yellow", YELLOW],
  ["GOAT green", GREEN],
  ["Mid orange", ORANGE],
  ["Dark blue", BLUE],
  ["Black", BLACK],
];

const spread = (at: [number, number], n: number): LabGroup => ({
  at,
  points: Array.from({ length: n }, () => ({ amount: 1 })),
});

const CLUSTER_GROUPS: LabGroup[] = [
  spread([120, 120], 1),
  spread([240, 120], 1),
  spread([380, 120], 12),
  spread([520, 120], 150),
];

const iconMarker = (color: string): JsonObject => ({
  shape: "circle",
  color,
  size: 28,
  icon: "goat:park",
  icon_color: "auto",
});

async function iconsAndNumbers(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const tiles: Tile[] = [];
  const band = aroundFeatures(
    CLUSTER_GROUPS.map((g) => g.at),
    { x: 50, y: 44 }
  );
  for (const [name, color] of MARKER_COLORS) {
    const c = labCase("Markers", "point", {
      symbol: { marker: iconMarker(color) },
      render: {
        type: "cluster",
        radius: 40,
        symbol: {
          marker: { shape: "circle", color, size: 36 },
          label: { text: "{count}", color: "auto", size: 14 },
        },
      },
    });
    const drawn = await drawTile(c, grounds, { ...MEDIUM, crop: band }, { groups: CLUSTER_GROUPS });
    tiles.push({
      title: `${name} ${color}: icons and clusters`,
      pictures: drawn.pictures,
      ...(drawn.legend ? { legend: drawn.legend } : {}),
      keys: colorKeys(c.style),
    });
    const badge = labCase("Markers", "point", {
      symbol: { marker: iconMarker(color) },
      render: {
        type: "cluster",
        radius: 40,
        look: "points",
        count: "badge",
        symbol: { marker: { color }, label: { text: "{count}", color: "auto" } },
      },
    });
    const drawnBadge = await drawTile(badge, grounds, { ...MEDIUM, crop: band }, { groups: CLUSTER_GROUPS });
    tiles.push({
      title: `${name} ${color}: a cluster as a marker with a count badge`,
      pictures: drawnBadge.pictures,
      ...(drawnBadge.legend ? { legend: drawnBadge.legend } : {}),
      keys: colorKeys(badge.style),
    });
  }
  return {
    id: "icons",
    title: "The icon and the cluster's number",
    intro:
      "An icon on a marker and the number on a cluster are white on a dark color and dark grey on a light one. " +
      "The switch happens at medium brightness, so yellow gets dark grey while GOAT green and a mid orange still " +
      "get white. Each row shows two single markers and two clusters, then the same as markers with a count badge.",
    tiles,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 3: outlines and casings.

const AMOUNTS: LabGroup[] = [5, 30, 55, 80, 100].map((amount, i) => ({
  at: [80 + 120 * i, 240] as [number, number],
  points: [{ amount }],
}));

const PALETTE = {
  field: "amount",
  palette: ["#ffffcc", "#41b6c4", "#081d58"],
  title: "Amount",
  computed: { at: "2026-01-01T00:00:00Z", data: "synthetic-v1", scope: "dataset", domain: [0, 100] },
};

const FOUR_FILLS: Array<[string, JsonObject]> = [
  ["Meadow", { color: "#b8e186" }],
  ["Forest", { color: GREEN }],
  ["Water", { color: "#4393c3" }],
  ["Housing", { color: "#d6604d" }],
];

async function outlines(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const scenes: Array<[string, string, LabCase, LabGroup[]?]> = [
    [
      "Auto outline on one fill color",
      "A new area layer starts like this: the fill at 80 %, the outline a darker shade of it.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: GREEN, opacity: 0.8 }, outline: { color: "auto", width: 1 } },
      }),
    ],
    [
      "Auto outline on classes",
      "Each class gets the darker shade of its own color.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: "#888888" }, outline: { color: "auto", width: 2 } },
        classify: [classesOf("fill", FOUR_FILLS)],
      }),
    ],
    [
      "Auto outline on a palette over a number",
      "The outline follows the palette from light to dark, area by area.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: PALETTE }, outline: { color: "auto", width: 2 } },
      }),
      AMOUNTS,
    ],
    [
      "Fill at None, outline on Auto",
      "No fill is drawn; the outline keeps the darker shade of the layer's color.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: `${GREEN}00` }, outline: { color: "auto", width: 2 } },
      }),
    ],
    [
      "One class at None",
      "The class Water draws no fill; its Auto outline keeps a darker shade of the class's own color.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: "#888888" }, outline: { color: "auto", width: 2 } },
        classify: [
          classesOf("fill", [
            ["Meadow", { color: "#b8e186" }],
            ["Forest", { color: GREEN }],
            ["Water", { color: "#4393c300" }],
            ["Housing", { color: "#d6604d" }],
          ]),
        ],
      }),
    ],
    [
      "A line with an Auto casing",
      "The casing on both sides of each line is a darker shade of that line's color.",
      labCase("Roads", "line", {
        symbol: { line: { color: "#888888", width: 5 }, casing: { color: "auto", width: 2 } },
        classify: [
          classesOf("line", [
            ["Main road", { color: ORANGE }],
            ["Path", { color: YELLOW }],
            ["Rail", { color: BLUE }],
          ]),
        ],
      }),
    ],
  ];
  const tiles: Tile[] = [];
  for (const [title, note, c, groups] of scenes) {
    const drawn = await drawTile(c, grounds, MEDIUM, groups ? { groups } : {});
    tiles.push({ title, note, ...shown(drawn), keys: colorKeys(c.style, { opacity: true }) });
  }
  return {
    id: "outlines",
    title: "Outlines and casings",
    intro:
      "An outline or a casing on Auto is a darker shade of the color it borders, and it stays solid when that color " +
      "is see-through or None. Look at whether each edge belongs to its color on every map.",
    tiles,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 4: labels.

const THREE_TONES: Array<[string, string]> = [
  ["Light", "#fde68a"],
  ["Mid", GREEN],
  ["Dark", BLUE],
];

const PAIR = { color: "auto", halo: { color: "auto" } };

async function labels(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const placesBy = (part: string, names: string[]) =>
    classesOf(
      part,
      THREE_TONES.map(([, color], i) => [names[i], { color }])
    );
  const pointGroups = (names: string[]): LabGroup[] =>
    names.map((name, i) => ({
      at: [140 + 180 * i, 240] as [number, number],
      points: [{ category: name, name }],
    }));
  const pointNames = ["Bakery", "Town Hall", "Harbour"];
  const scenes: Array<[string, string, LabCase, LabGroup[]?]> = [
    [
      "Areas: light, mid and dark",
      "Text and halo on Auto over a light yellow, GOAT green and dark blue area.",
      labCase("Areas", "polygon", {
        symbol: { fill: { color: "#888888", opacity: 0.8 }, label: { text: "{category}", ...PAIR } },
        classify: [placesBy("fill", ["Meadow", "Forest", "Lake"])],
      }),
    ],
    [
      "Lines: light, mid and dark",
      "Text and halo on Auto along a light yellow, GOAT green and dark blue line.",
      labCase("Streets", "line", {
        symbol: { line: { color: "#888888", width: 3 }, label: { text: "{category}", size: 11, ...PAIR } },
        classify: [placesBy("line", ["Elm", "Oak", "Ash"])],
      }),
    ],
    [
      "Points: light, mid and dark",
      "Text and halo on Auto beside a light yellow, GOAT green and dark blue marker.",
      labCase("Places", "point", {
        symbol: {
          marker: { shape: "circle", color: "#888888", size: 10 },
          label: { text: "{name}", ...PAIR },
        },
        classify: [placesBy("marker", pointNames)],
      }),
      pointGroups(pointNames),
    ],
    [
      "Halo set by hand: white",
      "Text on Auto beside a white halo: the text is a dark shade of the marker's color on every map.",
      labCase("Places", "point", {
        symbol: {
          marker: { shape: "circle", color: "#888888", size: 10 },
          label: { text: "{name}", color: "auto", halo: { color: LIGHT } },
        },
        classify: [placesBy("marker", pointNames)],
      }),
      pointGroups(pointNames),
    ],
    [
      "Halo set by hand: dark",
      "Text on Auto beside a dark grey halo: the text turns light where the marker's color would not read on it.",
      labCase("Places", "point", {
        symbol: {
          marker: { shape: "circle", color: "#888888", size: 10 },
          label: { text: "{name}", color: "auto", halo: { color: DARK } },
        },
        classify: [placesBy("marker", pointNames)],
      }),
      pointGroups(pointNames),
    ],
  ];
  const tiles: Tile[] = [];
  for (const [title, note, c, groups] of scenes) {
    const drawn = await drawTile(c, grounds, MEDIUM, {
      ...(groups ? { groups } : {}),
      reach: { x: 90, y: 56 },
    });
    tiles.push({ title, note, ...shown(drawn), keys: colorKeys(c.style, { opacity: true }) });
  }
  return {
    id: "labels",
    title: "Labels",
    intro:
      "A label with text and halo on Auto carries its feature's color: on a light map as a dark shade of it in a " +
      "white halo, on a dark map and on satellite as white text in a halo of that shade. Look at whether every name " +
      "reads and still shows which feature it belongs to.",
    tiles,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 5: transparency and opacity.

const STEPS = [0.8, 0.5, 0.2];
const alphaHex = (share: number) =>
  Math.round(share * 255)
    .toString(16)
    .padStart(2, "0");

async function transparency(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const area = (id: string, entries: Array<[string, JsonObject]>) =>
    labCase(id, "polygon", {
      symbol: { fill: { color: GREEN }, outline: { color: "auto", width: 2 } },
      classify: [classesOf("fill", entries)],
    });
  const marker = (id: string, entries: Array<[string, JsonObject]>) =>
    labCase(id, "point", {
      symbol: { marker: { ...iconMarker(GREEN), size: 32 }, outline: { color: "auto", width: 2 } },
      classify: [classesOf("marker", entries)],
    });
  const own: Array<[string, JsonObject]> = [
    ...STEPS.map((share): [string, JsonObject] => [
      `${share * 100} %`,
      { color: `${GREEN}${alphaHex(share)}` },
    ]),
    ["0 %, None", { color: `${GREEN}00` }],
  ];
  const opacity: Array<[string, JsonObject]> = STEPS.map((share) => [
    `Opacity ${share * 100} %`,
    { color: GREEN, opacity: share },
  ]);
  const both: Array<[string, JsonObject]> = STEPS.map((share) => [
    `50 % at opacity ${share * 100} %`,
    { color: `${GREEN}${alphaHex(0.5)}`, opacity: share },
  ]);
  const scenes: Array<[string, string, LabCase]> = [
    [
      "Areas: the color at 80, 50, 20 and 0 %",
      "The color's own transparency; the Auto outline stays solid.",
      area("Areas", own),
    ],
    ["Areas: Opacity 80, 50 and 20 %", "The fill's Opacity with a solid color.", area("Areas", opacity)],
    [
      "Areas: both together",
      "A color at 50 % with an Opacity on top: the two multiply.",
      area("Areas", both),
    ],
    [
      "Markers: the color at 80, 50, 20 and 0 %",
      "The marker's color fades; its icon and its Auto outline stay solid. Look at the icon on the faint markers " +
        "on the Light map: it is chosen for the full color, not for the ground.",
      marker("Markers", own),
    ],
    [
      "Markers: Opacity 80, 50 and 20 %",
      "The marker's Opacity with a solid color: the whole marker fades, its icon and outline too.",
      marker("Markers", opacity),
    ],
    ["Markers: both together", "A color at 50 % with an Opacity on top.", marker("Markers", both)],
  ];
  const tiles: Tile[] = [];
  for (const [title, note, c] of scenes) {
    const drawn = await drawTile(c, grounds, MEDIUM);
    tiles.push({ title, note, ...shown(drawn), keys: colorKeys(c.style, { opacity: true }) });
  }
  return {
    id: "transparency",
    title: "Transparency",
    intro:
      "A color can be made see-through on its own, down to 0 %, which reads None and draws nothing. Opacity is a " +
      "separate setting of the part, and the two multiply. Compare each row with the one below it: the same " +
      "shares, once as the color's own transparency and once as Opacity. On an area the two look alike; on a " +
      "marker the color's transparency leaves its icon and outline solid.",
    tiles,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Section 6: every generated case.

const GEOMETRY_WORDS: Record<string, string> = {
  point_circle: "Points as circles",
  point_pin: "Points as pins with an icon",
  point_icon: "Points as icons",
  line: "Lines",
  polygon: "Areas",
  polygon_raised: "Raised areas",
};
const RENDER_WORDS: Record<string, string> = {
  cluster: "in clusters",
  h3: "Hexagons from points",
  h3_classes: "Hexagons from points, in classes",
};
const METHOD_WORDS: Record<string, string> = {
  categories: "by category",
  quantile: "in classes of equal count",
  manual: "in classes set by hand",
};
const BASE_WORDS: Record<string, string> = {
  fixed: "in one color",
  by_zoom: "in a color that changes with zoom",
  palette: "in a palette over a number",
  data: "in colors read from the data",
};
const AUTO_WORDS: Record<string, string> = {
  "outline.color": "outline",
  "casing.color": "casing",
  "marker.icon_color": "icon",
  "label.color": "label text",
  "label.halo.color": "label halo",
  "cluster.symbol.marker.icon_color": "cluster icon",
  "cluster.symbol.outline.color": "cluster outline",
  "cluster.symbol.label.color": "cluster number",
  "cluster.symbol.label.halo.color": "cluster number's halo",
  "h3.outline.color": "hexagon outline",
};
const LABEL_WORDS: Record<string, string> = {
  plain: "label colors set",
  light: "a light label color set",
  dark: "a dark label color set",
  mid: "a mid grey label color set",
  none: "the label halo at None",
  zoom: "a label color that changes with zoom",
  width: "a halo width that changes with zoom",
};
const NONE_WORDS: Record<string, string> = {
  fill: "fill at None",
  outline: "outline at None",
  marker: "marker at None",
  line: "line at None",
  class: "one class at None",
};
const ALPHA_WORDS: Record<string, string> = {
  fixed: "the color at 60 %",
  class: "class colors at 60 %",
  palette: "palette steps at 60 %",
};
const NAMED_WORDS: Record<string, string> = {
  "focus-class-none": "Review case: one class at None beside Auto outlines",
  "focus-data-color": "Review case: colors read from the data with Auto outline and label",
  "focus-data-halo-by-zoom": "Review case: colors read from the data beside a halo that changes with zoom",
  "limit-palette-blend": "Known limit: label text over a palette beside one set halo",
};

/** Settings of the generated cases the page has no words for: the test fails on any, so a new value of goatlib's
 * generator does not reach the page as an internal name. */
const unnamed = new Set<string>();

/** The words for a setting's value; none for a value that means "not set". */
function word(
  words: Record<string, string>,
  setting: string,
  value: string | undefined,
  unset: string[]
): string {
  if (value === undefined || unset.includes(value)) return "";
  if (!(value in words)) unnamed.add(`${setting}: ${value}`);
  return words[value] ?? "";
}

/** A generated case in plain words: what is drawn, how it is colored, and which colors are on Auto, None or
 * see-through. */
function caseWords(c: LegendCase): { title: string; note: string } {
  const v = c.values ?? {};
  // Hexagons are drawn from the points, whatever the points would look like.
  const what = v.render?.startsWith("h3")
    ? word(RENDER_WORDS, "render", v.render, [])
    : [word(GEOMETRY_WORDS, "geometry", v.geometry, []), word(RENDER_WORDS, "render", v.render, ["features"])]
        .filter(Boolean)
        .join(" ");
  // A classification on the second color: the outline of an area or a point, the casing of a line.
  const second = v.geometry === "line" ? "casings" : "outlines";
  const method = word(METHOD_WORDS, "method", v.method, ["none"]);
  const how = [
    method ? `with ${v.target === "outline_color" ? second : "colors"} ${method}` : "",
    v.rules === "named" ? "with a rule" : "",
  ].filter(Boolean);
  const autos = Object.entries(v)
    .filter(([name, value]) => name.startsWith("auto:") && value === "yes")
    .map(([name]) => word(AUTO_WORDS, "auto", name.slice(5), []));
  const symbol = isObject(c.style.symbol) ? c.style.symbol : {};
  const extras = [
    autos.length ? `Auto: ${autos.join(", ")}` : "",
    isObject(symbol.label) ? word(LABEL_WORDS, "label_colors", v.label_colors, []) : "",
    word(NONE_WORDS, "none", v.none, ["no"]),
    word(ALPHA_WORDS, "alpha", v.alpha, ["no"]),
  ].filter(Boolean);
  return {
    title: NAMED_WORDS[c.id] ?? [what, word(BASE_WORDS, "base", v.base, []), ...how].join(", "),
    note: extras.map((part) => `${part[0].toUpperCase()}${part.slice(1)}.`).join(" "),
  };
}

async function generated(grounds: Record<GroundName, LabGround>): Promise<Section> {
  const drawable = new Map(colorLabCases().map((c) => [c.id, c]));
  const all = buildColorCases(generatedCases as unknown as GeneratedCases);
  const tiles: Tile[] = [];
  for (const c of all) {
    const words = caseWords(c);
    const lab = drawable.get(c.id);
    const keys = colorKeys(c.style);
    if (!lab) {
      // The lab leaves out H3 layers of the generated cases: they ask for hexagons its tile fixtures do not hold. Any
      // other case it cannot draw is an error.
      if ((c.style.render as JsonObject | undefined)?.type !== "h3") {
        sceneErrors.push(`${c.id}: the lab does not draw it, and it is no hexagon layer`);
        continue;
      }
      // The scene is drawn for its legend alone, without features, and what its map reports is left out.
      const s = await renderScene(
        { id: c.id, style: c.style, geometry: c.geometry!, zoom: c.zoom, fields: c.fields },
        { groups: [] }
      );
      const legend = await legendPicture(s.root);
      closeScenes([s]);
      tiles.push({
        id: c.id,
        title: words.title,
        note:
          `${words.note} The lab holds no hexagon tiles for these settings: only the legend is shown. The hexagon ` +
          "outline itself is compared in the second section.",
        pictures: [],
        ...(legend ? { legend } : {}),
        keys,
      });
      continue;
    }
    const drawn = await drawTile(lab, grounds, COMPACT);
    tiles.push({ id: c.id, title: words.title, note: words.note, ...shown(drawn), keys });
  }
  return {
    id: "all",
    title: "Every generated case",
    intro:
      "Every case of the test set for automatic colors, None and transparency, small: each mixes several settings " +
      "at once, one feature per legend entry. Look for a color that does not read or an edge that does not belong.",
    tiles,
    layout: "compact",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The page.

function figure(p: Picture, cls = ""): string {
  return (
    `<figure class="${cls}"><img src="${p.src}" width="${Math.round(p.width)}" height="${Math.round(p.height)}" ` +
    `alt="${escape(p.caption)}" loading="lazy" decoding="async"><figcaption>${escape(p.caption)}</figcaption></figure>`
  );
}

function tileHtml(t: Tile): string {
  return (
    `<article class="tile">` +
    `<header><h3>${escape(t.title)}</h3>${t.id ? `<span class="id">${escape(t.id)}</span>` : ""}</header>` +
    (t.note ? `<p class="note">${escape(t.note)}</p>` : "") +
    (t.pictures.length ? `<div class="maps">${t.pictures.map((p) => figure(p)).join("")}</div>` : "") +
    (t.legend || t.keys.length
      ? `<div class="side">${t.legend ? figure(t.legend, "legend") : ""}` +
        (t.keys.length ? `<pre class="keys">${escape(t.keys.join("\n"))}</pre>` : "") +
        `</div>`
      : "") +
    `</article>`
  );
}

const CSS = `
:root {
  --bg: #f4f5f3; --surface: #ffffff; --ink: #1f2523; --muted: #5b6763; --line: #d8dedb; --accent: #1f8f68;
  --code: #eef1ef; color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #121615; --surface: #1b2120; --ink: #e5ebe9; --muted: #9aa7a3; --line: #2d3735; --accent: #4cc79b;
    --code: #232b29; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #121615; --surface: #1b2120; --ink: #e5ebe9; --muted: #9aa7a3; --line: #2d3735; --accent: #4cc79b;
  --code: #232b29; color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 8px; }
h2 { font-size: 21px; margin: 40px 0 4px; padding-top: 8px; border-top: 1px solid var(--line); }
h3 { font-size: 15px; margin: 0; }
p { margin: 4px 0 12px; max-width: 75ch; }
nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0 0; }
nav a { color: var(--accent); text-decoration: none; }
.lead { color: var(--muted); }
.grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
.grid.compact { grid-template-columns: repeat(auto-fill, minmax(min(100%, 430px), 1fr)); }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px; min-width: 0; }
.tile header { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.tile .id { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
.note { color: var(--muted); font-size: 14px; margin: 2px 0 8px; }
.maps { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); }
.wide .maps { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
.compact .maps { grid-template-columns: 1fr; gap: 4px; }
figure { margin: 0; min-width: 0; }
figure img { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); }
figcaption { font-size: 12px; color: var(--muted); margin-top: 2px; }
.side { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; margin-top: 8px; }
.side .legend { flex: 0 1 240px; }
.side .legend img { border: none; background: #ffffff; }
.keys { flex: 1 1 260px; min-width: 0; margin: 0; padding: 8px; background: var(--code); border-radius: 6px;
  font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
footer pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
`;

function pageHtml(sections: Section[], groundsNote: string, attribution: string): string {
  const nav = sections.map((s) => `<a href="#${s.id}">${escape(s.title)}</a>`).join("");
  const body = sections
    .map(
      (s) =>
        `<section id="${s.id}" class="${s.layout ?? ""}"><h2>${escape(s.title)}</h2><p>${escape(s.intro)}</p>` +
        `<div class="grid ${s.layout ?? ""}">${s.tiles.map(tileHtml).join("\n")}</div></section>`
    )
    .join("\n");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Automatic Colors Gallery</title><style>${CSS}</style></head><body><main>` +
    `<h1>Automatic colors, None and transparency</h1>` +
    `<p class="lead">Each tile shows one style drawn by the app's own map code on the Light map, the Dark map and ` +
    `Satellite, with the legend the app draws beside it and the color settings it uses. ${escape(groundsNote)}</p>` +
    `<nav>${nav}</nav>${body}` +
    (attribution ? `<footer><h3>Map pictures</h3><pre>${escape(attribution)}</pre></footer>` : "") +
    `</main></body></html>`
  );
}

/** The grounds: the pictures in the grounds folder over the basemaps' land colors, or those colors alone. */
async function readGrounds(): Promise<{
  grounds: Record<GroundName, LabGround>;
  note: string;
  attribution: string;
}> {
  if (!GROUNDS_DIR)
    return {
      grounds: LAB_GROUNDS,
      note:
        "No map pictures were given: the maps are drawn on plain colors that stand in for the basemaps (the land " +
        "color of the Light and the Dark map, a dark green grey for Satellite).",
      attribution: "",
    };
  const grounds = { ...LAB_GROUNDS } as Record<GroundName, LabGround>;
  for (const name of GROUND_NAMES) {
    const base64 = await commands.readFile(`${GROUNDS_DIR}/${name}.png`, "base64");
    grounds[name] = { ...LAB_GROUNDS[name], picture: `data:image/png;base64,${base64}` };
  }
  const attribution = await commands.readFile(`${GROUNDS_DIR}/README.txt`).catch(() => "");
  return {
    grounds,
    note: "The maps are drawn over pictures of the basemaps; a satellite picture stands in for the app's Satellite map.",
    attribution: attribution.trim(),
  };
}

/** The page in a frame of a phone's width: whether it scrolls sideways, and the requests it makes that are not
 * inline. */
async function onPhone(html: string): Promise<{ sideways: number; requests: string[] }> {
  const frame = document.createElement("iframe");
  frame.style.width = "375px";
  frame.style.height = "700px";
  const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await loaded;
  const doc = frame.contentDocument!;
  // Every picture, also those the page loads lazily.
  for (const img of doc.querySelectorAll("img")) img.loading = "eager";
  await Promise.all(
    [...doc.querySelectorAll("img")].map((img) =>
      img.complete ? undefined : new Promise((done) => img.addEventListener("load", done, { once: true }))
    )
  );
  const sideways = doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
  const requests = frame
    .contentWindow!.performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("data:"));
  frame.remove();
  return { sideways, requests };
}

it.skipIf(!OUT)(
  "writes the gallery page",
  async () => {
    const { grounds, note, attribution } = await readGrounds();
    const sections = [
      await decision(grounds),
      await hexagonDecision(grounds),
      await iconsAndNumbers(grounds),
      await outlines(grounds),
      await labels(grounds),
      await transparency(grounds),
      await generated(grounds),
    ];
    const html = pageHtml(sections, note, attribution);
    await commands.writeFile(OUT!, html);
    const counts = sections.map(
      (s) =>
        `${s.id}: ${s.tiles.length} tiles, ${s.tiles.reduce((n, t) => n + t.pictures.length, 0)} pictures`
    );
    const bytes = new Blob([html]).size;
    console.log(`gallery: ${bytes} bytes; ${counts.join("; ")}`);

    expect(bytes).toBeLessThan(MAX_BYTES);
    expect(html).not.toMatch(/<(link|script)\b/);
    expect(html).not.toMatch(/(src|href)="(?!data:|#)/);
    // A picture the canvas could not encode.
    expect(html).not.toContain('src="data:,"');
    const phone = await onPhone(html);
    expect(phone).toEqual({ sideways: 0, requests: [] });
    expect(sceneErrors).toEqual([]);
    expect([...unnamed]).toEqual([]);
  },
  30 * 60_000
);
