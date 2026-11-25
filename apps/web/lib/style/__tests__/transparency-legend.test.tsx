// The legend of colors with their own transparency (spec 4.6, 7.2): a None fill with an outline is an outline alone, a
// class whose fill is None shows so, and a color that is not opaque lies over the swatch checkerboard.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { shade } from "@/lib/style/colors";
import { type LegendSection, type Swatch, baseSwatch, buildLegend } from "@/lib/style/legend";

import { StyleLegend, SwatchIcon } from "@/components/map/legend/StyleLegend";

const NONE = "#cc615c00";
const doc = (style: object) => ({ version: "1.0.0", kind: "vector", ...style });
const entries = (sections: LegendSection[] | undefined) =>
  (sections ?? []).flatMap((s) => (s.kind === "entries" ? s.entries : []));
const drawn = (swatch: Swatch) => render(<SwatchIcon swatch={swatch} />).container;

describe("a None fill in the legend", () => {
  const swatch = baseSwatch(
    doc({ symbol: { fill: { color: NONE }, outline: { color: "auto", width: 2 } } }),
    {
      geometry: "polygon",
      zoom: 12,
    }
  );

  it("keeps its hue in the swatch's data and its Auto outline in a darker shade of it", () => {
    expect(swatch.fill?.color).toBe(NONE);
    expect(swatch.outline?.color).toBe(shade(NONE));
  });

  it("draws the outline alone, with no checkerboard", () => {
    const rect = drawn(swatch).querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("none");
    expect(rect.getAttribute("stroke")).toBe(shade(NONE));
    expect(drawn(swatch).querySelector("[data-checker]")).toBeNull();
  });
});

describe("a class whose fill is None in the legend", () => {
  const legend = buildLegend(
    doc({
      symbol: { fill: { color: "#2166ac" }, outline: { color: "auto" } },
      classify: [
        {
          field: "k",
          method: "categories",
          classes: [
            { values: ["x"], fill: { color: NONE } },
            { values: ["y"], fill: { color: "#e68310" } },
          ],
        },
      ],
    }),
    { geometry: "polygon", zoom: 12 }
  );
  const [x, y] = entries(legend?.sections);

  it("is an outline alone in a darker shade of its hue; the other classes are untouched", () => {
    expect(x.swatch.fill?.color).toBe(NONE);
    expect(x.swatch.outline?.color).toBe(shade(NONE));
    expect(drawn(x.swatch).querySelector("rect")!.getAttribute("fill")).toBe("none");
    expect(y.swatch.fill?.color).toBe("#e68310");
    expect(y.swatch.outline?.color).toBe(shade("#e68310"));
    expect(drawn(y.swatch).querySelector("rect")!.getAttribute("fill")).toBe("#e68310");
  });
});

describe("a swatch that draws nothing else in the legend", () => {
  it("a None fill without an outline or a pattern shows the checkerboard alone", () => {
    const container = drawn({ geometry: "polygon", fill: { color: NONE }, outline: undefined });
    expect(container.querySelector("[data-checker]")).not.toBeNull();
    const rects = [...container.querySelectorAll("svg > rect")];
    expect(rects.map((r) => r.getAttribute("fill"))).toEqual([expect.stringMatching(/^url\(#/), "none"]);
  });

  it("a None line without a casing shows the checkerboard alone", () => {
    expect(
      drawn({ geometry: "line", line: { color: NONE } }).querySelector("[data-checker-under]")
    ).not.toBeNull();
  });

  it("a None circle or shape without an outline or an icon shows the checkerboard alone", () => {
    const circle = drawn({ geometry: "point", marker: { color: NONE } }).querySelector(
      "[data-marker-shape]"
    ) as HTMLElement;
    expect(circle.style.background).toContain("linear-gradient");
    const shape = drawn({ geometry: "point", marker: { color: NONE, shape: "diamond" } });
    expect(shape.querySelector("[data-checker-under]")).not.toBeNull();
  });
});

describe("a color that is not set takes the hue of the color it follows in the legend", () => {
  it("a hatch over a None or partly transparent fill is drawn opaque, as on the map", () => {
    const none = baseSwatch(doc({ symbol: { fill: { color: NONE, pattern: "hatch_45" } } }), {
      geometry: "polygon",
      zoom: 12,
    });
    expect(none.fill?.pattern_color).toBe("#cc615c");
    expect(drawn(none).querySelector("pattern path")!.getAttribute("stroke")).toBe("#cc615c");
    const half = baseSwatch(doc({ symbol: { fill: { color: "#ff000080", pattern: "hatch_45" } } }), {
      geometry: "polygon",
      zoom: 12,
    });
    expect(half.fill?.pattern_color).toBe("#ff0000");
  });

  it("arrows over a None line and the icon of a hollow None marker are opaque", () => {
    const line = baseSwatch(doc({ symbol: { line: { color: NONE }, arrows: { icon: "goat:rail-light" } } }), {
      geometry: "line",
      zoom: 12,
    });
    expect(line.arrows?.color).toBe("#cc615c");
    const marker = baseSwatch(doc({ symbol: { marker: { color: NONE, fill: false, icon: "goat:park" } } }), {
      geometry: "point",
      zoom: 12,
    });
    expect(marker.marker?.icon_color).toBe("#cc615c");
  });
});

describe("a color that is not opaque in the legend", () => {
  it("an area lies over the checkerboard", () => {
    const container = drawn({ geometry: "polygon", fill: { color: "#e87ab294" } });
    expect(container.querySelector("[data-checker]")).not.toBeNull();
    const rects = [...container.querySelectorAll("svg > rect")];
    // The checkerboard first, the color over it.
    expect(rects.map((r) => r.getAttribute("fill"))).toEqual([expect.stringMatching(/^url\(#/), "#e87ab294"]);
  });

  it("an opaque area draws no checkerboard", () => {
    const container = drawn({ geometry: "polygon", fill: { color: "#e87ab2", opacity: 0.5 } });
    expect(container.querySelector("[data-checker]")).toBeNull();
  });

  it("a line lies over the checkerboard where no casing lies under it", () => {
    expect(
      drawn({ geometry: "line", line: { color: "#2166ac80" } }).querySelector("[data-checker-under]")
    ).not.toBeNull();
    expect(
      drawn({ geometry: "line", line: { color: "#2166ac80" }, casing: { color: "#ffffff" } }).querySelector(
        "[data-checker]"
      )
    ).toBeNull();
    expect(
      drawn({ geometry: "line", line: { color: "#2166ac" } }).querySelector("[data-checker]")
    ).toBeNull();
  });

  it("a circle marker lies over the checkerboard", () => {
    const circle = drawn({ geometry: "point", marker: { color: "#2166ac80" } }).querySelector(
      "[data-marker-shape]"
    ) as HTMLElement;
    expect(circle.style.background).toContain("linear-gradient");
    const opaque = drawn({ geometry: "point", marker: { color: "#2166ac" } }).querySelector(
      "[data-marker-shape]"
    ) as HTMLElement;
    expect(opaque.style.background).not.toContain("gradient");
  });

  it("a None circle with an outline draws the outline alone", () => {
    const circle = drawn({
      geometry: "point",
      marker: { color: "#2166ac00" },
      outline: { color: "#000000", width: 1 },
    }).querySelector("[data-marker-shape]") as HTMLElement;
    expect(circle.style.background).toBe("transparent");
  });

  it("a marker shape lies over the checkerboard; a None one with an outline draws the outline alone", () => {
    const clear = drawn({ geometry: "point", marker: { color: "#2166ac80", shape: "diamond" } });
    expect(clear.querySelector("[data-checker-under]")).not.toBeNull();
    const none = drawn({
      geometry: "point",
      marker: { color: "#2166ac00", shape: "diamond" },
      outline: { color: "#000000", width: 1 },
    });
    expect(none.querySelector("[data-checker]")).toBeNull();
    expect(none.querySelector("[data-marker-shape] path")!.getAttribute("fill")).toBe("none");
  });

  it("a ramp with a color that is not opaque lies over the checkerboard; an opaque one draws none", () => {
    const ramp = (palette: string[]) =>
      render(
        <StyleLegend
          legend={
            buildLegend(
              { version: "1.0.0", kind: "raster", render: { type: "continuous", palette, domain: [0, 10] } },
              { zoom: 10 }
            )!
          }
          variant="panel"
        />
      );
    const clear = ramp(["#00000000", "#ff0000"]);
    const bar = getComputedStyle(clear.container.querySelector("[data-legend-ramp]") as HTMLElement);
    expect(bar.backgroundImage.match(/linear-gradient/g)).toHaveLength(3);
    clear.unmount();
    const opaque = ramp(["#000000", "#ff0000"]);
    const plain = getComputedStyle(opaque.container.querySelector("[data-legend-ramp]") as HTMLElement);
    expect(plain.backgroundImage.match(/linear-gradient/g)).toHaveLength(1);
  });

  it("a raster class with its own alpha lies over the checkerboard", () => {
    const legend = buildLegend(
      {
        version: "1.0.0",
        kind: "raster",
        render: {
          type: "categorical",
          band: 1,
          classes: [
            { value: 1, color: "#4a90c280" },
            { value: 2, color: "#2e7d32" },
          ],
        },
      },
      { zoom: 10 }
    );
    const [clear, opaque] = entries(legend?.sections);
    expect(clear.swatch.fill?.color).toBe("#4a90c280");
    expect(drawn(clear.swatch).querySelector("[data-checker]")).not.toBeNull();
    expect(drawn(opaque.swatch).querySelector("[data-checker]")).toBeNull();
  });
});
