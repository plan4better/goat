import { describe, expect, it } from "vitest";

import { iconSettings, restoreIcon, setMarkerIcon, setMarkerShape } from "@/lib/style/editor/parts";
import { getIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";

const doc = (extra: object) => ({ version: "1.0.0", kind: "vector", ...extra }) as LayerStyle;

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

  it("on without a remembered icon takes the default marker icon, its color on Auto", () => {
    expect(restoreIcon(doc({ symbol: { marker: { size: 8 } } }))).toEqual(
      doc({ symbol: { marker: { size: 8, icon: "goat:marker", icon_color: "auto" } } })
    );
    // An icon color the marker sets stays.
    expect(restoreIcon(doc({ symbol: { marker: { icon_color: "#000000" } } }))).toEqual(
      doc({ symbol: { marker: { icon_color: "#000000", icon: "goat:marker" } } })
    );
  });
});

describe("an icon chosen in the icon row", () => {
  const ctx = { mapZoom: 12, geometry: "point" as const };
  const pick = (before: object, path = "symbol.marker.icon", ref = "goat:park") =>
    setMarkerIcon(doc(before), path, ref, ctx);

  it("as the layer's first icon, starts with an Auto icon color, as the switch does", () => {
    expect(pick({ symbol: { marker: { shape: "pin", color: "#f2b701" } } })).toEqual(
      doc({ symbol: { marker: { shape: "pin", color: "#f2b701", icon: "goat:park", icon_color: "auto" } } })
    );
  });

  it("in place of an existing icon changes only the icon", () => {
    expect(pick({ symbol: { marker: { shape: "pin", icon: "goat:cafe" } } })).toEqual(
      doc({ symbol: { marker: { shape: "pin", icon: "goat:park" } } })
    );
  });

  it("keeps an icon color the marker already has", () => {
    expect(pick({ symbol: { marker: { shape: "pin", icon_color: "#000000" } } })).toEqual(
      doc({ symbol: { marker: { shape: "pin", icon_color: "#000000", icon: "goat:park" } } })
    );
  });

  it("for a class writes only the class's icon, which takes the layer's icon color", () => {
    const before = {
      symbol: { marker: { color: "#f2b701" } },
      classify: [{ id: "k", field: "kind", method: "categories", classes: [{ id: "a", values: ["x"] }] }],
    };
    const after = pick(before, "classify.0.classes.0.marker.icon");
    expect(after).toEqual(
      doc({
        ...before,
        classify: [
          {
            id: "k",
            field: "kind",
            method: "categories",
            classes: [{ id: "a", values: ["x"], marker: { icon: "goat:park" } }],
          },
        ],
      })
    );
  });

  it("as the layer's icon while classes draw icons of their own leaves their icon color as it is", () => {
    const before = {
      symbol: { marker: { shape: "pin" } },
      classify: [
        {
          id: "k",
          field: "kind",
          method: "categories",
          classes: [{ id: "a", values: ["x"], marker: { icon: "goat:cafe" } }],
        },
      ],
    };
    expect(getIn(pick(before), "symbol.marker")).toEqual({ shape: "pin", icon: "goat:park" });
  });

  it("on the icon alone, which the marker color tints, writes no icon color", () => {
    expect(pick({ symbol: { marker: { shape: "icon", icon: "goat:cafe" } } })).toEqual(
      doc({ symbol: { marker: { shape: "icon", icon: "goat:park" } } })
    );
  });
});

describe("leaving the icon alone for a shape", () => {
  it("keeps the icon on the marker, its color on Auto", () => {
    expect(
      setMarkerShape(
        doc({ symbol: { marker: { shape: "icon", icon: "goat:park", color: "#f2b701" } } }),
        "circle"
      )
    ).toEqual(doc({ symbol: { marker: { icon: "goat:park", color: "#f2b701", icon_color: "auto" } } }));
  });

  it("keeps an icon color the marker has", () => {
    expect(
      setMarkerShape(
        doc({ symbol: { marker: { shape: "icon", icon: "goat:park", icon_color: "#000000" } } }),
        "square"
      )
    ).toEqual(doc({ symbol: { marker: { shape: "square", icon: "goat:park", icon_color: "#000000" } } }));
  });

  it("writes no icon color while a class draws an icon of its own", () => {
    const classify = [
      {
        id: "k",
        field: "kind",
        method: "categories",
        classes: [{ id: "a", values: ["x"], marker: { icon: "goat:cafe" } }],
      },
    ];
    const after = setMarkerShape(
      doc({ symbol: { marker: { shape: "icon", icon: "goat:park" } }, classify }),
      "circle"
    );
    expect(getIn(after, "symbol.marker")).toEqual({ icon: "goat:park" });
  });

  it("from a shape to another shape changes the shape only", () => {
    expect(
      setMarkerShape(doc({ symbol: { marker: { shape: "square", icon: "goat:park" } } }), "circle")
    ).toEqual(doc({ symbol: { marker: { icon: "goat:park" } } }));
  });
});
