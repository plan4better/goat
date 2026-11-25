import { describe, expect, it } from "vitest";

import { contrastRatio, onColor, opaque, shade } from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import type { Geometry } from "@/lib/style/compile/types";
import { setIn } from "@/lib/style/editor/paths";
import { HATCH, swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { Tone } from "@/lib/style/tone";

import { colorOf, layerReader } from "./legend/mapSwatch";

// The panel's swatch of a derived color asks the resolver for what the map draws: in a class's or rule's record (which
// follows the record's own color, else the layer's), in a zoom stop (at that stop's zoom), for the H3 outline (each
// hexagon's color) and over a palette (switching where the map's answer switches).

const doc = (rest: object) => ({ version: "1.0.0", kind: "vector", ...rest }) as LayerStyle;

/** The color a swatch's CSS background shows at `p` (0 to 1) along it: a color, or a gradient of colors with or
 * without positions, blended in sRGB between neighbouring stops. */
function cssAt(background: string, p: number): string {
  if (!background.startsWith("linear-gradient(")) return background.toLowerCase();
  const items = background
    .slice("linear-gradient(90deg, ".length, -1)
    .split(", ")
    .map((item, i, all) => {
      const [color, at] = item.split(" ");
      return { color, at: at ? Number.parseFloat(at) / 100 : i / (all.length - 1) };
    });
  const next = items.findIndex((item) => item.at > p);
  if (next <= 0) return (next === 0 ? items[0] : items[items.length - 1]).color.toLowerCase();
  const [a, b] = [items[next - 1], items[next]];
  const t = b.at === a.at ? 1 : (p - a.at) / (b.at - a.at);
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(a.color, i) + (channel(b.color, i) - channel(a.color, i)) * t)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/** What the map draws for a paint color of a compiled style's layer, for a feature at a zoom, as `#rrggbb`. */
function drawn(style: LayerStyle, geometry: Geometry, tone: Tone, layer: string, key: string) {
  const source =
    geometry === "point" && (style as { render?: unknown }).render
      ? { type: "points" as const, id: "s", data: "https://geoapi.example/items" }
      : { type: "tiles" as const, id: "s", tiles: ["https://tiles.example/{z}/{x}/{y}"] };
  const out = compileLayer({ id: "1", style, geometry, source, tone, fields: { v: "number" } });
  const read = layerReader(out, `1-${layer}`, "paint", key);
  return (properties: Record<string, unknown>, zoom: number) => colorOf(read(properties, zoom))!.hex;
}

/** The shares 0 to 1 in steps of a hundredth. */
const SHARES = Array.from({ length: 101 }, (_, i) => i / 100);

/** The shares where the swatch shows another color than the map at the same place, `at` mapping a share to what the
 * map is read at; a share within `near` of a change of the map's color does not count. */
function offTheMap(swatch: string, map: (p: number) => string, near = 0.03): number[] {
  const changes = SHARES.slice(1).filter((p, i) => map(p) !== map(SHARES[i]));
  return SHARES.filter((p) => cssAt(swatch, p) !== map(p) && !changes.some((x) => Math.abs(x - p) <= near));
}

describe("the panel's swatch of a derived color", () => {
  it("in a class record follows that record's color, else the layer's", () => {
    const style = doc({
      symbol: { fill: { color: "#e68310" }, outline: { color: "auto" } },
      classify: [
        {
          field: "kind",
          classes: [{ values: ["a"], fill: { color: "#7f3c8d" } }, { values: ["b"] }],
        },
      ],
    });
    expect(swatchOf(style, "classify.0.classes.0.outline.color", "polygon", { scoped: true })).toBe(
      shade("#7f3c8d")
    );
    expect(swatchOf(style, "classify.0.classes.1.outline.color", "polygon", { scoped: true })).toBe(
      shade("#e68310")
    );
  });

  it("of an unset icon color in a class reads the layer's hollow marker", () => {
    const style = doc({
      symbol: { marker: { fill: false, color: "#e68310", icon: "goat:park" } },
      classify: [
        { field: "kind", classes: [{ values: ["a"], marker: { color: "#7f3c8d" } }, { values: ["b"] }] },
      ],
      rules: [{ when: { field: "kind", op: "eq", value: "c" }, marker: { color: "#11a5c9" } }],
    });
    expect(swatchOf(style, "classify.0.classes.0.marker.icon_color", "point", { scoped: true })).toBe(
      "#7f3c8d"
    );
    expect(swatchOf(style, "classify.0.classes.1.marker.icon_color", "point", { scoped: true })).toBe(
      "#e68310"
    );
    expect(swatchOf(style, "rules.0.marker.icon_color", "point", { scoped: true })).toBe("#11a5c9");
  });

  it("in a zoom stop is the stop's own derived color, at the zoom of the stop", () => {
    const style = doc({
      symbol: {
        fill: {
          color: {
            zoom: [
              [5, "#7f3c8d"],
              [10, "#ffffff"],
            ],
          },
        },
        outline: {
          color: {
            zoom: [
              [5, "auto"],
              [10, "fill"],
              [12, "#000000"],
            ],
          },
        },
      },
    });
    expect(swatchOf(style, "symbol.outline.color.zoom.0.1", "polygon")).toBe(shade("#7f3c8d"));
    expect(swatchOf(style, "symbol.outline.color.zoom.1.1", "polygon")).toBe("#ffffff");
    expect(swatchOf(style, "symbol.outline.color.zoom.2.1", "polygon")).toBe("#000000");
  });

  it("of an Auto H3 outline shades the hexagons' colors, never the hatch", () => {
    const style = doc({
      render: { type: "h3", palette: ["#7f3c8d", "#e68310"], outline: { color: "auto" } },
    });
    // Before the hexagons' values are computed the map draws the palette's middle color, and its shade around it.
    const swatch = swatchOf(style, "render.outline.color", "point");
    expect(swatch).not.toBe(HATCH);
    expect(swatch).toBe(shade("#e68310"));
  });

  it("over a palette switches where the map's answer switches, never blending through grey", () => {
    const palette = ["#000000", "#ffffff"];
    const style = doc({
      symbol: {
        marker: {
          color: { field: "v", palette, domain: [0, 1] },
          icon: "goat:park",
          icon_color: "auto",
        },
      },
    });
    const swatch = swatchOf(style, "symbol.marker.icon_color", "point");
    // Two answers, each held up to where it changes: hard stops at one position.
    expect(swatch).toMatch(
      /^linear-gradient\(90deg, #ffffff 0%, #ffffff ([\d.]+)%, #3a3541 \1%, #3a3541 100%\)$/
    );
    expect(onColor(palette[0])).toBe("#ffffff");
    expect(onColor(palette[1])).toBe("#3a3541");
  });

  it("of an unset follower shows the hue it draws where asked, the hatch otherwise", () => {
    const style = doc({ symbol: { fill: { color: "#7f3c8d80", pattern: "hatch_45" } } });
    expect(swatchOf(style, "symbol.fill.pattern_color", "polygon")).toBe(HATCH);
    expect(swatchOf(style, "symbol.fill.pattern_color", "polygon", { follow: true })).toBe(
      opaque("#7f3c8d80")
    );
  });

  it("of a color by zoom or by classes resolves each stop's or class's word", () => {
    const byZoom = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        outline: {
          color: {
            zoom: [
              [5, "auto"],
              [12, "#000000"],
            ],
          },
        },
      },
    });
    expect(swatchOf(byZoom, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#7f3c8d")}, #000000)`
    );
    const byClasses = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { width: 1 } },
      classify: [
        {
          field: "kind",
          method: "manual",
          target: "outline.color",
          classes: [
            { to: 3, outline: { color: "auto" }, fill: { color: "#e68310" } },
            { from: 3, outline: { color: "#000000" } },
          ],
        },
      ],
    });
    expect(swatchOf(byClasses, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#e68310")}, #000000)`
    );
  });

  it("in a class that leaves the followed color to the layer follows the layer's own, not the other classes'", () => {
    const style = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000", width: 2 } },
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [
            { values: ["a"], outline: { color: "auto" } },
            { values: ["b"], outline: { color: "fill" }, fill: { color: "#11a579" } },
          ],
        },
      ],
    });
    // As the map and the legend draw it.
    expect(swatchOf(style, "classify.0.classes.0.outline.color", "polygon")).toBe(shade("#7f3c8d"));
    expect(swatchOf(style, "symbol.outline.color", "polygon")).toBe(
      `linear-gradient(90deg, ${shade("#7f3c8d")}, #11a579)`
    );
  });

  it("in a rule, or a class of another classification, follows the classes that set the followed color", () => {
    const k = {
      field: "k",
      method: "categories",
      classes: [
        { values: ["x"], fill: { color: "#11a579" } },
        { values: ["y"], fill: { color: "#e68310" } },
      ],
    };
    const classes = `linear-gradient(90deg, ${shade("#11a579")}, ${shade("#e68310")})`;
    const ruled = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000" } },
      classify: [k],
      rules: [{ when: { op: "=", args: [{ property: "t" }, "a"] }, outline: { color: "auto" } }],
    });
    expect(swatchOf(ruled, "rules.0.outline.color", "polygon")).toBe(classes);
    const two = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000" } },
      classify: [
        k,
        { field: "t", method: "categories", classes: [{ values: ["a"], outline: { color: "auto" } }] },
      ],
    });
    expect(swatchOf(two, "classify.1.classes.0.outline.color", "polygon")).toBe(classes);
  });

  it("of an Auto halo beside a text by zoom shows the halos the map steps through, or the one at a zoom", () => {
    const style = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        label: {
          text: "{n}",
          color: {
            zoom: [
              [8, "#ffffff"],
              [16, "#3a3541"],
            ],
          },
          halo: { color: "auto" },
        },
      },
    });
    for (const tone of ["light", "dark"] as const) {
      const map = drawn(style, "polygon", tone, "label", "text-halo-color");
      const swatch = swatchOf(style, "symbol.label.halo.color", "polygon", { tone, follow: true });
      expect(swatch, tone).not.toBe(HATCH);
      expect(
        offTheMap(swatch, (p) => map({}, 8 + 8 * p)),
        tone
      ).toEqual([]);
      expect(swatchOf(style, "symbol.label.halo.color", "polygon", { tone, zoom: 9 }), tone).toBe(map({}, 9));
    }
    // A text by zoom with Auto at a stop: the text that stop draws, and there the pair's own halo.
    const word = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        label: {
          text: "{n}",
          color: {
            zoom: [
              [8, "#ffffff"],
              [14, "auto"],
            ],
          },
          halo: { color: "auto" },
        },
      },
    });
    for (const tone of ["light", "dark"] as const) {
      const map = drawn(word, "polygon", tone, "label", "text-halo-color");
      const swatch = swatchOf(word, "symbol.label.halo.color", "polygon", { tone, follow: true });
      expect(
        offTheMap(swatch, (p) => map({}, 8 + 6 * p)),
        tone
      ).toEqual([]);
    }
  });

  it("of an Auto halo beside a text by zoom over classes or a palette shows the halos the map steps through for every feature", () => {
    const label = {
      text: "{n}",
      color: {
        zoom: [
          [8, "#ffffff"],
          [16, "#3a3541"],
        ],
      },
      halo: { color: "auto" },
    };
    const styles = {
      classes: doc({
        symbol: { fill: { color: "#7f3c8d" }, label },
        classify: [
          {
            field: "v",
            method: "categories",
            classes: [
              { values: [1], fill: { color: "#11a579" } },
              { values: [2], fill: { color: "#f2b701" } },
            ],
          },
        ],
      }),
      palette: doc({
        symbol: {
          fill: { color: { field: "v", palette: ["#2166ac", "#f7f7f7", "#b2182b"], domain: [0, 2] } },
          label,
        },
      }),
    };
    for (const [name, style] of Object.entries(styles))
      for (const tone of ["light", "dark"] as const) {
        const map = drawn(style, "polygon", tone, "label", "text-halo-color");
        const swatch = swatchOf(style, "symbol.label.halo.color", "polygon", { tone, follow: true });
        expect(swatch, `${name} ${tone}`).not.toBe(HATCH);
        for (const v of [0, 1, 2])
          expect(
            offTheMap(swatch, (p) => map({ v }, 8 + 8 * p)),
            `${name} ${tone} v=${v}`
          ).toEqual([]);
        // A text Auto beside a halo by zoom depends on each feature's color as well: no one swatch, the hatch.
        const text = setIn(style, "symbol.label", {
          text: "{n}",
          color: "auto",
          halo: {
            color: {
              zoom: [
                [8, "#ffffff"],
                [16, "#3a3541"],
              ],
            },
          },
        });
        expect(
          swatchOf(text, "symbol.label.color", "polygon", { tone, follow: true }),
          `${name} ${tone}`
        ).toBe(HATCH);
      }
  });

  it("of an Auto text beside a halo by zoom shows texts the map draws, readable on the halo there", () => {
    const style = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        label: {
          text: "{n}",
          color: "auto",
          halo: {
            color: {
              zoom: [
                [8, "#ffffff"],
                [16, "#3a3541"],
              ],
            },
          },
        },
      },
    });
    for (const tone of ["light", "dark"] as const) {
      const text = drawn(style, "polygon", tone, "label", "text-color");
      const halo = drawn(style, "polygon", tone, "label", "text-halo-color");
      const swatch = swatchOf(style, "symbol.label.color", "polygon", { tone, follow: true });
      expect(swatch, tone).not.toBe(HATCH);
      const off = offTheMap(swatch, (p) => text({}, 8 + 8 * p));
      expect(off.length, `${tone}: ${off.join(", ")}`).toBeLessThanOrEqual(10);
      for (const p of SHARES)
        expect(contrastRatio(cssAt(swatch, p), halo({}, 8 + 8 * p)), `${tone} at ${p}`).toBeGreaterThan(4);
    }
  });

  it("of an Auto number beside a mid-tone halo over a palette steps where the map steps, never blending through grey", () => {
    const style = doc({
      symbol: { marker: { color: "#333333" } },
      render: {
        type: "cluster",
        symbol: {
          marker: { color: { field: "count", palette: ["#2166ac", "#f7f7f7", "#b2182b"], domain: [0, 100] } },
          label: { text: "{count}", color: "auto", halo: { color: "#767676", width: 1 } },
        },
      },
    });
    const map = drawn(style, "point", "light", "cluster-label", "text-color");
    const swatch = swatchOf(style, "render.symbol.label.color", "point", { tone: "light" });
    expect(offTheMap(swatch, (p) => map({ point_count: 100 * p }, 12))).toEqual([]);
    for (const p of SHARES)
      expect(contrastRatio(cssAt(swatch, p), "#767676"), `at ${p}`).toBeGreaterThanOrEqual(4.5);
  });

  it("of an Auto text beside a halo whose width by zoom is 0 below a zoom shows the table's text there, as the map", () => {
    const style = doc({
      symbol: {
        fill: { color: "#7f3c8d" },
        label: {
          text: "{n}",
          color: "auto",
          halo: {
            width: {
              zoom: [
                [8, 0],
                [10, 0],
                [14, 2],
              ],
            },
          },
        },
      },
    });
    const map = drawn(style, "polygon", "dark", "label", "text-color");
    expect(map({}, 9)).toBe("#ffffff");
    const swatch = swatchOf(style, "symbol.label.color", "polygon", { tone: "dark", follow: true });
    expect(offTheMap(swatch, (p) => map({}, 8 + 6 * p))).toEqual([]);
    expect(swatchOf(style, "symbol.label.color", "polygon", { tone: "dark", zoom: 9 })).toBe("#ffffff");
    expect(swatchOf(style, "symbol.label.color", "polygon", { tone: "dark", zoom: 12 })).toBe(map({}, 12));
    // A cluster's number beside a halo of its own whose width by zoom is 0 below a zoom: the on-color there.
    const cluster = doc({
      symbol: { marker: { color: "#333333" } },
      render: {
        type: "cluster",
        symbol: {
          marker: { color: "#fdae61" },
          label: {
            text: "{count}",
            color: "auto",
            halo: {
              color: "#3a3541",
              width: {
                zoom: [
                  [8, 0],
                  [10, 0],
                  [14, 2],
                ],
              },
            },
          },
        },
      },
    });
    const number = drawn(cluster, "point", "light", "cluster-label", "text-color");
    expect(number({ point_count: 10 }, 9)).not.toBe(number({ point_count: 10 }, 12));
    const numbers = swatchOf(cluster, "render.symbol.label.color", "point", { tone: "light" });
    expect(offTheMap(numbers, (p) => number({ point_count: 10 }, 8 + 6 * p))).toEqual([]);
  });

  it("in a class of another classification, as the class list and the scope chip ask for it, follows the classes that set the followed color", () => {
    const style = doc({
      symbol: { fill: { color: "#7f3c8d" }, outline: { color: "#000000" } },
      classify: [
        {
          field: "k",
          method: "categories",
          classes: [
            { values: ["x"], fill: { color: "#11a579" } },
            { values: ["y"], fill: { color: "#e68310" } },
          ],
        },
        { field: "t", method: "categories", classes: [{ values: ["a"], outline: { color: "auto" } }] },
      ],
    });
    const path = "classify.1.classes.0.outline.color";
    const row = swatchOf(style, path, "polygon");
    expect(row).toBe(`linear-gradient(90deg, ${shade("#11a579")}, ${shade("#e68310")})`);
    expect(swatchOf(style, path, "polygon", { scoped: true })).toBe(row);
  });
});
