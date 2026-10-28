import { describe, expect, it } from "vitest";

import { iconSettings, restoreIcon, setMarkerIcon } from "@/lib/style/editor/parts";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (extra: object) => ({ version: 1, kind: "vector", ...extra }) as LayerStyle;

describe("the icon switch", () => {
  it("off and on again brings back the icon, its color and the classification that sets it", () => {
    const before = doc({
      symbol: { marker: { shape: "pin", icon: "goat:park", icon_color: "#000000", size: 20 } },
      classify: [
        {
          id: "kind",
          field: "kind",
          method: "categories",
          target: "marker.icon",
          classes: [{ id: "c1", values: ["cafe"], marker: { icon: "goat:cafe" } }],
        },
      ],
    });
    const kept = iconSettings(before);
    const off = setMarkerIcon(before, "symbol.marker.icon", undefined, { mapZoom: 12, geometry: "point" });
    // Off: the icon, its color and its classification go; the shape stays until toggleIcon takes it too.
    expect(off).toEqual(doc({ symbol: { marker: { shape: "pin", size: 20 } } }));
    expect(restoreIcon(off, kept)).toEqual(before);
  });

  it("a pin without an icon comes back without one", () => {
    const pin = doc({ symbol: { marker: { shape: "pin" } } });
    expect(restoreIcon(doc({ symbol: { marker: {} } }), iconSettings(pin))).toEqual(pin);
  });

  it("on without a remembered icon takes the default marker icon", () => {
    expect(restoreIcon(doc({ symbol: { marker: { size: 8 } } }))).toEqual(
      doc({ symbol: { marker: { size: 8, icon: "goat:marker" } } })
    );
  });
});
