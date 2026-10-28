import { describe, expect, it } from "vitest";

import { applyFix, issueTarget } from "@/lib/style/editor/issues";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = {
  version: 1,
  kind: "vector",
  symbol: { fill: { color: "#cccccc" }, outline: { width: 1.26 } },
  classify: [
    { id: "c0", field: "a", method: "categories" },
    {
      id: "c1",
      field: "b",
      method: "manual",
      classes: [
        { id: "k1", to: 5 },
        { id: "k2", from: 5, fill: { color: "#111111" } },
      ],
    },
  ],
  rules: [{ when: { op: "isNull", args: [{ property: "name" }] }, visible: false }],
  legend: { show: true },
} as unknown as LayerStyle;

describe("issue targets", () => {
  it("maps a pointer to its section and dot path", () => {
    expect(issueTarget(doc, "/symbol/fill/color")).toEqual({ section: "symbol", path: "symbol.fill.color" });
    expect(issueTarget(doc, "/classify/c1/classes/k2/fill/color")).toEqual({
      section: "symbol",
      path: "classify.1.classes.1.fill.color",
    });
    expect(issueTarget(doc, "/rules/0/visible")).toEqual({ section: "rules", path: "rules.0.visible" });
    expect(issueTarget(doc, "/legend/show")).toEqual({ section: "legend", path: "legend.show" });
    expect(issueTarget(doc, "/min_zoom")).toEqual({ section: "layer", path: "min_zoom" });
    expect(issueTarget(doc, "/classify/gone/field")).toBeNull();
  });

  it("applies the fix operations", () => {
    expect(applyFix(doc, { op: "set", path: "/symbol/fill/color", value: "#ff0000" })).toMatchObject({
      symbol: { fill: { color: "#ff0000" } },
    });
    expect(
      (applyFix(doc, { op: "remove", path: "/legend" }) as unknown as Record<string, unknown>).legend
    ).toBeUndefined();
    const first = (d: LayerStyle) =>
      (d as unknown as { classify: Array<Record<string, unknown>> }).classify[0];
    expect(
      first(applyFix(doc, { op: "retarget", path: "/classify/c0", target: "outline.color" })).target
    ).toBe("outline.color");
    expect(applyFix(doc, { op: "round", path: "/symbol/outline/width" })).toMatchObject({
      symbol: { outline: { width: 1 } },
    });
  });

  // The cases of goatlib's tests/unit/style/test_ops.py: the panel applies a fix exactly as the server does.
  it("retarget moves the key the class records set (goatlib apply_fix)", () => {
    const d = {
      version: 1,
      kind: "vector",
      classify: [
        {
          id: "a",
          field: "type",
          method: "categories",
          target: "fill.color",
          classes: [{ id: "c1", values: ["x"], fill: { color: "#000000" } }],
          other: { fill: { color: "#111111", opacity: 0.5 } },
        },
      ],
    } as unknown as LayerStyle;
    const out = applyFix(d, { op: "retarget", path: "/classify/a", target: "outline.color" }) as unknown as {
      classify: Array<Record<string, unknown>>;
    };
    expect(out.classify[0].target).toBe("outline.color");
    expect(out.classify[0].classes).toEqual([{ id: "c1", values: ["x"], outline: { color: "#000000" } }]);
    expect(out.classify[0].other).toEqual({ fill: { opacity: 0.5 }, outline: { color: "#111111" } });
  });

  it("use_field sets the field its path names, round goes half up (goatlib apply_fix)", () => {
    const d = {
      version: 1,
      kind: "vector",
      rules: [
        { id: "r1", visible: false, min_zoom: 12.5, when: { op: "isNull", args: [{ property: "name" }] } },
      ],
      classify: [{ id: "k", field: "gone", method: "categories" }],
    } as unknown as LayerStyle;
    const out = applyFix(d, { op: "use_field", path: "/classify/k/field", field: "land_use" }) as unknown as {
      classify: Array<Record<string, unknown>>;
    };
    expect(out.classify[0].field).toBe("land_use");
    expect(applyFix(d, { op: "round", path: "/rules/r1/min_zoom" })).toMatchObject({
      rules: [{ min_zoom: 13 }],
    });
  });
});
