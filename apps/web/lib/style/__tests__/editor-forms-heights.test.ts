import { describe, expect, it } from "vitest";

import { drawsHeights, modesFor, oneFillOpacity } from "@/lib/style/editor/forms";
import { getIn } from "@/lib/style/editor/paths";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (symbol: object, extra: object = {}) =>
  ({ version: "1.0.0", kind: "vector", symbol, ...extra }) as LayerStyle;
const ctx = { mapZoom: 12, geometry: "polygon" as const, sample: { pop: 50 } };
const byPop = { field: "pop", range: [0.2, 1], scale: "linear" };

// goatlib draws heights with one fill opacity for the whole layer (check.py, `override_not_per_feature`): once any
// record has an `extrude` part, a fill opacity by feature, by classes or of a class or rule is refused.
describe("fill opacity on a layer with heights", () => {
  it("heights are on when any record has an extrude part, as goatlib's check reads it", () => {
    expect(drawsHeights(doc({ fill: {} }))).toBe(false);
    expect(drawsHeights(doc({ fill: {}, extrude: false }))).toBe(false);
    expect(drawsHeights(doc({ fill: {}, extrude: {} }))).toBe(true);
    // A class switching heights on over a layer that switches them off counts too.
    expect(
      drawsHeights(
        doc(
          { fill: {}, extrude: false },
          { classify: [{ field: "use", classes: [{ value: "a", extrude: { height: 5 } }] }] }
        )
      )
    ).toBe(true);
    expect(drawsHeights(doc({ fill: {} }, { rules: [{ id: "r", extrude: {} }] }))).toBe(true);
  });

  it("offers fill opacity fixed and by zoom only", () => {
    const flat = { scoped: false, hasNumberField: true };
    expect(modesFor("fill.opacity", { ...flat, extruded: true })).toEqual(["fixed", "zoom"]);
    expect(modesFor("fill.opacity", flat)).toEqual(["fixed", "zoom", "attribute", "classes"]);
    // Other keys keep theirs.
    expect(modesFor("fill.color", { ...flat, extruded: true })).toContain("attribute");
  });

  it("heights on: a fill opacity by attribute becomes the fixed value it shows", () => {
    const next = oneFillOpacity(doc({ fill: { opacity: byPop }, extrude: { height: 10 } }), ctx);
    expect(typeof getIn(next, "symbol.fill.opacity")).toBe("number");
  });

  it("heights on: a fill opacity by zoom stays", () => {
    const zoom = {
      zoom: [
        [10, 0.4],
        [16, 0.9],
      ],
    };
    const stored = doc({ fill: { opacity: zoom }, extrude: { height: 10 } });
    expect(oneFillOpacity(stored, ctx)).toBe(stored);
  });

  it("heights on: classes of the fill opacity and class and rule opacities go", () => {
    const stored = doc(
      { fill: { opacity: 0.7 }, extrude: { height: 10 } },
      {
        classify: [
          { field: "use", target: "fill.opacity", classes: [{ value: "a", fill: { opacity: 0.2 } }] },
          { field: "kind", classes: [{ value: "b", fill: { color: "#ff0000", opacity: 0.5 } }] },
        ],
        rules: [{ id: "r", fill: { opacity: 0.3, color: "#00ff00" } }],
      }
    );
    const next = oneFillOpacity(stored, ctx);
    expect(getIn(next, "symbol.fill.opacity")).toBe(0.7);
    expect(getIn(next, "classify")).toEqual([
      { field: "kind", classes: [{ value: "b", fill: { color: "#ff0000" } }] },
    ]);
    expect(getIn(next, "rules.0.fill")).toEqual({ color: "#00ff00" });
  });

  it("without heights nothing changes", () => {
    const stored = doc({ fill: { opacity: byPop } });
    expect(oneFillOpacity(stored, ctx)).toBe(stored);
  });
});
