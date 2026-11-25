import { describe, expect, it } from "vitest";

import {
  LABEL_FALLBACK,
  contrastRatio,
  haloAgainst,
  labelPair,
  onColor,
  shade,
  textAgainst,
} from "@/lib/style/colors";
import { compileLayer } from "@/lib/style/compile";
import { TONE_KEYS, usesTone } from "@/lib/style/compile/derived";
import type { CompileInput, Geometry } from "@/lib/style/compile/types";
import { swatchOf } from "@/lib/style/editor/summaries";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { JsonObject } from "@/lib/style/json";
import { buildLegend } from "@/lib/style/legend";
import type { Tone } from "@/lib/style/tone";

import { evaluate, maplibreErrors } from "./maplibre";

// "auto" on a label's text and halo (a pair chosen for the basemap's tone from the feature's color) and on a marker's
// icon color and a cluster's number (white or dark on the color underneath), spec 18.10.

const tiles = { type: "tiles" as const, id: "s", tiles: ["https://t/{z}/{x}/{y}"] };
const points = { type: "points" as const, id: "s", data: "https://geoapi/collections/9/items?f=json" };
const style = (doc: object) => ({ version: "1.0.0", kind: "vector", ...doc }) as LayerStyle & JsonObject;
const TONES: Tone[] = ["light", "dark"];
const pair = labelPair;

function compile(
  doc: object,
  geometry: Geometry = "polygon",
  tone: Tone = "light",
  source: CompileInput["source"] = tiles
) {
  const out = compileLayer({ id: "1", style: style(doc), geometry, source, tone });
  expect(maplibreErrors(out.layers, out.sources, out.state)).toEqual([]);
  return out;
}
const layer = (out: ReturnType<typeof compile>, id: string) => {
  const found = out.layers.find((l) => l.id === `1-${id}`) as
    | { paint: Record<string, unknown>; layout: Record<string, unknown> }
    | undefined;
  if (!found) throw new Error(`no layer 1-${id} in ${out.layers.map((l) => l.id).join(", ")}`);
  return found;
};
const paint = (out: ReturnType<typeof compile>, id = "label") => layer(out, id).paint;
const labelled = (label: object, rest: object = { fill: { color: "#7f3c8d" } }) => ({
  symbol: { ...rest, label: { text: "{name}", ...label } },
});
const BOTH = { color: "auto", halo: { color: "auto" } };
const ANSWERS = ["#ffffff", "#3a3541"];

/** A color MapLibre evaluated (a hex literal, a Color or its rgba text) as lowercase hex. */
function hexOf(value: unknown): string {
  const text = String(value);
  if (text.startsWith("#")) return text.toLowerCase();
  const [r, g, b] = (text.match(/[\d.]+/g) ?? []).map(Number);
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}
/** A color property MapLibre evaluated at `zoom` for a feature, its hex literals read as colors (so a blend of
 * literals by zoom evaluates outside a style). */
function colorAt(expr: unknown, properties: Record<string, unknown> = {}, zoom = 14): unknown {
  const typed = (e: unknown): unknown =>
    typeof e === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(e)
      ? ["to-color", e]
      : Array.isArray(e) && e[0] !== "literal"
        ? e.map(typed)
        : e;
  return evaluate(typed(expr), properties, zoom);
}
/** The samples of `from` to `to` in steps of `step`. */
const samples = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Number((from + i * step).toFixed(6)));
/** The positions where `answer` changes between neighbouring samples. */
const flips = (xs: number[], answer: (x: number) => string) =>
  xs.slice(1).filter((x, i) => answer(x) !== answer(xs[i]));
/** Every sample where `drawn` differs from `expected` lies within `tolerance` of a flip of `expected`. */
function switchesWhereItFlips(
  xs: number[],
  drawn: (x: number) => string,
  expected: (x: number) => string,
  tolerance: number,
  answers: string[] = ANSWERS
) {
  const at = flips(xs, expected);
  expect(at.length).toBeGreaterThan(0);
  for (const x of xs) {
    expect(answers).toContain(drawn(x));
    if (drawn(x) !== expected(x))
      expect(
        at.some((f) => Math.abs(f - x) <= tolerance),
        `at ${x}`
      ).toBe(true);
  }
}

/** The lowest contrast of the drawn text against the drawn halo over `xs`, and where it is. */
function lowest(xs: number[], text: (x: number) => string, halo: (x: number) => string) {
  let low = { contrast: Infinity, at: NaN };
  for (const x of xs) {
    const contrast = contrastRatio(text(x), halo(x));
    if (contrast < low.contrast) low = { contrast, at: x };
  }
  return low;
}

describe("the label pair", () => {
  for (const tone of TONES) {
    it(`follows a polygon's fill on a ${tone} basemap`, () => {
      const p = paint(compile(labelled(BOTH), "polygon", tone));
      expect([p["text-color"], p["text-halo-color"]]).toEqual([
        pair("#7f3c8d", tone).text,
        pair("#7f3c8d", tone).halo,
      ]);
    });

    it(`follows a line's color and a marker's color on a ${tone} basemap`, () => {
      const line = paint(compile(labelled(BOTH, { line: { color: "#e68310" } }), "line", tone));
      expect([line["text-color"], line["text-halo-color"]]).toEqual([
        pair("#e68310", tone).text,
        pair("#e68310", tone).halo,
      ]);
      const point = paint(compile(labelled(BOTH, { marker: { color: "#f2b701" } }), "point", tone));
      expect([point["text-color"], point["text-halo-color"]]).toEqual([
        pair("#f2b701", tone).text,
        pair("#f2b701", tone).halo,
      ]);
    });
  }

  it("takes the feature's color without its alpha, and the reference fill where none is set", () => {
    const p = paint(compile(labelled(BOTH, { fill: { color: "#7f3c8d00" } }), "polygon", "dark"));
    expect(p["text-halo-color"]).toBe(pair("#7f3c8d", "dark").halo);
    const unset = paint(compile(labelled(BOTH, {}), "polygon"));
    expect(unset["text-color"]).toBe(pair("#2bb381", "light").text);
  });

  it("takes the pair class by class, rule by rule", () => {
    const doc = {
      ...labelled(BOTH, { fill: { color: "#cccccc" } }),
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [{ values: ["a"], fill: { color: "#11a579" } }],
        },
      ],
      rules: [{ name: "R", when: { op: "=", args: [{ property: "t" }, "r"] }, fill: { color: "#3969ac" } }],
    };
    const p = paint(compile(doc, "polygon", "dark"));
    const halo = p["text-halo-color"];
    expect(evaluate(halo, { t: "a" })).toBe(pair("#11a579", "dark").halo);
    expect(evaluate(halo, { t: "r" })).toBe(pair("#3969ac", "dark").halo);
    expect(evaluate(halo, { t: "z" })).toBe(pair("#cccccc", "dark").halo);
    for (const k of ["a", "r", "z"]) expect(evaluate(p["text-color"], { t: k })).toBe("#ffffff");
  });

  it("takes the pair zoom stop by zoom stop and palette stop by palette stop", () => {
    const zoom = paint(
      compile(
        labelled(BOTH, {
          fill: {
            color: {
              zoom: [
                [8, "#ff0000"],
                [14, "#0000ff"],
              ],
            },
          },
        }),
        "polygon"
      )
    );
    expect(zoom["text-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      pair("#ff0000", "light").text,
      14,
      pair("#0000ff", "light").text,
    ]);
    const palette = paint(
      compile(
        labelled(BOTH, { fill: { color: { field: "v", palette: ["#fee8c8", "#e34a33"], domain: [0, 10] } } }),
        "polygon",
        "dark"
      )
    );
    const halo = JSON.stringify(palette["text-halo-color"]);
    expect(halo).toContain("interpolate-lab");
    expect(halo).toContain(pair("#fee8c8", "dark").halo);
    expect(halo).toContain(pair("#e34a33", "dark").halo);
  });

  for (const tone of TONES) {
    it(`draws the documented pair for every feature where the feature's color is read from the data, on a ${tone} basemap`, () => {
      const p = paint(compile(labelled(BOTH, { fill: { color: { field: "c" } } }), "polygon", tone));
      expect([p["text-color"], p["text-halo-color"]]).toEqual([
        LABEL_FALLBACK[tone].text,
        LABEL_FALLBACK[tone].halo,
      ]);
    });
  }

  it("reads a text Auto on the halo the map draws, a set one or the default where the key is absent, and never changes the halo", () => {
    for (const tone of TONES) {
      const set = paint(compile(labelled({ color: "auto", halo: { color: "#222222" } }), "polygon", tone));
      expect([set["text-color"], set["text-halo-color"]]).toEqual([
        textAgainst("#7f3c8d", "#222222", tone),
        "#222222",
      ]);
      const absent = paint(compile(labelled({ color: "auto" }), "polygon", tone));
      expect([absent["text-color"], absent["text-halo-color"]]).toEqual([
        textAgainst("#7f3c8d", "#ffffff", tone),
        "#ffffff",
      ]);
    }
  });

  it("gives a halo Auto beside a set text of any luminance a contrast of at least the floor", () => {
    for (let v = 0; v < 256; v += 3) {
      const text = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
      const p = paint(compile(labelled({ color: text, halo: { color: "auto" } }), "polygon"));
      expect(p["text-halo-color"]).toBe(haloAgainst(text));
      expect(contrastRatio(text, p["text-halo-color"] as string), text).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("contrasts a halo Auto with a set or absent text, whatever the tone, and never changes the text", () => {
    for (const tone of TONES) {
      const dark = paint(compile(labelled({ color: "#3a3541", halo: { color: "auto" } }), "polygon", tone));
      expect([dark["text-color"], dark["text-halo-color"]]).toEqual(["#3a3541", "#ffffff"]);
      const light = paint(compile(labelled({ color: "#f0f0f0", halo: { color: "auto" } }), "polygon", tone));
      expect([light["text-color"], light["text-halo-color"]]).toEqual(["#f0f0f0", "#3a3541"]);
      const absent = paint(compile(labelled({ halo: { color: "auto" } }), "polygon", tone));
      expect(absent["text-halo-color"]).toBe("#ffffff");
    }
  });

  it("gives a halo Auto per feature: the pair's halo where the text is Auto, else one contrasting with the text", () => {
    const doc = {
      ...labelled({ color: "auto", halo: { color: "auto" } }, { fill: { color: "#7f3c8d" } }),
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [
            { values: ["light"], label: { color: "#f0f0f0" } },
            { values: ["green"], fill: { color: "#11a579" } },
          ],
        },
      ],
    };
    const p = paint(compile(doc, "polygon", "dark"));
    expect(evaluate(p["text-color"], { t: "light" })).toBe("#f0f0f0");
    expect(evaluate(p["text-halo-color"], { t: "light" })).toBe("#3a3541");
    expect(evaluate(p["text-halo-color"], { t: "green" })).toBe(pair("#11a579", "dark").halo);
    expect(evaluate(p["text-halo-color"], { t: "other" })).toBe(pair("#7f3c8d", "dark").halo);
  });

  // A halo Auto beside a set text contrasts with the text as MapLibre draws it: the one of white and dark with the
  // higher contrast, black where neither reaches the floor.
  function haloBesideText(color: unknown, positions: number[], at: (expr: unknown, x: number) => unknown) {
    const p = paint(compile(labelled({ color, halo: { color: "auto" } }), "polygon"));
    const text = (x: number) => hexOf(at(p["text-color"], x));
    const halo = (x: number) => hexOf(at(p["text-halo-color"], x));
    switchesWhereItFlips(positions, halo, (x) => haloAgainst(text(x)), positions[1] - positions[0], [
      ...ANSWERS,
      "#000000",
    ]);
    for (const x of positions) expect(contrastRatio(text(x), halo(x)), `at ${x}`).toBeGreaterThanOrEqual(4.5);
  }

  it("switches a halo Auto beside a text by zoom where its answer flips, the floor held at every zoom", () => {
    haloBesideText(
      {
        zoom: [
          [8, "#000000"],
          [14, "#ffffff"],
        ],
      },
      samples(8, 14, 0.01),
      (expr, z) => colorAt(expr, {}, z)
    );
  });

  it("switches a halo Auto beside a text by palette where its answer flips, the floor held everywhere", () => {
    haloBesideText(
      { field: "v", palette: ["#000000", "#ffffff"], domain: [0, 10] },
      samples(0, 10, 0.01),
      (expr, v) => evaluate(expr, { v })
    );
  });

  it("gives a halo Auto beside a text Auto at one zoom stop one of its colors at every zoom", () => {
    for (const tone of TONES) {
      const p = paint(
        compile(
          labelled({
            color: {
              zoom: [
                [8, "#000000"],
                [14, "auto"],
              ],
            },
            halo: { color: "auto" },
          }),
          "polygon",
          tone
        )
      );
      for (const z of samples(8, 14, 0.05))
        expect([...ANSWERS, "#000000", pair("#7f3c8d", tone).halo]).toContain(
          hexOf(colorAt(p["text-halo-color"], {}, z))
        );
    }
  });

  it("gives a halo Auto beside a text read from the data on-color's documented white for every feature", () => {
    const raw = paint(
      compile(labelled({ color: { field: "c" }, halo: { color: "auto" } }), "polygon", "dark")
    );
    expect(raw["text-halo-color"]).toBe("#ffffff");
  });

  it("meets the contrast floor with both on Auto for every layer color and hard color, on both tones", () => {
    const colors = ["#7f3c8d", "#11a579", "#3969ac", "#f2b701", "#e73f74", "#80ba5a", "#e68310", "#008695"];
    colors.push("#cf1c90", "#f97b72", "#ffffff", "#000000", "#2bb381", "#808080");
    for (const color of colors)
      for (const tone of TONES) {
        const p = paint(compile(labelled(BOTH, { fill: { color } }), "polygon", tone));
        expect(
          contrastRatio(p["text-color"] as string, p["text-halo-color"] as string)
        ).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("lets the lines of a label without their own color take the text's", () => {
    const out = compile(
      labelled({ ...BOTH, lines: [{ size: 14 }, { color: "#ff0000" }], text: "{a}\n{b}" }),
      "polygon",
      "light"
    );
    const field = JSON.stringify(layer(out, "label").layout["text-field"]);
    expect(field).toContain('"text-color":"#ff0000"');
    expect(field.match(/text-color/g)).toHaveLength(1);
    expect(paint(out)["text-color"]).toBe(pair("#7f3c8d", "light").text);
  });

  it("keeps the colors where the keys are absent or set", () => {
    const absent = paint(compile(labelled({}), "polygon", "dark"));
    expect([absent["text-color"], absent["text-halo-color"]]).toEqual(["#3a3541", "#ffffff"]);
    const set = paint(compile(labelled({ color: "#123456", halo: { color: "#abcdef" } }), "polygon", "dark"));
    expect([set["text-color"], set["text-halo-color"]]).toEqual(["#123456", "#abcdef"]);
  });
});

describe("a text Auto beside the halo the map draws", () => {
  const FILLS = ["#7f3c8d", "#ffd400", "#2bb381", "#2166ac", "#ffffff", "#000000"];
  const HALOS = ["#ffffff", "#3a3541", "#000000", "#808080", "#e7298a", "#222222"];
  const cat = (classes: object[]) => [{ field: "t", method: "categories", classes }];
  const when = (value: string) => ({ op: "=", args: [{ property: "t" }, value] });

  it("is read on the halo for every feature color, the floor held, on both tones", () => {
    for (const tone of TONES)
      for (const fill of FILLS)
        for (const halo of [...HALOS, fill]) {
          const p = paint(
            compile(
              labelled({ color: "auto", halo: { color: halo } }, { fill: { color: fill } }),
              "polygon",
              tone
            )
          );
          expect(p["text-halo-color"]).toBe(halo);
          expect(p["text-color"], `${fill} ${halo} ${tone}`).toBe(textAgainst(fill, halo, tone));
          expect(contrastRatio(p["text-color"] as string, halo)).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("is read on the default halo where the halo key is absent: on a dark basemap a readable shade against white, on a light one the table's text", () => {
    for (const fill of ["#ffd400", "#2bb381", "#2166ac", ...FILLS])
      for (const tone of TONES)
        for (const halo of [undefined, { width: 2 }]) {
          const p = paint(
            compile(
              labelled({ color: "auto", ...(halo ? { halo } : {}) }, { fill: { color: fill } }),
              "polygon",
              tone
            )
          );
          // MapLibre draws the reference halo where the style sets none.
          const drawn = (p["text-halo-color"] as string | undefined) ?? "#ffffff";
          expect(drawn).toBe("#ffffff");
          expect(p["text-color"], `${fill} ${tone}`).toBe(
            tone === "dark" ? textAgainst(fill, "#ffffff", "dark") : pair(fill, "light").text
          );
          expect(contrastRatio(p["text-color"] as string, drawn)).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("reads a halo with its own transparency by its opaque color, and follows the table beside a None halo or one of width 0", () => {
    for (const tone of TONES) {
      const alpha = paint(
        compile(labelled({ color: "auto", halo: { color: "#22222280" } }), "polygon", tone)
      );
      expect(alpha["text-color"]).toBe(textAgainst("#7f3c8d", "#222222", tone));
      const none = paint(compile(labelled({ color: "auto", halo: { color: "#22222200" } }), "polygon", tone));
      expect(none["text-color"]).toBe(pair("#7f3c8d", tone).text);
      const off = paint(
        compile(labelled({ color: "auto", halo: { color: "#222222", width: 0 } }), "polygon", tone)
      );
      expect(off["text-color"]).toBe(pair("#7f3c8d", tone).text);
    }
  });

  it("answers class by class: a halo by classes, a feature color by classes, both", () => {
    for (const tone of TONES) {
      const byHalo = paint(
        compile(
          {
            ...labelled({ color: "auto", halo: { color: "#ffffff" } }),
            classify: cat([{ values: ["a"], label: { halo: { color: "#3a3541" } } }]),
          },
          "polygon",
          tone
        )
      );
      expect(evaluate(byHalo["text-color"], { t: "a" })).toBe(textAgainst("#7f3c8d", "#3a3541", tone));
      expect(evaluate(byHalo["text-color"], { t: "z" })).toBe(textAgainst("#7f3c8d", "#ffffff", tone));
      const byFill = paint(
        compile(
          {
            ...labelled({ color: "auto", halo: { color: "#3a3541" } }),
            classify: cat([{ values: ["a"], fill: { color: "#ffffff" } }]),
          },
          "polygon",
          tone
        )
      );
      expect(evaluate(byFill["text-color"], { t: "a" })).toBe(textAgainst("#ffffff", "#3a3541", tone));
      expect(evaluate(byFill["text-color"], { t: "z" })).toBe(textAgainst("#7f3c8d", "#3a3541", tone));
      const both = paint(
        compile(
          {
            ...labelled({ color: "auto", halo: { color: "#ffffff" } }),
            classify: cat([
              { values: ["a"], fill: { color: "#ffd400" }, label: { halo: { color: "#000000" } } },
              { values: ["b"], fill: { color: "#2166ac" }, label: { halo: { color: "#808080" } } },
            ]),
          },
          "polygon",
          tone
        )
      );
      for (const [t, fill, halo] of [
        ["a", "#ffd400", "#000000"],
        ["b", "#2166ac", "#808080"],
        ["z", "#7f3c8d", "#ffffff"],
      ]) {
        expect(evaluate(both["text-color"], { t })).toBe(textAgainst(fill, halo, tone));
        expect(contrastRatio(textAgainst(fill, halo, tone), halo)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("answers palette stop by palette stop over a continuous palette, the floor held everywhere", () => {
    for (const tone of TONES)
      for (const halo of HALOS)
        for (const palette of [
          ["#fee8c8", "#e34a33"],
          ["#000000", "#ffffff"],
          ["#ffd400", "#2166ac"],
        ]) {
          const fill = { color: { field: "v", palette, domain: [0, 10] } };
          const p = paint(
            compile(labelled({ color: "auto", halo: { color: halo } }, { fill }), "polygon", tone)
          );
          expect(hexOf(evaluate(p["text-color"], { v: 0 }))).toBe(textAgainst(palette[0], halo, tone));
          expect(hexOf(evaluate(p["text-color"], { v: 10 }))).toBe(textAgainst(palette[1], halo, tone));
          for (const v of samples(0, 10, 0.25))
            expect(
              contrastRatio(hexOf(evaluate(p["text-color"], { v })), halo),
              `${palette} ${halo} ${tone} at ${v}`
            ).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("switches beside a halo by zoom where its answer flips, the floor held at every zoom", () => {
    for (const tone of TONES)
      for (const fill of ["#7f3c8d", "#ffd400", "#ffffff"]) {
        const p = paint(
          compile(
            labelled(
              {
                color: "auto",
                halo: {
                  color: {
                    zoom: [
                      [8, "#ffffff"],
                      [14, "#000000"],
                    ],
                  },
                },
              },
              { fill: { color: fill } }
            ),
            "polygon",
            tone
          )
        );
        const zooms = samples(8, 14, 0.01);
        const halo = (z: number) => hexOf(colorAt(p["text-halo-color"], {}, z));
        const text = (z: number) => hexOf(colorAt(p["text-color"], {}, z));
        const expected = (z: number) => textAgainst(fill, halo(z), tone);
        switchesWhereItFlips(zooms, text, expected, 0.01, [...new Set(zooms.map(expected))]);
        for (const z of zooms)
          expect(contrastRatio(text(z), halo(z)), `${fill} ${tone} at ${z}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("steps each class's answer a few times between the stops of a halo by zoom, never blending to the halo", () => {
    for (const tone of TONES) {
      const p = paint(
        compile(
          {
            ...labelled({
              color: "auto",
              halo: {
                color: {
                  zoom: [
                    [8, "#ffffff"],
                    [14, "#3a3541"],
                  ],
                },
              },
            }),
            classify: cat([{ values: ["a"], fill: { color: "#ffd400" } }]),
          },
          "polygon",
          tone
        )
      );
      const text = p["text-color"] as unknown[];
      // A step on the zoom: at most four steps between two stops of the halo.
      expect(text[0]).toBe("step");
      expect((text.length - 3) / 2).toBeLessThanOrEqual(4);
      for (const [t, fill] of [
        ["a", "#ffd400"],
        ["z", "#7f3c8d"],
      ]) {
        expect(hexOf(colorAt(text, { t }, 8))).toBe(textAgainst(fill, "#ffffff", tone));
        expect(hexOf(colorAt(text, { t }, 14))).toBe(textAgainst(fill, "#3a3541", tone));
        const low = lowest(
          samples(6, 16, 0.01),
          (z) => hexOf(colorAt(text, { t }, z)),
          (z) => hexOf(colorAt(p["text-halo-color"], { t }, z))
        );
        expect(low.contrast, `${t} ${tone} at ${low.at}`).toBeGreaterThan(2);
      }
    }
  });

  it("draws the documented text beside a set halo where the feature's color is read from the data, else the last step", () => {
    for (const tone of TONES)
      for (const halo of HALOS) {
        const p = paint(
          compile(
            labelled({ color: "auto", halo: { color: halo } }, { fill: { color: { field: "c" } } }),
            "polygon",
            tone
          )
        );
        expect(p["text-color"]).toBe(textAgainst("", halo, tone));
        expect(contrastRatio(p["text-color"] as string, halo)).toBeGreaterThanOrEqual(4.5);
      }
    const light = paint(
      compile(
        labelled({ color: "auto", halo: { color: "#ffffff" } }, { fill: { color: { field: "c" } } }),
        "polygon",
        "light"
      )
    );
    expect(light["text-color"]).toBe(LABEL_FALLBACK.light.text);
  });

  it("grows with the number of classes where the halo and the feature's color are set in every class", () => {
    const classes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        values: [`c${i}`],
        fill: { color: `#${((0x102030 + i * 0x030507) % 0xffffff).toString(16).padStart(6, "0")}` },
        // A halo color of its own in every class.
        label: { halo: { color: `#${(0xf0f0f0 - i * 0x010101).toString(16).padStart(6, "0")}` } },
      }));
    const size = (n: number) =>
      JSON.stringify(
        paint(
          compile(
            { ...labelled({ color: "auto", halo: { color: "#ffffff" } }), classify: cat(classes(n)) },
            "polygon",
            "dark"
          )
        )["text-color"]
      ).length;
    expect(size(60)).toBeLessThan(5000);
    expect(size(120)).toBeLessThan(2.5 * size(60));
    // Beside a halo by zoom: every class's answer at a few steps between the halo's stops.
    const byZoom = (n: number) =>
      JSON.stringify(
        paint(
          compile(
            {
              ...labelled({
                color: "auto",
                halo: {
                  color: {
                    zoom: [
                      [8, "#ffffff"],
                      [14, "#3a3541"],
                    ],
                  },
                },
              }),
              classify: cat(classes(n).map(({ label: _, ...rest }) => rest)),
            },
            "polygon",
            "dark"
          )
        )["text-color"]
      ).length;
    expect(byZoom(120)).toBeLessThan(2.5 * byZoom(60));
    expect(byZoom(60)).toBeLessThan(8 * size(60));
  });

  it("shows in the panel's swatch for the text what the map draws", () => {
    for (const tone of TONES) {
      const doc = style(
        labelled({ color: "auto", halo: { color: "#3a3541" } }, { fill: { color: "#ffd400" } })
      );
      expect(swatchOf(doc, "symbol.label.color", "polygon", { tone })).toBe(
        textAgainst("#ffd400", "#3a3541", tone)
      );
      const none = style(
        labelled({ color: "auto", halo: { color: "#3a354100" } }, { fill: { color: "#ffd400" } })
      );
      expect(swatchOf(none, "symbol.label.color", "polygon", { tone })).toBe(pair("#ffd400", tone).text);
      const off = style(
        labelled({ color: "auto", halo: { color: "#3a3541", width: 0 } }, { fill: { color: "#ffd400" } })
      );
      expect(swatchOf(off, "symbol.label.color", "polygon", { tone })).toBe(pair("#ffd400", tone).text);
      const absent = style(labelled({ color: "auto" }, { fill: { color: "#ffd400" } }));
      expect(swatchOf(absent, "symbol.label.color", "polygon", { tone })).toBe(
        textAgainst("#ffd400", "#ffffff", tone)
      );
      const inClass = style({
        ...labelled({ color: "auto", halo: { color: "#ffffff" } }),
        classify: cat([{ values: ["a"], fill: { color: "#ffd400" }, label: { halo: { color: "#000000" } } }]),
      });
      // A cluster's number: on-color where the cluster label has no halo or the number sits on a badge, else read on
      // the halo, the default one where only a width is set.
      const cluster = (label: object, count?: string) =>
        style({
          render: {
            type: "cluster",
            ...(count ? { count } : {}),
            symbol: { marker: { color: "#2166ac" }, label: { text: "{count}", color: "auto", ...label } },
          },
        });
      const number = (doc: LayerStyle & JsonObject) =>
        swatchOf(doc, "render.symbol.label.color", "point", { tone, follow: true });
      expect(number(cluster({}))).toBe("#ffffff");
      expect(number(cluster({ halo: { color: "#ffffff", width: 1 } }, "badge"))).toBe("#ffffff");
      expect(number(cluster({ halo: { width: 1 } }))).toBe(
        textAgainst("#2166ac", "#ffffff", tone, "#ffffff")
      );
      expect(number(cluster({ halo: { color: "#ffffff", width: 0 } }))).toBe("#ffffff");
      // The class's text row reads its swatch as the color row does: from the document, at the class's path.
      expect(swatchOf(inClass, "classify.0.classes.0.label.color", "polygon", { tone, follow: true })).toBe(
        textAgainst("#ffd400", "#000000", tone)
      );
    }
  });

  it("follows the table in a record whose halo has width 0, reads the others on their halo, and shows the same in the panel", () => {
    for (const tone of TONES)
      for (const [base, inClass] of [
        [1.5, 0],
        [0, 1.5],
      ]) {
        const doc = style({
          ...labelled(
            { color: "auto", halo: { color: "#3a3541", width: base } },
            { fill: { color: "#ffd400" } }
          ),
          classify: cat([{ values: ["a"], label: { halo: { width: inClass } } }]),
        });
        const p = paint(compile(doc, "polygon", tone));
        const expected = (width: number) =>
          width === 0 ? pair("#ffd400", tone).text : textAgainst("#ffd400", "#3a3541", tone);
        expect(evaluate(p["text-color"], { t: "a" })).toBe(expected(inClass));
        expect(evaluate(p["text-color"], { t: "z" })).toBe(expected(base));
        expect(swatchOf(doc, "classify.0.classes.0.label.color", "polygon", { tone, follow: true })).toBe(
          expected(inClass)
        );
        expect(swatchOf(doc, "symbol.label.color", "polygon", { tone, follow: true })).toBe(expected(base));
      }
    // On a dark basemap the features without a halo get the table's white; the others are read on the white halo.
    for (const [doc, off, on] of [
      [
        {
          ...labelled({ color: "auto", halo: { width: 0 } }),
          classify: cat([{ values: ["a"], label: { halo: { width: 2 } } }]),
        },
        "z",
        "a",
      ],
      [
        { ...labelled({ color: "auto" }), classify: cat([{ values: ["a"], label: { halo: { width: 0 } } }]) },
        "a",
        "z",
      ],
    ] as const) {
      const p = paint(compile(doc, "polygon", "dark"));
      expect(evaluate(p["text-color"], { t: off })).toBe("#ffffff");
      expect(evaluate(p["text-color"], { t: on })).toBe(textAgainst("#7f3c8d", "#ffffff", "dark"));
    }
  });

  it("reads the text on a halo whose width by zoom grows from 0 wherever it is drawn, and on none where it stays 0", () => {
    for (const tone of TONES) {
      // The default halo fading in from zoom 8.
      const grows = paint(
        compile(
          labelled({
            color: "auto",
            halo: {
              width: {
                zoom: [
                  [8, 0],
                  [14, 2],
                ],
              },
            },
          }),
          "polygon",
          tone
        )
      );
      const low = lowest(
        samples(8.01, 16, 0.01),
        (z) => hexOf(colorAt(grows["text-color"], {}, z)),
        (z) => hexOf(colorAt(grows["text-halo-color"] ?? "#ffffff", {}, z))
      );
      expect(low.contrast, `${tone} at ${low.at}`).toBeGreaterThanOrEqual(4.5);
      expect(hexOf(colorAt(grows["text-color"], {}, 7))).toBe(pair("#7f3c8d", tone).text);
      // Width 0 at two neighbouring stops: no halo between them, the table's text.
      const stays = paint(
        compile(
          labelled({
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
          }),
          "polygon",
          tone
        )
      );
      expect(hexOf(colorAt(stays["text-color"], {}, 9))).toBe(pair("#7f3c8d", tone).text);
      expect(hexOf(colorAt(stays["text-color"], {}, 12))).toBe(textAgainst("#7f3c8d", "#ffffff", tone));
      // The panel reads the halo as drawn where its width grows, as none where every stop is 0.
      const doc = (width: object) =>
        style(labelled({ color: "auto", halo: { width } }, { fill: { color: "#7f3c8d" } }));
      expect(
        swatchOf(
          doc({
            zoom: [
              [8, 0],
              [14, 2],
            ],
          }),
          "symbol.label.color",
          "polygon",
          { tone, follow: true }
        )
      ).toBe(textAgainst("#7f3c8d", "#ffffff", tone));
      expect(
        swatchOf(
          doc({
            zoom: [
              [8, 0],
              [14, 0],
            ],
          }),
          "symbol.label.color",
          "polygon",
          { tone, follow: true }
        )
      ).toBe(pair("#7f3c8d", tone).text);
      const none = paint(
        compile(
          labelled({
            color: "auto",
            halo: {
              width: {
                zoom: [
                  [8, 0],
                  [14, 0],
                ],
              },
            },
          }),
          "polygon",
          tone
        )
      );
      expect(none["text-color"]).toBe(pair("#7f3c8d", tone).text);
    }
  });

  it("steps where a palette's answers turn from lighter to darker than the halo, never blending through it", () => {
    const label = paint(
      compile(
        labelled(
          { color: "auto", halo: { color: "#588017" } },
          { fill: { color: { field: "v", palette: ["#598bfb", "#6c0055"], domain: [0, 10] } } }
        ),
        "polygon",
        "light"
      )
    );
    const low = lowest(
      samples(0, 10, 0.01),
      (v) => hexOf(evaluate(label["text-color"], { v })),
      () => "#588017"
    );
    expect(low.contrast, `at ${low.at}`).toBeGreaterThanOrEqual(4.5);
    const cluster = compile(
      {
        render: {
          type: "cluster",
          symbol: {
            marker: {
              color: { field: "count", palette: ["#ffffff", "#000000"], domain: [0, 100] },
              size: 20,
            },
            label: { text: "{count}", color: "auto", halo: { color: "#767676", width: 1 } },
          },
        },
      },
      "point",
      "light",
      points
    );
    const number = paint(cluster, "cluster-label")["text-color"];
    const lowNumber = lowest(
      samples(0, 100, 0.05),
      (n) => hexOf(evaluate(number, { point_count: n })),
      () => "#767676"
    );
    expect(lowNumber.contrast, `at ${lowNumber.at}`).toBeGreaterThanOrEqual(4.5);
  });

  it("switches exactly where the answer changes beside a halo by zoom over a feature color by zoom", () => {
    for (const tone of TONES) {
      const p = paint(
        compile(
          labelled(
            {
              color: "auto",
              halo: {
                color: {
                  zoom: [
                    [8, "#ffffff"],
                    [12, "#3a3541"],
                    [16, "#ffd400"],
                  ],
                },
              },
            },
            {
              fill: {
                color: {
                  zoom: [
                    [6, "#2166ac"],
                    [14, "#ffd400"],
                  ],
                },
              },
            }
          ),
          "polygon",
          tone
        )
      );
      const zooms = samples(5, 17, 0.01);
      const text = (z: number) => hexOf(colorAt(p["text-color"], {}, z));
      const halo = (z: number) => hexOf(colorAt(p["text-halo-color"], {}, z));
      const fill = (z: number) =>
        hexOf(colorAt(["interpolate", ["linear"], ["zoom"], 6, "#2166ac", 14, "#ffd400"], {}, z));
      const low = lowest(zooms, text, halo);
      expect(low.contrast, `${tone} at ${low.at}`).toBeGreaterThanOrEqual(4.4);
      const off = zooms.filter((z) => text(z) !== textAgainst(fill(z), halo(z), tone));
      expect(off.length / zooms.length, tone).toBeLessThan(0.1);
      expect(JSON.stringify(p["text-color"]).length).toBeLessThan(40000);
    }
  });

  it("answers per class and palette stop beside a halo by classes over a palette, and in a rule", () => {
    const palette = ["#fee8c8", "#2166ac"];
    const fill = { color: { field: "v", palette, domain: [0, 10] } };
    for (const tone of TONES) {
      const byClasses = paint(
        compile(
          {
            ...labelled({ color: "auto", halo: { color: "#ffffff" } }, { fill }),
            classify: cat([{ values: ["a"], label: { halo: { color: "#3a3541" } } }]),
          },
          "polygon",
          tone
        )
      );
      const inRule = paint(
        compile(
          {
            ...labelled({ color: "auto", halo: { color: "#ffffff" } }, { fill }),
            rules: [{ name: "A", when: when("a"), label: { halo: { color: "#3a3541" } } }],
          },
          "polygon",
          tone
        )
      );
      for (const p of [byClasses, inRule])
        for (const [t, halo] of [
          ["a", "#3a3541"],
          ["z", "#ffffff"],
        ]) {
          expect(hexOf(evaluate(p["text-color"], { t, v: 0 }))).toBe(textAgainst(palette[0], halo, tone));
          expect(hexOf(evaluate(p["text-color"], { t, v: 10 }))).toBe(textAgainst(palette[1], halo, tone));
          for (const v of samples(0, 10, 0.5))
            expect(
              contrastRatio(hexOf(evaluate(p["text-color"], { t, v })), halo),
              `${t} ${tone} at ${v}`
            ).toBeGreaterThanOrEqual(4.5);
        }
    }
  });

  it("answers per palette stop at each stop of a halo by zoom over a palette, stepping a few times between the stops", () => {
    const palette = ["#fee8c8", "#2166ac"];
    for (const tone of TONES) {
      const p = paint(
        compile(
          labelled(
            {
              color: "auto",
              halo: {
                color: {
                  zoom: [
                    [8, "#ffffff"],
                    [14, "#3a3541"],
                  ],
                },
              },
            },
            { fill: { color: { field: "v", palette, domain: [0, 10] } } }
          ),
          "polygon",
          tone
        )
      );
      for (const [v, color] of [
        [0, palette[0]],
        [10, palette[1]],
      ] as const) {
        expect(hexOf(colorAt(p["text-color"], { v }, 8))).toBe(textAgainst(color, "#ffffff", tone));
        expect(hexOf(colorAt(p["text-color"], { v }, 14))).toBe(textAgainst(color, "#3a3541", tone));
      }
      for (const v of [0, 2.5, 5, 7.5, 10]) {
        const low = lowest(
          samples(6, 16, 0.01),
          (z) => hexOf(colorAt(p["text-color"], { v }, z)),
          (z) => hexOf(colorAt(p["text-halo-color"], { v }, z))
        );
        expect(low.contrast, `${tone} v ${v} at ${low.at}`).toBeGreaterThan(2);
      }
    }
  });
});

describe("on-color", () => {
  const icon = (marker: object, extra: object = {}) => ({
    symbol: { marker: { shape: "square", icon: "goat:park", ...marker } },
    ...extra,
  });

  it("draws an Auto icon white or dark on its marker, the same on both tones", () => {
    for (const [color, expected] of [
      ["#2bb381", "#ffffff"],
      ["#f2b701", "#3a3541"],
      ["#000000", "#ffffff"],
    ]) {
      for (const tone of TONES) {
        const name = layer(compile(icon({ color, icon_color: "auto" }), "point", tone), "marker").layout[
          "icon-image"
        ];
        expect(name).toBe(`goat-marker:square|8|goat:park|${color}||0|${expected}`);
      }
    }
  });

  it("keeps the marker's hue for an Auto icon on a hollow marker, also where one class makes it hollow", () => {
    const hollow = layer(
      compile(icon({ color: "#f2b701", fill: false, icon_color: "auto" }), "point"),
      "marker"
    );
    expect(hollow.layout["icon-image"]).toBe("goat-marker:square|8|goat:park|||0|#f2b701");
    const doc = icon(
      { color: "#f2b701", icon_color: "auto" },
      {
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["h"], marker: { fill: false } }] },
        ],
      }
    );
    const name = layer(compile(doc, "point"), "marker").layout["icon-image"];
    expect(evaluate(name, { t: "h" })).toBe("goat-marker:square|8|goat:park|||0|#f2b701");
    expect(evaluate(name, { t: "x" })).toBe("goat-marker:square|8|goat:park|#f2b701||0|#3a3541");
  });

  it("answers per class", () => {
    const doc = icon(
      { color: "#2bb381", icon_color: "auto" },
      {
        classify: [
          { field: "t", method: "categories", classes: [{ values: ["y"], marker: { color: "#f2b701" } }] },
        ],
      }
    );
    const name = layer(compile(doc, "point"), "marker").layout["icon-image"];
    expect(evaluate(name, { t: "y" })).toBe("goat-marker:square|8|goat:park|#f2b701||0|#3a3541");
    expect(evaluate(name, { t: "n" })).toBe("goat-marker:square|8|goat:park|#2bb381||0|#ffffff");
  });

  it("switches over a palette where the marker's color, blended as the map blends it, flips the answer", () => {
    for (const palette of [
      ["#000000", "#ffffff"],
      ["#fee8c8", "#e34a33", "#7f0000"],
      ["#2bb381", "#f2b701"],
    ]) {
      const ramp = icon({ color: { field: "v", palette, domain: [0, 10] }, icon_color: "auto" });
      const image = layer(compile(ramp, "point"), "marker").layout["icon-image"];
      const parts = (v: number) => String(evaluate(image, { v })).split("|");
      expect(JSON.stringify(image)).not.toContain(
        '"interpolate-lab",["linear"],["to-number",["get","v"],0],0,"#'
      );
      switchesWhereItFlips(
        samples(0, 10, 0.02),
        (v) => parts(v)[6],
        (v) => onColor(hexOf(parts(v)[3])),
        10 / 64 + 0.02
      );
    }
  });

  it("gives each whole zoom's marker image the icon of its own marker color, over a color by zoom", () => {
    const doc = icon({
      color: {
        zoom: [
          [8, "#000000"],
          [14, "#ffffff"],
        ],
      },
      icon_color: "auto",
    });
    const name = layer(compile(doc, "point"), "marker").layout["icon-image"] as unknown[];
    expect(name[0]).toBe("step");
    const names = name.slice(2).filter((_, i) => i % 2 === 0) as string[];
    // One image per whole zoom, as the marker's color is drawn.
    expect(name.filter((_, i) => i > 2 && i % 2 === 1)).toEqual([9, 10, 11, 12, 13, 14]);
    for (const n of names) {
      const parts = n.split("|");
      expect(parts[6]).toBe(onColor(parts[3]));
    }
  });

  it("gives white for every feature where the marker's color is read from the data", () => {
    const name = layer(compile(icon({ color: { field: "c" }, icon_color: "auto" }), "point"), "marker")
      .layout["icon-image"];
    expect(JSON.stringify(name)).toMatch(/"\|\|0\|#ffffff"\]$/);
    expect(String(evaluate(name, {})).split("|").pop()).toBe("#ffffff");
  });

  it("keeps a filled marker's white icon where the icon color is absent", () => {
    const name = layer(compile(icon({ color: "#f2b701" }), "point"), "marker").layout["icon-image"];
    expect(name).toBe("goat-marker:square|8|goat:park|#f2b701||0|#ffffff");
  });
});

describe("a cluster's number", () => {
  const cluster = (render: object, base: object = {}) => ({
    ...base,
    render: { type: "cluster", ...render },
  });

  it("draws an Auto number white or dark on the cluster's marker, and its halo Auto contrasting with it", () => {
    for (const tone of TONES) {
      const out = compile(
        cluster({
          symbol: {
            marker: { color: "#f2b701", size: 20 },
            label: { text: "{count}", color: "auto", halo: { color: "auto", width: 1 } },
          },
        }),
        "point",
        tone,
        points
      );
      const p = paint(out, "cluster-label");
      expect([p["text-color"], p["text-halo-color"]]).toEqual(["#3a3541", "#ffffff"]);
    }
  });

  it("reads an Auto number beside a halo the cluster symbol sets on that halo, its on-color first, on both tones", () => {
    for (const tone of TONES)
      for (const [marker, halo] of [
        ["#f2b701", "#000000"],
        ["#f2b701", "#ffffff"],
        ["#2166ac", "#ffffff"],
        ["#2166ac", "#808080"],
        ["#2166ac", "#000000"],
      ]) {
        const out = compile(
          cluster({
            symbol: {
              marker: { color: marker, size: 20 },
              label: { text: "{count}", color: "auto", halo: { color: halo, width: 1 } },
            },
          }),
          "point",
          tone,
          points
        );
        const p = paint(out, "cluster-label");
        expect(p["text-color"], `${marker} ${halo}`).toBe(textAgainst(marker, halo, tone, onColor(marker)));
        expect(contrastRatio(p["text-color"] as string, halo)).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("reads an Auto number on the default halo where the cluster's halo sets only a width, and on none without a halo", () => {
    for (const tone of TONES) {
      const withWidth = compile(
        cluster({
          symbol: {
            marker: { color: "#2166ac", size: 20 },
            label: { text: "{count}", color: "auto", halo: { width: 1 } },
          },
        }),
        "point",
        tone,
        points
      );
      expect(paint(withWidth, "cluster-label")["text-color"]).toBe(
        textAgainst("#2166ac", "#ffffff", tone, onColor("#2166ac"))
      );
      const without = compile(
        cluster({
          symbol: { marker: { color: "#2166ac", size: 20 }, label: { text: "{count}", color: "auto" } },
        }),
        "point",
        tone,
        points
      );
      expect(paint(without, "cluster-label")["text-color"]).toBe("#ffffff");
    }
  });

  it("draws an Auto number on a badge on the badge's color whatever halo the symbol sets, as the badge has none", () => {
    const out = compile(
      cluster({
        count: "badge",
        symbol: {
          marker: { color: "#f2b701" },
          label: { text: "{count}", color: "auto", halo: { color: "#000000", width: 1 } },
        },
      }),
      "point",
      "light",
      points
    );
    expect(paint(out, "cluster-badge")["text-color"]).toBe("#3a3541");
  });

  it("contrasts the halo Auto with a set number", () => {
    const out = compile(
      cluster({
        symbol: {
          marker: { color: "#f2b701" },
          label: { text: "{count}", color: "#000000", halo: { color: "auto" } },
        },
      }),
      "point",
      "light",
      points
    );
    expect(paint(out, "cluster-label")["text-halo-color"]).toBe("#ffffff");
  });

  it("takes the color of the points' marker for clusters drawn like them", () => {
    const out = compile(
      cluster(
        { look: "points", symbol: { label: { text: "{count}", color: "auto" } } },
        { symbol: { marker: { color: "#f2b701" } } }
      ),
      "point",
      "dark",
      points
    );
    expect(paint(out, "cluster-label")["text-color"]).toBe("#3a3541");
  });

  it("draws an Auto number on a badge on the badge's color, and white where the number's color is absent", () => {
    const auto = compile(
      cluster({
        count: "badge",
        symbol: { marker: { color: "#f2b701" }, label: { text: "{count}", color: "auto" } },
      }),
      "point",
      "light",
      points
    );
    expect(paint(auto, "cluster-badge")["text-color"]).toBe("#3a3541");
    const absent = compile(
      cluster({ count: "badge", symbol: { marker: { color: "#f2b701" } } }),
      "point",
      "light",
      points
    );
    expect(paint(absent, "cluster-badge")["text-color"]).toBe("#ffffff");
  });
});

describe("a cluster's number over a marker that varies", () => {
  const counts = samples(2, 1000, 2);
  const byCount = { field: "count", palette: ["#000000", "#ffffff"] };

  for (const count of ["center", "badge"] as const) {
    it(`switches an Auto number ${count === "badge" ? "on a badge" : "on the cluster"} where the marker's color flips it, its halo with it`, () => {
      const out = compile(
        {
          render: {
            type: "cluster",
            count,
            symbol: {
              marker: { color: byCount },
              label: { text: "{count}", color: "auto", halo: { color: "auto", width: 1 } },
            },
          },
        },
        "point",
        "light",
        points
      );
      const marker = paint(out, "cluster-marker")["circle-color"];
      const number = paint(out, count === "badge" ? "cluster-badge" : "cluster-label")["text-color"];
      const shown = (n: number) => hexOf(evaluate(number, { point_count: n }));
      const under = (n: number) => onColor(hexOf(evaluate(marker, { point_count: n })));
      switchesWhereItFlips(counts, shown, under, 998 / 64 + 2);
      if (count === "center") {
        const halo = paint(out, "cluster-label")["text-halo-color"];
        for (const n of counts) expect(hexOf(evaluate(halo, { point_count: n }))).toBe(haloAgainst(shown(n)));
      }
    });
  }

  it("keeps a badge's number on the color the badge image draws: the stop below over a color by zoom", () => {
    const out = compile(
      {
        render: {
          type: "cluster",
          count: "badge",
          symbol: {
            marker: {
              color: {
                zoom: [
                  [8, "#000000"],
                  [14, "#ffffff"],
                ],
              },
            },
            label: { color: "auto" },
          },
        },
      },
      "point",
      "light",
      points
    );
    expect(paint(out, "cluster-badge")["text-color"]).toEqual(["step", ["zoom"], "#ffffff", 14, "#3a3541"]);
  });
});

describe("the size of a label pair set in every class", () => {
  const classes = (n: number, label?: object) =>
    Array.from({ length: n }, (_, i) => ({
      values: [`c${i}`],
      fill: { color: `#${((0x102030 + i * 0x030507) % 0xffffff).toString(16).padStart(6, "0")}` },
      ...(label ? { label } : {}),
    }));
  const sizes = (doc: object) => {
    const p = paint(compile(doc, "polygon", "dark"));
    return [JSON.stringify(p["text-color"]).length, JSON.stringify(p["text-halo-color"]).length];
  };

  it("grows with the number of classes, set once in the base or in every class", () => {
    const base = sizes({
      ...labelled(BOTH, { fill: { color: "#7f3c8d" } }),
      classify: [{ field: "t", method: "categories", classes: classes(60) }],
    });
    const each = sizes({
      ...labelled({}, { fill: { color: "#7f3c8d" } }),
      classify: [{ field: "t", method: "categories", classes: classes(60, BOTH) }],
    });
    for (const size of [...base, ...each]) expect(size).toBeLessThan(5000);
    expect(each).toEqual(base);
    const twice = sizes({
      ...labelled({}, { fill: { color: "#7f3c8d" } }),
      classify: [{ field: "t", method: "categories", classes: classes(120, BOTH) }],
    });
    expect(twice[1]).toBeLessThan(2.5 * each[1]);
  });

  it("gives every feature the colors its class, rule, other or no-data record draws", () => {
    const tone = "dark";
    const doc = {
      symbol: {
        fill: { color: "#cccccc" },
        label: { text: "{name}", color: "auto", halo: { color: "auto" } },
      },
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [
            { values: ["a"], fill: { color: "#11a579" }, label: { color: "auto", halo: { color: "auto" } } },
            { values: ["b"], label: { color: "#f0f0f0" } },
            { values: ["c"], label: { halo: { color: "#222222" } } },
          ],
          other: { fill: { color: "#e73f74" } },
          no_data: { fill: { color: "#3969ac" } },
        },
        {
          field: "n",
          method: "manual",
          target: "label.color",
          classes: [
            { from: 0, label: { color: "#000000" } },
            { from: 10, label: { color: "auto" } },
          ],
        },
      ],
      rules: [{ name: "R", when: { op: "=", args: [{ property: "t" }, "r"] }, fill: { color: "#7f3c8d" } }],
    };
    const p = paint(compile(doc, "polygon", tone));
    const at = (props: Record<string, unknown>) => [
      hexOf(evaluate(p["text-color"], props)),
      hexOf(evaluate(p["text-halo-color"], props)),
    ];
    const both = (color: string) => [pair(color, tone).text, pair(color, tone).halo];
    expect(at({ t: "a" })).toEqual(both("#11a579"));
    expect(at({ t: "b" })).toEqual(["#f0f0f0", "#3a3541"]);
    expect(at({ t: "c" })).toEqual([pair("#cccccc", tone).text, "#222222"]);
    expect(at({ t: "zz" })).toEqual(both("#e73f74"));
    expect(at({})).toEqual(both("#3969ac"));
    expect(at({ t: "r" })).toEqual(both("#7f3c8d"));
    // The second classification sets the text by `n`: a set text gets a halo contrasting with it, Auto the pair.
    expect(at({ t: "a", n: 5 })).toEqual(["#000000", "#ffffff"]);
    expect(at({ t: "a", n: 50 })).toEqual(both("#11a579"));
  });
});

describe("recompiling on a basemap switch", () => {
  it("names the label's keys, so layers with a label Auto and only those depend on the tone", () => {
    expect([...TONE_KEYS].sort()).toEqual(["label.color", "label.halo.color"]);
    expect(usesTone(style(labelled({ color: "auto" })))).toBe(true);
    expect(usesTone(style(labelled({ halo: { color: "auto" } })))).toBe(true);
    expect(
      usesTone(
        style({
          ...labelled({}),
          classify: [
            { field: "t", method: "categories", classes: [{ values: ["a"], label: { color: "auto" } }] },
          ],
        })
      )
    ).toBe(true);
    expect(usesTone(style(labelled({ color: "#3a3541", halo: { color: "#ffffff" } })))).toBe(false);
    expect(usesTone(style({ symbol: { marker: { icon: "goat:park", icon_color: "auto" } } }))).toBe(false);
    // A cluster's number and halo Auto contrast with the cluster's marker, whatever the basemap.
    expect(
      usesTone(
        style({
          render: {
            type: "cluster",
            symbol: { label: { text: "{count}", color: "auto", halo: { color: "auto" } } },
          },
        })
      )
    ).toBe(false);
  });

  it("changes what an Auto label draws with the tone, and nothing else", () => {
    const doc = labelled(BOTH);
    expect(paint(compile(doc, "polygon", "light"))).not.toEqual(paint(compile(doc, "polygon", "dark")));
    const plain = { symbol: { fill: { color: "#7f3c8d" }, outline: { color: "auto" } } };
    expect(compile(plain, "polygon", "light")).toEqual(compile(plain, "polygon", "dark"));
  });
});

describe("the legend and the panel", () => {
  const entries = (doc: object, geometry: Geometry = "point") =>
    buildLegend(style(doc), { geometry, zoom: 10 })!.sections.flatMap((s) =>
      s.kind === "entries" ? s.entries : []
    );
  const marker = (doc: object) => entries(doc)[0].swatch.marker;

  it("draw an Auto icon as the map does: white or dark on its marker, the hue on a hollow one", () => {
    expect(
      marker({ symbol: { marker: { color: "#f2b701", icon: "goat:park", icon_color: "auto" } } })?.icon_color
    ).toBe("#3a3541");
    expect(
      marker({ symbol: { marker: { color: "#f2b701", icon: "goat:park", icon_color: "auto", fill: false } } })
        ?.icon_color
    ).toBe("#f2b701");
    const classes = entries({
      symbol: { marker: { color: "#2bb381", icon: "goat:park", icon_color: "auto" } },
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [
            { values: ["y"], marker: { color: "#f2b701" } },
            { values: ["k"], marker: { color: "#000000" } },
          ],
        },
      ],
    });
    expect(classes.map((e) => e.swatch.marker?.icon_color)).toEqual(["#3a3541", "#ffffff"]);
  });

  it("draw an Auto number on a badge as the map does", () => {
    const badge = entries({
      render: {
        type: "cluster",
        count: "badge",
        symbol: { marker: { color: "#f2b701" }, label: { text: "{count}", color: "auto" } },
      },
    }).find((e) => e.swatch.badge)!.swatch.badge;
    expect(badge?.text).toBe("#3a3541");
    // White on a dark badge: the badge has no halo to read the number on.
    const dark = entries({
      render: {
        type: "cluster",
        count: "badge",
        symbol: { marker: { color: "#2166ac" }, label: { text: "{count}", color: "auto" } },
      },
    }).find((e) => e.swatch.badge)!.swatch.badge;
    expect(dark?.text).toBe("#ffffff");
  });

  it("show in the panel's swatches what the map draws", () => {
    const doc = style(labelled({ color: "auto", halo: { color: "auto" } }));
    expect(swatchOf(doc, "symbol.label.color", "polygon", { tone: "light" })).toBe(
      pair("#7f3c8d", "light").text
    );
    expect(swatchOf(doc, "symbol.label.halo.color", "polygon", { tone: "dark" })).toBe(
      pair("#7f3c8d", "dark").halo
    );
    const fixedText = style(labelled({ color: "#f0f0f0", halo: { color: "auto" } }));
    expect(swatchOf(fixedText, "symbol.label.halo.color", "polygon", { tone: "dark" })).toBe("#3a3541");
    const absentText = style(labelled({ halo: { color: "auto" } }));
    expect(swatchOf(absentText, "symbol.label.halo.color", "polygon", { tone: "dark" })).toBe("#ffffff");
    const icon = style({ symbol: { marker: { color: "#f2b701", icon: "goat:park", icon_color: "auto" } } });
    expect(swatchOf(icon, "symbol.marker.icon_color", "point")).toBe("#3a3541");
    const hollow = style({
      symbol: { marker: { color: "#f2b701", icon: "goat:park", icon_color: "auto", fill: false } },
    });
    expect(swatchOf(hollow, "symbol.marker.icon_color", "point")).toBe("#f2b701");
    const number = style({
      render: {
        type: "cluster",
        symbol: { marker: { color: "#f2b701" }, label: { text: "{count}", color: "auto" } },
      },
    });
    expect(swatchOf(number, "render.symbol.label.color", "point", { tone: "dark" })).toBe("#3a3541");
  });
});

describe("details the map, the legend and the panel share", () => {
  const entries = (doc: object, geometry: Geometry = "point") =>
    buildLegend(style(doc), { geometry, zoom: 10 })!.sections.flatMap((s) =>
      s.kind === "entries" ? s.entries : []
    );

  it("draws an Auto icon on a cluster's marker on that marker, also for clusters drawn like the points", () => {
    const own = compile(
      {
        render: {
          type: "cluster",
          symbol: { marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" } },
        },
      },
      "point",
      "light",
      points
    );
    expect(layer(own, "cluster-marker").layout["icon-image"]).toBe(
      "goat-marker:square|8|goat:park|#f2b701||0|#3a3541"
    );
    const like = compile(
      {
        symbol: { marker: { shape: "square", color: "#000000", icon: "goat:park", icon_color: "auto" } },
        render: { type: "cluster", look: "points" },
      },
      "point",
      "light",
      points
    );
    expect(layer(like, "cluster-marker").layout["icon-image"]).toBe(
      "goat-marker:square|8|goat:park|#000000||0|#ffffff"
    );
    const doc = style({
      render: {
        type: "cluster",
        symbol: { marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" } },
      },
    });
    expect(swatchOf(doc, "render.symbol.marker.icon_color", "point")).toBe("#3a3541");
  });

  it("draws an Auto icon in the legend by the marker's own color, not by a fill read from a field", () => {
    const doc = {
      symbol: {
        fill: { color: { field: "c" } },
        marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" },
      },
    };
    const name = layer(compile(doc, "polygon"), "marker").layout["icon-image"];
    expect(String(name).split("|").pop()).toBe("#3a3541");
    expect(entries(doc, "polygon")[0].swatch.marker?.icon_color).toBe("#3a3541");
  });

  it("lets an Auto icon follow the neutral marker of a classification that sets no color", () => {
    const doc = {
      symbol: { marker: { shape: "square", color: "#f2b701", icon: "goat:park", icon_color: "auto" } },
      classify: [
        {
          field: "t",
          method: "categories",
          target: "marker.size",
          classes: [{ values: ["a"], marker: { size: 12 } }],
        },
      ],
    };
    const swatch = entries(doc)[0].swatch.marker;
    expect(swatch?.color).toBe("#9aa3ad");
    expect(swatch?.icon_color).toBe(onColor("#9aa3ad"));
  });

  it("follows a cluster's own marker in the panel, and a class's halo the base's text where the class sets none", () => {
    const cluster = style({
      symbol: { marker: { color: "#000000" } },
      render: {
        type: "cluster",
        symbol: { marker: { color: "#e68310" }, outline: { color: "auto", width: 2 } },
      },
    });
    expect(swatchOf(cluster, "render.symbol.outline.color", "point")).toBe(shade("#e68310"));
    const classed = style({
      ...labelled({ color: "#f0f0f0" }),
      classify: [
        {
          field: "t",
          method: "categories",
          classes: [{ values: ["a"], label: { halo: { color: "auto" } } }],
        },
      ],
    });
    expect(swatchOf(classed, "classify.0.classes.0.label.halo.color", "polygon", { scoped: true })).toBe(
      "#3a3541"
    );
  });
});
