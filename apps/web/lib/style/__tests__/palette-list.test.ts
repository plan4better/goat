import { describe, expect, it } from "vitest";

import {
  PALETTE_MAX,
  PALETTE_MIN,
  addColorAfter,
  moveColor,
  paletteList,
  recolor,
  removeColor,
} from "@/lib/style/editor/paletteList";

const ELEVATION = ["#2f6b3a", "#5f9e4d", "#a8c66c", "#e8dc8f", "#c9a36b", "#8f6b4c", "#f2f2f2"];

describe("a palette's colors as a list", () => {
  it("a catalogue palette lists its own colors, or as many as the classes in its variant for that many", () => {
    expect(paletteList("goat:elevation")).toEqual(ELEVATION);
    expect(paletteList("colorbrewer:Blues", { steps: 3 })).toEqual(["#deebf7", "#9ecae1", "#3182bd"]);
    // Reversed as it draws.
    expect(paletteList("colorbrewer:Blues", { steps: 3, reverse: true })).toEqual([
      "#3182bd",
      "#9ecae1",
      "#deebf7",
    ]);
    // 2 to 12 colors, as an inline palette may have: 13 classes list 12.
    expect(paletteList("goat:elevation", { steps: 13 })).toHaveLength(PALETTE_MAX);
    expect(paletteList("goat:elevation", { steps: 1 })).toHaveLength(PALETTE_MIN);
  });

  it("an inline palette lists its colors as written, reversed as it draws", () => {
    expect(paletteList(["#000000", "#ff0000", "#ffffff"], { steps: 5 })).toEqual([
      "#000000",
      "#ff0000",
      "#ffffff",
    ]);
    expect(paletteList(["#000000", "#ffffff"], { reverse: true })).toEqual(["#ffffff", "#000000"]);
  });

  it("edits keep 2 to 12 colors: a color changed, one added after another as its copy, removed, moved", () => {
    const three = ["#000000", "#ff0000", "#ffffff"];
    expect(recolor(three, 1, "#00ff00")).toEqual(["#000000", "#00ff00", "#ffffff"]);
    expect(addColorAfter(three, 0)).toEqual(["#000000", "#000000", "#ff0000", "#ffffff"]);
    expect(
      addColorAfter(
        Array.from({ length: 12 }, () => "#000000"),
        0
      )
    ).toHaveLength(12);
    expect(removeColor(three, 1)).toEqual(["#000000", "#ffffff"]);
    expect(removeColor(["#000000", "#ffffff"], 0)).toEqual(["#000000", "#ffffff"]);
    // A floor of its own: a classification needs as many colors as classes.
    expect(removeColor(three, 0, 3)).toEqual(three);
    expect(moveColor(three, 0, 2)).toEqual(["#ff0000", "#ffffff", "#000000"]);
    expect(moveColor(three, 2, 0)).toEqual(["#ffffff", "#000000", "#ff0000"]);
  });
});
