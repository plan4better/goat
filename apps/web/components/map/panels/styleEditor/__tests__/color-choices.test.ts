import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import { keyOf } from "@/lib/style/editor/forms";

import {
  GROUPS,
  colorChoices,
  patternRows,
  rowChoices,
  stopSentinels,
} from "@/components/map/panels/styleEditor/editors/partRows";

// The choices in front of a color picker's swatches (spec 18.10, 4.6): Auto exactly where the table of color keys
// accepts it, None on every color but a label's text, and the row's "Same as" choice where it has one.

const table = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../../../packages/python/goatlib/src/goatlib/style/data/color_keys.json"),
    "utf8"
  )
) as Record<string, { auto: string | null; accepted?: boolean }>;

/** Where the panel edits a key of the table with a color row; undefined for palettes and popup blocks, which have
 * pickers of their own. */
function panelPath(key: string): string | undefined {
  if (key.endsWith("palette") || key.startsWith("popup.")) return undefined;
  const listed = key.replace(/\.(lines|classes|stops)\./, ".$1.0.");
  if (key.startsWith("cluster.symbol.")) return listed.replace(/^cluster\.symbol\./, "render.symbol.");
  if (key.startsWith("h3.")) return listed.replace(/^h3\./, "render.");
  if (key.startsWith("continuous.") || key.startsWith("categorical.") || key.startsWith("hillshade."))
    return listed.replace(/^\w+\./, "render.");
  if (key === "by_attribute.no_data") return "symbol.fill.color.no_data";
  if (key.startsWith("scene.")) return key;
  return `symbol.${listed}`;
}

const TEXT = [
  "label.color",
  "label.lines.color",
  "cluster.symbol.label.color",
  "cluster.symbol.label.lines.color",
];
/** Colors without None: a label's text, and the scene's colors, which take no transparency in the panel. */
const NO_NONE = (key: string) => TEXT.includes(key) || key.startsWith("scene.");

describe("the choices of a color", () => {
  it("offer Auto exactly where the table of color keys accepts it, and None on every color but a label's text and the scene's", () => {
    let checked = 0;
    for (const [key, row] of Object.entries(table)) {
      const path = panelPath(key);
      if (!path) continue;
      const choices = colorChoices(keyOf(path));
      expect(
        choices.some((c) => c.value === "auto"),
        key
      ).toBe(row.accepted === true);
      expect(
        choices.some((c) => c.none),
        key
      ).toBe(!NO_NONE(key));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("read the H3 outline as the H3 outline's key, not a heatmap's", () => {
    expect(keyOf("render.outline.color")).toBe("h3.outline.color");
    expect(keyOf("render.outline.width")).toBe("h3.outline.width");
    expect(keyOf("render.radius")).toBe("heatmap.radius");
  });

  it("put Auto and None first, then the row's Same as choice", () => {
    expect(rowChoices("polygon", "outline.color").map((c) => c.label)).toEqual([
      "style_editor.auto",
      "style_editor.none",
      "style_editor.same_as_fill",
    ]);
    expect(rowChoices("line", "casing.color").map((c) => c.label)).toEqual([
      "style_editor.auto",
      "style_editor.none",
    ]);
    expect(rowChoices("line", "arrows.color").map((c) => c.label)).toEqual([
      "style_editor.none",
      "style_editor.same_as_line",
    ]);
    expect(rowChoices("polygon", "fill.color").map((c) => c.label)).toEqual(["style_editor.none"]);
    expect(rowChoices("point", "label.color").map((c) => c.label)).toEqual(["style_editor.auto"]);
  });

  it("are what every color row of the symbol offers", () => {
    const rows = (Object.keys(GROUPS) as Geometry[]).flatMap((geometry) =>
      GROUPS[geometry].flatMap((group) =>
        [...group.rows, ...(group.part === "fill" ? patternRows(false) : [])]
          .filter((row) => row.type === "color")
          .map((row) => ({ geometry, key: `${group.part}.${row.key}`, row }))
      )
    );
    expect(rows.length).toBeGreaterThan(8);
    for (const { geometry, key, row } of rows) {
      const choices = row.type === "color" ? (row.sentinels ?? colorChoices(key)) : [];
      expect(rowChoices(geometry, key), key).toEqual(choices);
      expect(
        choices.some((c) => c.value === "auto"),
        key
      ).toBe(table[key]?.accepted === true);
    }
  });

  it("a zoom stop offers them without the one that deletes the key", () => {
    expect(stopSentinels("polygon", "outline.color")?.map((c) => c.label)).toEqual([
      "style_editor.auto",
      "style_editor.none",
      "style_editor.same_as_fill",
    ]);
    expect(stopSentinels("polygon", "fill.pattern_color")?.map((c) => c.label)).toEqual([
      "style_editor.none",
    ]);
    expect(stopSentinels("point", "label.color")?.map((c) => c.label)).toEqual(["style_editor.auto"]);
  });
});
