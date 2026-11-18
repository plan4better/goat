// The cases the lab draws: every legend case the map draws from vector data in the browser (not H3 or rasters, which
// come from server tiles), from the same fixtures the jsdom tests read, imported as JSON; and extra cases for what
// those leave out: the plain forms of the styles saved most often, icons of each kind, shapes, patterns, dashes,
// labels, a heatmap, a raised polygon and clusters over points placed in groups.
import type { FieldType } from "@/lib/style/compile/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";

import generated from "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/legend_cases.json";
import datasets from "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/sample_datasets.json";
import examples from "../../../../../../packages/python/goatlib/tests/unit/style/fixtures/spec_examples.json";
import type { SampleDataset, SpecExample } from "../fixtureTypes";
import { type GeneratedCases, type LegendCase, buildLegendCases, pointsDrawn } from "../legend/caseList";
import { known } from "../legend/known";
import type { LabCase, LabGroup } from "./scene";

/** A lab case, with the legend case it comes from (none for an extra case). */
export interface LabCaseOf extends LabCase {
  legendCase?: LegendCase;
}

const FIELDS: Record<string, FieldType> = { category: "string", amount: "number" };

const style = (doc: JsonObject): JsonObject => ({ version: 1, kind: "vector", ...doc });

const extra = (
  id: string,
  geometry: LabCase["geometry"],
  doc: JsonObject,
  more: Partial<LabCase> = {}
): LabCaseOf => ({ id, geometry, zoom: 10, fields: FIELDS, style: style(doc), ...more });

/** Categories `a` and `b` of `category`, each with its own part. */
const categories = (part: string, a: JsonObject, b: JsonObject): JsonObject => ({
  id: "kind",
  field: "category",
  method: "categories",
  classes: [
    { values: ["a"], name: "A", [part]: a },
    { values: ["b"], name: "B", [part]: b },
  ],
});

/** Four quantile classes of `amount` with their part's color, as the server writes them once computed. */
const quantiles = (part: string): JsonObject => ({
  id: "amount",
  field: "amount",
  method: "quantile",
  count: 4,
  palette: "colorbrewer:OrRd",
  classes: [
    { to: 10, [part]: { color: "#fef0d9" } },
    { from: 10, to: 20, [part]: { color: "#fdcc8a" } },
    { from: 20, to: 40, [part]: { color: "#fc8d59" } },
    { from: 40, [part]: { color: "#d7301f" } },
  ],
  computed: { at: "2026-01-01T00:00:00Z", data: "synthetic-v1", scope: "dataset" },
});

/** `n` points of category `a` and `m` of `b`, the `b` ones first. */
const mixed = (n: number, m: number): Array<Record<string, unknown>> => [
  ...Array.from({ length: m }, () => ({ category: "b" })),
  ...Array.from({ length: n }, () => ({ category: "a" })),
];

/** Points with these amounts. */
const amounts = (...values: number[]) => values.map((amount) => ({ amount }));

const group = (at: [number, number], points: Array<Record<string, unknown>>): LabGroup => ({ at, points });

/** The zoom the cluster cases are drawn at; their clusters end two zooms above it. */
export const CLUSTER_ZOOM = 10;

/** The cluster cases' groups, by case: the checks in clusters.lab.test.tsx know their sizes and values. */
export const CLUSTER_GROUPS = {
  circle: [
    group([120, 140], amounts(...Array(3).fill(1))),
    group([320, 140], amounts(...Array(30).fill(1))),
    group([520, 140], amounts(...Array(300).fill(1))),
  ],
  icons: [
    // Three of `a` and one of `b`; two of each (a tie); one of each alone, which stays a single point.
    group([120, 140], mixed(3, 1)),
    group([320, 140], mixed(2, 2)),
    group([120, 340], mixed(1, 0)),
    group([320, 340], mixed(0, 1)),
  ],
  sum: [group([160, 140], amounts(1, 2, 3, 4)), group([440, 140], amounts(100, 200, 300))],
  mean: [group([160, 140], amounts(10, 10, 10)), group([440, 140], amounts(400, 600))],
  short: [group([320, 240], amounts(...Array(1234).fill(1)))],
};

const CLUSTER_BASE = { marker: { shape: "circle", color: "#283593", size: 8 } };

const extras = (): LabCaseOf[] => [
  // Shapes saved styles use most, in the plain form no case above has.
  extra("polygon-categories", "polygon", {
    symbol: { fill: { color: "#cccccc", opacity: 0.8 }, outline: { color: "#ffffff", width: 1 } },
    classify: [categories("fill", { color: "#66c2a5" }, { color: "#fc8d62" })],
  }),
  extra("polygon-quantile", "polygon", {
    symbol: { fill: { color: "#cccccc", opacity: 0.8 }, outline: { color: "#ffffff", width: 1 } },
    classify: [quantiles("fill")],
  }),
  extra(
    "polygon-label",
    "polygon",
    {
      symbol: {
        fill: { color: "#deebf7" },
        outline: { color: "#3182bd", width: 1 },
        label: { text: "{name}", size: 12, color: "#3a3541", halo: { color: "#ffffff", width: 1.5 } },
      },
    },
    {
      fields: { ...FIELDS, name: "string" },
      groups: [group([200, 160], [{ name: "North" }]), group([440, 320], [{ name: "South" }])],
    }
  ),
  extra("one-icon", "point", {
    symbol: { marker: { shape: "icon", icon: "goat:park", color: "#1b9e77", size: 24 } },
  }),
  extra("circle-quantile", "point", {
    symbol: {
      marker: { shape: "circle", color: "#cccccc", size: 10 },
      outline: { color: "#ffffff", width: 1 },
    },
    classify: [quantiles("marker")],
  }),
  extra("plain-line", "line", { symbol: { line: { color: "#2166ac", width: 3 } } }),
  // A color ramp over a computed domain, with areas along it.
  extra(
    "polygon-ramp",
    "polygon",
    {
      symbol: {
        fill: {
          color: {
            field: "amount",
            palette: "colorbrewer:YlGnBu",
            title: "Amount",
            computed: {
              at: "2026-01-01T00:00:00Z",
              data: "synthetic-v1",
              scope: "dataset",
              domain: [0, 100],
            },
          },
          opacity: 0.9,
        },
        outline: { color: "#ffffff", width: 1 },
      },
    },
    { groups: [0, 25, 50, 75, 100].map((amount, i) => group([80 + 120 * i, 120], [{ amount }])) }
  ),
  // The spec's circles sized by pupils and twice as large at zoom 16 as at zoom 11 (spec 4.4), with the domain the
  // server writes into each stop, drawn at the middle of the stops, where the legend reads sizes by zoom (spec 7.2): a
  // point at each of the legend's three sample values.
  extra(
    "zoom-sizes",
    "point",
    {
      symbol: {
        marker: {
          shape: "circle",
          color: "#1a6b4d",
          size: {
            zoom: [11, 16].map((z, i) => [
              z,
              {
                field: "pupils",
                range: i === 0 ? [3, 10] : [6, 20],
                scale: "sqrt",
                computed: {
                  at: "2026-01-01T00:00:00Z",
                  data: "synthetic-v1",
                  scope: "dataset",
                  domain: [65, 1391],
                },
              },
            ]),
            interpolate: "linear",
          },
        },
      },
    },
    {
      zoom: 13.5,
      fields: { pupils: "number" },
      groups: [65, 728, 1391].map((pupils, i) => group([160 + 160 * i, 240], [{ pupils }])),
    }
  ),
  // Pins colored by amount, from one palette at zoom 11 to another at 15 (spec 4.4), drawn between the two stops and
  // between two whole zooms: a point at each end of the domain, where the legend's ramp ends.
  extra(
    "zoom-colors",
    "point",
    {
      symbol: {
        marker: {
          shape: "pin",
          size: 32,
          color: {
            zoom: [
              [11, { field: "amount", palette: ["#0000ff", "#00ff00"], domain: [0, 100] }],
              [15, { field: "amount", palette: ["#ff0000", "#ffff00"], domain: [0, 100] }],
            ],
          },
        },
      },
    },
    { zoom: 13.5, groups: [0, 100].map((amount, i) => group([200 + 240 * i, 280], [{ amount }])) }
  ),
  // Categories with No data: a feature without a value has its own look.
  extra("no-data", "point", {
    symbol: {
      marker: { shape: "circle", color: "#888888", size: 12 },
      outline: { color: "#ffffff", width: 1 },
    },
    classify: [
      {
        ...categories("marker", { color: "#1b9e77" }, { color: "#d95f02" }),
        no_data: { name: "No data", marker: { color: "#bdbdbd" } },
        computed: { no_data: true, other: false },
      },
    ],
  }),
  // Line widths by class.
  extra("line-widths", "line", {
    symbol: { line: { color: "#2166ac", width: 2 } },
    classify: [
      {
        id: "amount",
        field: "amount",
        method: "manual",
        target: "line.width",
        classes: [
          { to: 10, line: { width: 1 } },
          { from: 10, to: 40, line: { width: 3 } },
          { from: 40, line: { width: 6 } },
        ],
      },
    ],
  }),
  extra("line-categories", "line", {
    symbol: { line: { color: "#999999", width: 3 } },
    classify: [categories("line", { color: "#1b9e77" }, { color: "#7570b3" })],
  }),
  extra("library-icon", "point", {
    symbol: { marker: { shape: "icon", icon: "goat:park", color: "#1b9e77", size: 24 } },
    classify: [
      categories(
        "marker",
        { icon: "goat:school", color: "#d95f02" },
        { icon: "goat:home", color: "#7570b3" }
      ),
    ],
  }),
  extra("upload-icon", "point", { symbol: { marker: { shape: "icon", icon: "asset:lab-icon", size: 24 } } }),
  extra("upload-on-circle", "point", {
    symbol: { marker: { shape: "circle", icon: "asset:lab-icon", color: "#1b9e77", size: 32 } },
  }),
  extra("emoji", "point", { symbol: { marker: { shape: "icon", icon: "emoji:1f525", size: 24 } } }),
  extra("emoji-on-pin", "point", {
    symbol: { marker: { shape: "pin", icon: "emoji:1f3eb", color: "#d95f02", size: 32 } },
  }),
  extra("pins", "point", {
    symbol: { marker: { shape: "pin", icon: "goat:park", color: "#888888", size: 32 } },
    classify: [categories("marker", { color: "#1b9e77" }, { color: "#d95f02" })],
  }),
  extra("squares", "point", {
    symbol: {
      marker: { shape: "square", color: "#888888", size: 24 },
      outline: { color: "#ffffff", width: 1 },
    },
    classify: [categories("marker", { color: "#1b9e77" }, { color: "#d95f02" })],
  }),
  extra("patterns", "polygon", {
    symbol: { fill: { color: "#fcbba1", opacity: 0.6 }, outline: { color: "#555555", width: 1 } },
    classify: [
      categories(
        "fill",
        { color: "#fcbba1", pattern: "hatch_45", pattern_color: "#cb181d" },
        { color: "#c7e9c0", pattern: "cross", pattern_color: "#238b45" }
      ),
    ],
  }),
  extra("dashes", "line", {
    symbol: { line: { color: "#2166ac", width: 4, dash: "dashed" } },
    classify: [
      categories("line", { color: "#1b9e77", dash: "dotted" }, { color: "#d95f02", dash: "dashed" }),
    ],
  }),
  // Icons along a line (spec 3.2 `arrows.icon`): a library icon in the arrows' color, an upload in its own colors.
  extra("line-icons", "line", {
    symbol: {
      line: { color: "#2166ac", width: 3 },
      arrows: { icon: "goat:rail-light", size: 16, spacing: 40, color: "#d7301f" },
    },
  }),
  // An icon that stays upright along the line (spec 3.2 `turn_with_line: false`): GOAT's arrow, whose shape shows
  // which way it is turned.
  extra("line-upright-icons", "line", {
    symbol: {
      line: { color: "#2166ac", width: 3 },
      arrows: { size: 24, spacing: 200, color: "#d7301f", turn_with_line: false },
    },
  }),
  extra("line-upload-icons", "line", {
    symbol: {
      line: { color: "#2166ac", width: 3 },
      arrows: { icon: "asset:lab-icon", size: 16, spacing: 40 },
    },
  }),
  extra("point-labels", "point", {
    symbol: {
      marker: { shape: "circle", color: "#1b9e77", size: 12 },
      label: { text: "{category}", color: "#222222", size: 14 },
    },
    classify: [categories("marker", { color: "#1b9e77" }, { color: "#d95f02" })],
  }),
  // A label font by the categories the marker color sets, beside a size by another field: the labels change, no
  // swatch does, so the legend's blocks are the color's and the size's alone. Each class has its own id, as the
  // panel writes them.
  extra("label-font-classes", "point", {
    symbol: {
      marker: { shape: "circle", color: "#cccccc", size: 12 },
      label: { text: "{category}", color: "#222222", size: 14 },
    },
    classify: [
      {
        id: "kind",
        field: "category",
        method: "categories",
        classes: [
          { id: "c1", values: ["a"], marker: { color: "#1b9e77" } },
          { id: "c2", values: ["b"], marker: { color: "#d95f02" } },
        ],
      },
      {
        id: "amount",
        field: "amount",
        method: "manual",
        target: "marker.size",
        classes: [
          { id: "c3", to: 20, marker: { size: 8 } },
          { id: "c4", from: 20, marker: { size: 20 } },
        ],
      },
      {
        id: "font",
        field: "category",
        method: "categories",
        target: "label.font.weight",
        classes: [
          { id: "c5", values: ["a"], label: { font: { weight: "bold" } } },
          { id: "c6", values: ["b"], label: { font: { style: "italic", weight: "regular" } } },
        ],
      },
    ],
  }),
  extra("line-labels", "line", {
    symbol: { line: { color: "#2166ac", width: 3 }, label: { text: "{category}", color: "#222222" } },
    classify: [categories("line", { color: "#1b9e77" }, { color: "#d95f02" })],
  }),
  extra(
    "heatmap",
    "point",
    {
      render: { type: "heatmap", radius: 30, points_from_zoom: 14 },
      symbol: { marker: { shape: "circle", color: "#d7301f", size: 6 } },
    },
    { groups: [group([200, 200], amounts(1, 2, 3, 4, 5)), group([440, 280], amounts(1, 2, 3))] }
  ),
  extra("extrusion", "polygon", {
    symbol: { fill: { color: "#fdb462" }, extrude: { height: 200 } },
    classify: [categories("fill", { color: "#1b9e77" }, { color: "#d95f02" })],
  }),
  extra(
    "cluster-circle",
    "point",
    {
      render: {
        type: "cluster",
        radius: 50,
        cluster_until_zoom: CLUSTER_ZOOM + 2,
        min_points: 2,
        symbol: {
          marker: {
            shape: "circle",
            color: "#283593",
            size: { field: "count", range: [16, 40], scale: "sqrt" },
          },
          outline: { color: "#ffffff", width: 2 },
          label: { text: "{count}", color: "#ffffff", size: 12 },
        },
      },
      symbol: CLUSTER_BASE,
    },
    { zoom: CLUSTER_ZOOM, groups: CLUSTER_GROUPS.circle }
  ),
  extra(
    "cluster-icons",
    "point",
    {
      render: {
        type: "cluster",
        look: "points",
        count: "badge",
        cluster_until_zoom: CLUSTER_ZOOM + 2,
        symbol: { marker: { color: "#c2185b" }, label: { text: "{count}", color: "#ffeb3b" } },
      },
      symbol: { marker: { shape: "icon", icon: "goat:building", color: "#5a1846", size: 24 } },
      classify: [categories("marker", { icon: "goat:school" }, { icon: "goat:home" })],
    },
    { zoom: CLUSTER_ZOOM, groups: CLUSTER_GROUPS.icons }
  ),
  ...(["sum", "mean"] as const).map((op) =>
    extra(
      `cluster-${op}`,
      "point",
      {
        render: {
          type: "cluster",
          cluster_until_zoom: CLUSTER_ZOOM + 2,
          value: { op, field: "amount" },
          symbol: {
            marker: {
              shape: "circle",
              color: "#2166ac",
              size: { field: "value", range: [16, 48], scale: "sqrt", domain: [0, 1000] },
            },
            label: { text: "{value}", color: "#ffffff" },
          },
        },
        symbol: CLUSTER_BASE,
      },
      { zoom: CLUSTER_ZOOM, groups: CLUSTER_GROUPS[op] }
    )
  ),
  extra(
    "cluster-short",
    "point",
    { render: { type: "cluster", cluster_until_zoom: CLUSTER_ZOOM + 2 }, symbol: CLUSTER_BASE },
    { zoom: CLUSTER_ZOOM, groups: CLUSTER_GROUPS.short }
  ),
];

/** Where the default groups lie, and how many points each holds. */
const DEFAULT_GROUPS: Array<[number, number]> = [
  [100, 120],
  [320, 120],
  [540, 120],
  [200, 340],
  [440, 340],
];
const POINTS_PER_GROUP = 4;

/** A number field's range, as the style's forms over it give it (`domain`, `computed.domain`) or the sample dataset
 * gives it (`min`, `max`); null where neither does. */
function rangeOf(c: LegendCase, field: string): [number, number] | null {
  let found: [number, number] | null = null;
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    const domain = Array.isArray(node.domain)
      ? node.domain
      : isObject(node.computed) && Array.isArray(node.computed.domain)
        ? node.computed.domain
        : null;
    if (node.field === field && domain && typeof domain[0] === "number" && typeof domain[1] === "number")
      found = [domain[0], domain[1]];
    else Object.values(node).forEach(visit);
  };
  visit(c.style);
  if (found) return found;
  const own = c.dataset?.fields?.find((f) => f.name === field);
  return typeof own?.min === "number" && typeof own?.max === "number" ? [own.min, own.max] : null;
}

/** Points in groups for a legend case that lists no entry to sample: a heatmap below its points zoom, a legend of
 * ramps or sizes alone. Group `i` of `n` holds the `i / (n - 1)` share along each number field's range, a value of
 * each text field the dataset lists, and true or false; a field without a known range or values is left out. */
function defaultGroups(c: LegendCase): LabGroup[] | undefined {
  const legend = buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom });
  const entries = legend?.sections.some((section) => section.kind === "entries");
  if (pointsDrawn(c) && entries) return undefined;
  const n = DEFAULT_GROUPS.length;
  return DEFAULT_GROUPS.map((at, i) => {
    const properties: Record<string, unknown> = {};
    for (const [field, type] of Object.entries(c.fields)) {
      if (type === "number" || type === "integer") {
        const range = rangeOf(c, field);
        if (range) {
          const value = range[0] + ((range[1] - range[0]) * i) / (n - 1);
          properties[field] = type === "integer" ? Math.round(value) : value;
        }
      } else if (type === "boolean") properties[field] = i % 2 === 0;
      else {
        const values = c.dataset?.fields?.find((f) => f.name === field)?.values ?? [];
        if (values.length) properties[field] = values[i % values.length];
      }
    }
    return { at, points: Array.from({ length: POINTS_PER_GROUP }, () => ({ ...properties })) };
  });
}

let cached: LabCaseOf[] | undefined;

/** The legend cases with a vector style and a geometry, without H3 and the ones that do not compile (with points in
 * groups where the legend lists no entry to sample), then the extra cases. */
export function labCases(): LabCaseOf[] {
  cached ??= [
    ...buildLegendCases(
      generated as unknown as GeneratedCases,
      examples as unknown as SpecExample[],
      datasets as unknown as Record<string, SampleDataset>
    ).flatMap((c): LabCaseOf[] => {
      const render = (c.style.render ?? {}) as JsonObject;
      if (c.style.kind !== "vector" || !c.geometry || render.type === "h3" || known("compiles", c)) return [];
      const groups = defaultGroups(c);
      return [
        {
          id: c.id,
          style: c.style,
          geometry: c.geometry,
          zoom: c.zoom,
          fields: c.fields,
          legendCase: c,
          ...(groups ? { groups } : {}),
        },
      ];
    }),
    ...extras(),
  ];
  return cached;
}
