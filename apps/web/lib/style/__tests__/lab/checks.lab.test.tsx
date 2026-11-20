import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";

import {
  blank,
  colorMismatches,
  colorSkip,
  drawSkip,
  drawnHidden,
  missingImages,
  notDrawn,
  readRect,
  readRows,
} from "./checks";
import { type LabCase, SAMPLE_SIZE, type Scene, closeScene, renderScene } from "./scene";

const scenes: Scene[] = [];

beforeEach(() => performance.clearResourceTimings());

afterEach(() => {
  while (scenes.length) closeScene(scenes.pop()!);
});

async function scene(c: LabCase): Promise<Scene> {
  const drawn = await renderScene(c);
  scenes.push(drawn);
  expect(drawn.errors).toEqual([]);
  return drawn;
}

const labCase = (id: string, geometry: Geometry, style: JsonObject, zoom = 4): LabCase => ({
  id,
  style: { version: "1.0.0", kind: "vector", ...style },
  geometry,
  zoom,
  fields: { category: "string", amount: "number" },
});

/** Two categories of `category` and features without a value, each in its own color, set on `part`. */
const categories = (part: string, colors: [string, string, string]): JsonObject => ({
  classify: [
    {
      id: "kind",
      field: "category",
      method: "categories",
      classes: [
        { values: ["a"], [part]: { color: colors[0] }, name: "A" },
        { values: ["b"], [part]: { color: colors[1] }, name: "B" },
      ],
      no_data: { [part]: { color: colors[2] } },
      computed: { no_data: true, other: false },
    },
  ],
});

const COLORS: [string, string, string] = ["#1b9e77", "#d95f02", "#7570b3"];

const POINTS = labCase("points", "point", {
  symbol: { marker: { shape: "circle", color: "#888888", size: 16 } },
  ...categories("marker", COLORS),
});

/** Cases whose drawn colors match their legend: each geometry, faded parts, markers with an icon on them, the
 * cases the skip rules must not leave out. */
const MATCHING: LabCase[] = [
  POINTS,
  labCase("faded-points", "point", {
    symbol: {
      marker: { shape: "circle", color: "#888888", size: 16, opacity: 0.5 },
      outline: { color: "#1a1a1a", width: 1 },
    },
    ...categories("marker", COLORS),
  }),
  labCase("lines", "line", {
    symbol: { line: { color: "#888888", width: 6, opacity: 0.5 }, casing: { color: "#1a1a1a", width: 2 } },
    ...categories("line", COLORS),
  }),
  labCase("line-3px", "line", {
    symbol: { line: { color: "#888888", width: 3 } },
    ...categories("line", COLORS),
  }),
  labCase("dashed", "line", {
    symbol: { line: { color: "#888888", width: 4, dash: "dashed" } },
    ...categories("line", COLORS),
  }),
  labCase("polygons", "polygon", {
    symbol: { fill: { color: "#888888", opacity: 0.6 }, outline: { color: "#1a1a1a", width: 2 } },
    ...categories("fill", COLORS),
  }),
  // The layer's opacity fades every part on the map; the swatch shows the part's own opacity.
  labCase("layer-opacity", "polygon", {
    opacity: 0.5,
    symbol: { fill: { color: "#888888", opacity: 0.8 } },
    ...categories("fill", COLORS),
  }),
  labCase("layer-opacity-points", "point", {
    opacity: 0.4,
    symbol: { marker: { shape: "pin", color: "#888888", size: 32, icon: "goat:park" } },
    ...categories("marker", COLORS),
  }),
  // A real color that happens to be the legend's grey is compared like any other.
  labCase("grey-class", "point", {
    symbol: { marker: { shape: "circle", color: "#888888", size: 16 } },
    ...categories("marker", ["#9aa3ad", "#d95f02", "#7570b3"]),
  }),
  // Classes of the outline color: the swatch's fill is the base fill, which the map draws.
  labCase("outline-classes", "polygon", {
    symbol: { fill: { color: "#3366cc" }, outline: { color: "#1a1a1a", width: 2 } },
    classify: [
      {
        id: "edge",
        field: "category",
        method: "categories",
        target: "outline.color",
        classes: [
          { values: ["a"], outline: { color: "#1b9e77" }, name: "A" },
          { values: ["b"], outline: { color: "#d95f02" }, name: "B" },
        ],
        computed: { no_data: false, other: false },
      },
    ],
  }),
  labCase("color-by-zoom", "point", {
    symbol: {
      marker: {
        shape: "circle",
        color: {
          zoom: [
            [2, "#fee8c8"],
            [8, "#e34a33"],
          ],
        },
        size: 16,
      },
    },
  }),
  labCase("pin-color-by-zoom", "point", {
    symbol: {
      marker: {
        shape: "pin",
        color: {
          zoom: [
            [2, "#fee8c8"],
            [8, "#e34a33"],
          ],
        },
        size: 24,
      },
    },
  }),
  labCase("icon-alone", "point", {
    symbol: { marker: { shape: "icon", icon: "goat:park", color: "#3366cc", size: 24 } },
    ...categories("marker", COLORS),
  }),
  ...["circle", "square", "pin", "flag"].map((shape) =>
    labCase(`${shape}-with-icon`, "point", {
      symbol: {
        marker: { shape, color: "#888888", size: 32, icon: "goat:park" },
        outline: { color: "#1a1a1a", width: 1 },
      },
      ...categories("marker", COLORS),
    })
  ),
  // A thick outline pads the marker image by twice its width: on a small pin the ring around the icon is only found
  // with that padding (markerLayout) placed by the pin's anchor.
  labCase("pin-thick-outline", "point", {
    symbol: {
      marker: { shape: "pin", color: "#888888", size: 16, icon: "goat:park" },
      outline: { color: "#1a1a1a", width: 6 },
    },
    ...categories("marker", COLORS),
  }),
  labCase("offset", "point", {
    symbol: { marker: { shape: "square", color: "#888888", size: 20, offset: [0, -4] } },
    ...categories("marker", COLORS),
  }),
  labCase("anchor", "point", {
    symbol: { marker: { shape: "square", color: "#888888", size: 20, anchor: "top" } },
    ...categories("marker", COLORS),
  }),
  // A pattern draws over the fill: the fill's color still shows between its strokes.
  labCase("pattern", "polygon", {
    symbol: { fill: { color: "#888888", pattern: "hatch_45", pattern_color: "#ff0000" } },
    ...categories("fill", COLORS),
  }),
  labCase("square", "point", {
    symbol: { marker: { shape: "square", color: "#888888", size: 20 } },
    ...categories("marker", COLORS),
  }),
  // A polygon's or a line's marker sits on the sample's pixel: the fill or the line is read beside it, the marker's
  // color where the marker is drawn.
  labCase("polygon-marker", "polygon", {
    symbol: {
      fill: { color: "#888888" },
      outline: { color: "#1a1a1a", width: 2 },
      marker: { shape: "circle", color: "#3366cc", size: 20, icon: "goat:park" },
    },
    ...categories("fill", COLORS),
  }),
  labCase("polygon-pin", "polygon", {
    symbol: {
      fill: { color: "#888888", opacity: 0.6 },
      marker: { shape: "pin", color: "#3366cc", size: 24, opacity: 0.8 },
    },
    ...categories("fill", COLORS),
  }),
  labCase("line-marker", "line", {
    symbol: {
      line: { color: "#888888", width: 6 },
      marker: { shape: "circle", color: "#3366cc", size: 18, icon: "goat:park" },
    },
    ...categories("line", COLORS),
  }),
];

describe("the lab checks", () => {
  it.each(MATCHING.map((c) => [c.id, c] as const))(
    "%s: a scene drawn as its legend shows passes every check",
    async (_, c) => {
      const s = await scene(c);

      expect(s.placed.length).toBeGreaterThan(0);
      expect(notDrawn(s)).toEqual([]);
      expect(missingImages(s)).toEqual([]);
      // Every sample's color is compared, none skipped.
      expect(s.placed.map((p) => colorSkip(s, p))).toEqual(s.placed.map(() => null));
      expect(colorMismatches(s)).toEqual([]);
    }
  );

  it("an entry whose legend color differs from the map is reported, and only that entry", async () => {
    const s = await scene(POINTS);
    expect(colorMismatches(s)).toEqual([]);

    s.placed[1].swatch.marker!.color = "#000000";

    expect(colorMismatches(s)).toEqual(["kind/1: legend #000000, map #d95f02"]);
  });

  // Each way a color is read: a circle's middle, the ring around an icon on a pin, an icon alone's box, a dashed
  // line's strip, a faded layer.
  it.each(["points", "pin-with-icon", "pin-thick-outline", "icon-alone", "dashed", "layer-opacity"])(
    "%s: a wrong legend color is reported for that entry alone",
    async (id) => {
      const s = await scene(MATCHING.find((c) => c.id === id)!);
      expect(colorMismatches(s)).toEqual([]);

      const p = s.placed[1];
      (p.swatch.marker ?? p.swatch.line ?? p.swatch.fill)!.color = "#000000";

      const found = colorMismatches(s);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(
        new RegExp(`^${p.section}/${p.entry.id}: legend #[0-9a-f]{6}, map #[0-9a-f]{6}$`)
      );
    }
  );

  // A polygon's or a line's marker covers its sample's pixel: the fill or the line and the marker are each read where
  // they show, and a wrong color of either is reported. A see-through marker is drawn over the fill, so a wrong fill
  // shows in both.
  it.each([
    ["polygon-marker", "fill", [""]],
    ["polygon-marker", "marker", [" marker"]],
    ["polygon-pin", "fill", ["", " marker"]],
    ["polygon-pin", "marker", [" marker"]],
    ["line-marker", "line", [""]],
    ["line-marker", "marker", [" marker"]],
  ] as const)("%s: a wrong legend color of the %s is reported for that entry", async (id, part, reads) => {
    const s = await scene(MATCHING.find((c) => c.id === id)!);
    expect(colorMismatches(s)).toEqual([]);

    const p = s.placed[1];
    p.swatch[part]!.color = "#000000";

    const found = colorMismatches(s);
    expect(found).toHaveLength(reads.length);
    reads.forEach((read, i) =>
      expect(found[i]).toMatch(
        new RegExp(`^${p.section}/${p.entry.id}${read}: legend #[0-9a-f]{6}, map #[0-9a-f]{6}$`)
      )
    );
  });

  it("an icon alone whose legend shows a lighter tint of the drawn color is reported", async () => {
    const s = await scene(MATCHING.find((c) => c.id === "icon-alone")!);
    expect(colorMismatches(s)).toEqual([]);

    // The drawn #d95f02 halfway to white: the icon's edges hold such blends, its strokes do not.
    s.placed[1].swatch.marker!.color = "#ecaf81";

    expect(colorMismatches(s)).toEqual(["kind/1: legend #ecaf81, map #d95f02"]);
  });

  it("a legend color that does not parse is reported, not thrown", async () => {
    const s = await scene(POINTS);
    s.placed[0].swatch.marker!.color = "not a color";

    expect(colorMismatches(s)).toEqual(["kind/0: legend color not a color is not a color"]);
  });

  it("a requested image the map no longer has is reported", async () => {
    const s = await scene(MATCHING.find((c) => c.id === "pin-with-icon")!);
    expect(s.requestedImages.length).toBeGreaterThan(0);
    expect(missingImages(s)).toEqual([]);

    const [image] = s.requestedImages;
    s.map.removeImage(image);

    expect(missingImages(s)).toEqual([image]);
  });

  it("readRows reads a rectangle row by row from its top, the pixels readRect reads", async () => {
    const s = await scene(labCase("rows", "polygon", { symbol: { fill: { color: "#ff0000" } } }));
    const [x, y] = s.placed[0].pixel;
    // Across the polygon's top edge: the ground above it, its fill below.
    const rect = { x: x - 4, y: y - SAMPLE_SIZE / 2 - 4, w: 8, h: 8 };
    const rows = readRows(s, rect);
    const ratio = s.map.getPixelRatio();
    expect(rows).toHaveLength(Math.round(8 * ratio));
    expect(rows.every((row) => row.length === Math.round(8 * ratio))).toBe(true);
    expect(rows[0].every(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
    expect(rows[rows.length - 1].every(([r, g, b]) => r === 255 && g === 0 && b === 0)).toBe(true);
    const sorted = (pixels: number[][]) => pixels.map((p) => p.join()).sort();
    expect(sorted(rows.flat())).toEqual(sorted(readRect(s, rect)));
    // A rectangle past the map's edge reads the part on the map.
    expect(readRows(s, { x: -4, y: -4, w: 8, h: 8 })).toHaveLength(Math.round(4 * ratio));
  });

  it("a scene that draws nothing is blank", async () => {
    const s = await scene(POINTS);
    expect(blank(s)).toBe(false);

    for (const layer of s.map.getStyle().layers)
      if (layer.type !== "background") s.map.setLayoutProperty(layer.id, "visibility", "none");
    await s.map.once("idle");

    expect(blank(s)).toBe(true);
  });

  it("a sample with no drawn feature at its pixel is reported", async () => {
    const s = await scene(POINTS);
    expect(notDrawn(s)).toEqual([]);

    s.placed[2].pixel = [4, 4];

    expect(notDrawn(s)).toEqual([s.placed[2]]);
  });

  describe("samples drawn where their pixel does not hit them", () => {
    it("a polygon whose fill is switched off is found on its outline", async () => {
      const s = await scene(
        labCase("no-fill-drawn", "polygon", {
          symbol: { fill: false, outline: { color: "#1a1a1a", width: 2 } },
          ...categories("outline", COLORS),
        })
      );
      expect(s.placed.length).toBe(3);
      expect(notDrawn(s)).toEqual([]);

      // A sample whose outline is not where it was placed is still reported.
      s.placed[1].pixel = [4, 4];
      expect(notDrawn(s)).toEqual([s.placed[1]]);
    });

    it("a small marker is looked for where it is drawn, not a few pixels around it", async () => {
      const s = await scene(
        labCase("small", "point", {
          symbol: { marker: { shape: "circle", color: "#888888", size: 4 } },
          ...categories("marker", COLORS),
        })
      );
      expect(notDrawn(s)).toEqual([]);

      // Five pixels off: outside the 4 px circle.
      s.placed[1].pixel = [s.placed[1].pixel[0] + 5, s.placed[1].pixel[1]];
      expect(notDrawn(s)).toEqual([s.placed[1]]);
    });

    it("a marker anchored at its bottom and moved up off its point is found", async () => {
      const s = await scene(
        labCase("lifted", "point", {
          symbol: {
            marker: {
              shape: "icon",
              icon: "goat:park",
              color: "#1b9e77",
              size: 24,
              anchor: "bottom",
              offset: [0, -2],
            },
          },
        })
      );
      expect(s.placed.length).toBe(1);
      expect(notDrawn(s)).toEqual([]);
      expect(colorMismatches(s)).toEqual([]);
    });

    // Line samples of two classes, the second drawn from zoom 13 on.
    const fromZoom13 = (zoom: number) =>
      labCase(
        `class-from-zoom-${zoom}`,
        "line",
        {
          symbol: { line: { color: "#2166ac", width: 4 } },
          classify: [
            {
              id: "status",
              field: "category",
              method: "categories",
              classes: [
                { values: ["a"], name: "A" },
                { values: ["b"], name: "B", min_zoom: 13 },
              ],
            },
          ],
        },
        zoom
      );

    it("a class drawn only from a higher zoom is not expected below it", async () => {
      const s = await scene(fromZoom13(12));
      expect(s.placed.map((p) => drawSkip(s, p))).toEqual([null, expect.stringMatching(/from zoom 13/)]);
      expect(notDrawn(s)).toEqual([]);
      // Its color is not compared either, for the same reason.
      expect(colorSkip(s, s.placed[1])).toMatch(/from zoom 13/);
    });

    it("a sample its class hides at the map's zoom is not drawn", async () => {
      const s = await scene(fromZoom13(12));
      expect(drawnHidden(s)).toEqual([]);

      // Class A drawn at zoom 12 while its record says from zoom 13 on: reported.
      const classes = (s.style.classify as JsonObject[])[0].classes as JsonObject[];
      classes[0].min_zoom = 13;
      expect(drawnHidden(s)).toEqual([s.placed[0]]);
    });

    it("from its zoom on, the class's sample is expected", async () => {
      const s = await scene(fromZoom13(13));
      expect(s.placed.map((p) => drawSkip(s, p))).toEqual([null, null]);
      expect(notDrawn(s)).toEqual([]);
    });
  });

  it("a class that sets its own color in a block that sets no color is compared", async () => {
    const s = await scene(
      labCase("own-color", "point", {
        symbol: { marker: { shape: "circle", color: "#3366cc", size: 16 } },
        classify: [
          {
            id: "size",
            field: "category",
            method: "categories",
            target: "marker.size",
            classes: [
              { values: ["a"], marker: { size: 12, color: "#1b9e77" }, name: "A" },
              { values: ["b"], marker: { size: 24 }, name: "B" },
            ],
            computed: { no_data: false, other: false },
          },
        ],
      })
    );
    expect(s.placed.map((p) => colorSkip(s, p))).toEqual([null, expect.stringMatching(/sets no color/)]);
    expect(colorMismatches(s)).toEqual([]);

    s.placed[0].swatch.marker!.color = "#000000";
    expect(colorMismatches(s)).toEqual(["size/0: legend #000000, map #1b9e77"]);
  });

  describe("samples without one main color to read are skipped by rule", () => {
    const SKIPPED: Array<[string, LabCase, RegExp]> = [
      [
        "a hollow marker",
        labCase("hollow", "point", {
          symbol: { marker: { shape: "circle", color: "#888888", size: 16, fill: false } },
          ...categories("marker", COLORS),
        }),
        /hollow/,
      ],
      [
        "a line under 3 px",
        labCase("thin", "line", {
          symbol: { line: { color: "#888888", width: 2 } },
          ...categories("line", COLORS),
        }),
        /under 3 px/,
      ],
      [
        "a polygon whose fill is switched off",
        labCase("no-fill", "polygon", {
          symbol: { fill: false, outline: { color: "#1a1a1a", width: 2 } },
          ...categories("outline", COLORS),
        }),
        /switched off/,
      ],
      [
        "a raised polygon",
        labCase(
          "raised",
          "polygon",
          { symbol: { fill: { color: "#888888" }, extrude: { height: 20 } }, ...categories("fill", COLORS) },
          12
        ),
        /raised/,
      ],
      [
        "an icon that keeps its own colors",
        labCase("upload", "point", {
          symbol: { marker: { shape: "icon", icon: "asset:lab-icon", color: "#3366cc", size: 24 } },
        }),
        /own colors/,
      ],
      [
        "an entry of a block that sets no color",
        labCase("sizes", "point", {
          symbol: { marker: { shape: "circle", color: "#3366cc", size: 16 } },
          classify: [
            {
              id: "size",
              field: "category",
              method: "categories",
              target: "marker.size",
              classes: [
                { values: ["a"], marker: { size: 12 }, name: "A" },
                { values: ["b"], marker: { size: 24 }, name: "B" },
              ],
              computed: { no_data: false, other: false },
            },
          ],
        }),
        /sets no color/,
      ],
      [
        "a rule's sample whose opacity a classification sets",
        labCase("rule-and-opacity", "polygon", {
          symbol: { fill: { color: "#3366cc", opacity: 0.8 } },
          classify: [
            {
              id: "fade",
              field: "amount",
              method: "manual",
              target: "fill.opacity",
              classes: [
                { to: 50, fill: { opacity: 0.3 }, name: "Low" },
                { from: 50, fill: { opacity: 1 }, name: "High" },
              ],
              computed: { no_data: false, other: false },
            },
          ],
          rules: [
            {
              name: "B",
              when: { op: "=", args: [{ property: "category" }, "b"] },
              fill: { color: "#d7191c" },
            },
          ],
        }),
        /another classification sets the main opacity|sets no color/,
      ],
      [
        "a blurred line",
        labCase("blurred", "line", {
          symbol: { line: { color: "#888888", width: 4, blur: 1.5 } },
          ...categories("line", COLORS),
        }),
        /blurred/,
      ],
      [
        "dashes under 3 px",
        labCase("dotted", "line", {
          symbol: { line: { color: "#888888", width: 4, dash: "dotted" } },
          ...categories("line", COLORS),
        }),
        /dashes under 3 px/,
      ],
      [
        "a sample another rule matches by a condition other than equality",
        labCase("is-null", "line", {
          symbol: { line: { color: "#2166ac", width: 4 } },
          rules: [
            {
              name: "B",
              when: { op: "=", args: [{ property: "category" }, "b"] },
              line: { width: 6 },
            },
            {
              name: "No amount",
              legend: false,
              when: { op: "isNull", args: [{ property: "amount" }] },
              line: { color: "#9aa3ad" },
            },
          ],
        }),
        /rule the sample matches/,
      ],
      [
        "a main color by attribute",
        labCase("by-field", "point", {
          symbol: {
            marker: {
              shape: "circle",
              size: 16,
              color: {
                field: "amount",
                palette: "d3:viridis",
                computed: { domain: [0, 100] },
              },
            },
          },
          // A rule that sets the size: its entry shows the base color, by attribute.
          rules: [
            { name: "B", when: { op: "=", args: [{ property: "category" }, "b"] }, marker: { size: 24 } },
          ],
        }),
        /by attribute/,
      ],
      [
        "a main color by attribute in zoom stops",
        labCase("by-field-in-stops", "point", {
          symbol: {
            marker: {
              shape: "circle",
              size: 16,
              color: {
                zoom: [8, 12].map((z, i) => [
                  z,
                  {
                    field: "amount",
                    palette: "d3:viridis",
                    reverse: i === 1,
                    computed: { domain: [0, 100] },
                  },
                ]),
              },
            },
          },
          rules: [
            { name: "B", when: { op: "=", args: [{ property: "category" }, "b"] }, marker: { size: 24 } },
          ],
        }),
        /by attribute/,
      ],
    ];

    it.each(SKIPPED)("%s", async (_, c, reason) => {
      const s = await scene(c);
      expect(s.placed.length).toBeGreaterThan(0);
      for (const p of s.placed) expect(colorSkip(s, p), `${p.section}/${p.entry.id}`).toMatch(reason);

      // A skipped sample is not compared, whatever its legend shows. The opacity changes, not the color, which the
      // grey stand-in's rule reads.
      for (const p of s.placed) {
        const main = p.swatch.marker ?? p.swatch.line ?? p.swatch.fill;
        if (main) main.opacity = 0.1;
      }
      expect(colorMismatches(s)).toEqual([]);
    });
  });
});
