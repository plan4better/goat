import { describe, expect, it } from "vitest";

import { buildLegend, informative } from "@/lib/style/legend";

const classes = {
  id: "use",
  field: "use",
  method: "categories",
  classes: [
    { id: "a", values: ["park"], fill: { color: "#00aa00" } },
    { id: "b", values: ["lake"], fill: { color: "#0000aa" } },
  ],
};

describe("a legend of the layer's name only (spec 7.2 legend.display)", () => {
  it("a vector layer's legend keeps its title and caption and lists nothing", () => {
    const doc = {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#cccccc" } },
      classify: [classes],
      legend: { display: "name_only", title: "Land use", caption: "Source: city" },
    };
    const legend = buildLegend(doc, { geometry: "polygon", zoom: 12 });
    expect(legend).toEqual({ title: "Land use", caption: "Source: city", sections: [] });
    // Nothing beyond the name: the layer list and print show the name (with the layer's swatch where it has one).
    expect(informative(legend)).toBe(false);
    // Standard lists the classes as before.
    const standard = buildLegend(
      { ...doc, legend: { display: "standard" } },
      { geometry: "polygon", zoom: 12 }
    );
    expect(informative(standard)).toBe(true);
  });

  it("a raster's legend of its name only shows no ramp; hidden stays hidden", () => {
    const doc = {
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", palette: "goat:elevation", domain: [0, 100] },
      legend: { display: "name_only" },
    };
    expect(buildLegend(doc, { zoom: 12 })).toEqual({ sections: [] });
    expect(buildLegend({ ...doc, legend: { display: "name_only", show: false } }, { zoom: 12 })).toBeNull();
  });
});
