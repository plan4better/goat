import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { hexagonPopup, hexagonValues, isHexagon } from "@/lib/style/h3Popup";
import { popupProperties } from "@/lib/validations/layer";

const t = ((key: string, opts?: { field?: string }) =>
  opts?.field ? `${key}:${opts.field}` : key) as unknown as TFunction;

const h3 = (render: object = {}) =>
  ({ version: 1, kind: "vector", render: { type: "h3", ...render } }) as LayerStyle;

const layerPopup = popupProperties.parse({
  trigger: "hover",
  layout: "pinned",
  anchor: "top_left",
  blocks: [{ type: "text", html: "<b>{{name}}</b>" }],
});

describe("hexagon popups", () => {
  it("a hexagon shows its number of points in the layer's popup settings", () => {
    const popup = hexagonPopup(layerPopup, h3(), t);
    expect(popup).toMatchObject({ enabled: true, trigger: "hover", layout: "pinned", anchor: "top_left" });
    expect(popup?.mode).toBe("simple");
    expect(popup?.blocks).toEqual([
      expect.objectContaining({
        type: "fieldList",
        attributes: [{ name: "h3_count", label: "style_editor.h3_value_count", type: "number" }],
      }),
    ]);
  });

  it("a sum or mean comes first, under the field it reads", () => {
    const popup = hexagonPopup(layerPopup, h3({ value: { op: "mean", field: "pupils" } }), t);
    expect(popup?.blocks).toEqual([
      expect.objectContaining({
        attributes: [
          { name: "h3_value", label: "style_editor.h3_value_mean:pupils", type: "number" },
          { name: "h3_count", label: "style_editor.h3_value_count", type: "number" },
        ],
      }),
    ]);
  });

  it("a layer without a popup shows none on its hexagons either", () => {
    expect(hexagonPopup(undefined, h3(), t)).toBeUndefined();
    expect(hexagonPopup({ ...layerPopup, enabled: false }, h3(), t)).toBeUndefined();
  });

  it("the values come from the hexagon tile's properties", () => {
    expect(hexagonValues({ value: 2.5, count: 4, resolution: 8, cell: "88283082b9fffff" })).toEqual({
      h3_value: 2.5,
      h3_count: 4,
    });
    expect(isHexagon({ sourceLayer: "h3" })).toBe(true);
    expect(isHexagon({ sourceLayer: "default" })).toBe(false);
  });
});
