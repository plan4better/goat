// The legend of markers on polygons and lines (spec 3.3, 7.2): the area or the line with the marker in its middle;
// blocks of the marker's sizes show the markers alone, as for points.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Geometry } from "@/lib/style/compile/types";
import { LEGEND_NEUTRAL, type LegendSection, baseSwatch, buildLegend } from "@/lib/style/legend";

import { SwatchIcon } from "@/components/map/legend/StyleLegend";

const doc = (style: object) => ({ version: 1, kind: "vector", ...style });
const legendOf = (style: object, geometry: Geometry) =>
  buildLegend(doc(style) as never, { geometry, zoom: 12 })!;
const entries = (section: LegendSection | undefined) =>
  section?.kind === "entries" ? section.entries : section?.kind === "sizes" ? section.samples : [];

describe("legend of markers on polygons and lines", () => {
  it("a polygon swatch carries its marker", () => {
    const swatch = baseSwatch(
      doc({
        symbol: { fill: { color: "#f0f0f0" }, marker: { icon: "goat:school", color: "#08519c", size: 12 } },
      }),
      { geometry: "polygon", zoom: 12 }
    );
    expect(swatch.geometry).toBe("polygon");
    expect(swatch.fill?.color).toBe("#f0f0f0");
    expect(swatch.marker).toMatchObject({ color: "#08519c", icon: "goat:school" });
    // The outline is the polygon's: the marker has no stroke.
    expect(swatch.outline).toBeUndefined();
  });

  it("without a marker the swatch has none", () => {
    const swatch = baseSwatch(doc({ symbol: { fill: {} } }), { geometry: "polygon", zoom: 12 });
    expect(swatch.marker).toBeUndefined();
  });

  it("a class that switches the marker on shows it in its entry alone", () => {
    const legend = legendOf(
      {
        symbol: { fill: { color: "#deebf7" } },
        classify: [
          {
            field: "land_use",
            method: "categories",
            classes: [
              { values: ["green"], name: "Green", marker: { icon: "goat:park", color: "#238b45", size: 20 } },
              { values: ["mixed"], name: "Mixed" },
            ],
          },
        ],
      },
      "polygon"
    );
    const [green, mixed] = entries(legend.sections[0]) as Array<{ swatch: { marker?: object } }>;
    expect(green.swatch.marker).toMatchObject({ icon: "goat:park" });
    expect(mixed.swatch.marker).toBeUndefined();
  });

  it("size samples of the marker show the markers alone", () => {
    const legend = legendOf(
      {
        symbol: {
          fill: { color: "#f0f0f0" },
          marker: { color: "#08519c", size: { field: "population", domain: [0, 30000], range: [0, 40] } },
        },
      },
      "polygon"
    );
    const sizes = legend.sections.find((s) => s.kind === "sizes");
    const samples = entries(sizes) as Array<{ swatch: { geometry: string; marker?: { size?: number } } }>;
    expect(samples.map((s) => s.swatch.geometry)).toEqual(["point", "point", "point"]);
    expect(samples.map((s) => s.swatch.marker?.size)).toEqual([0, 20, 40]);
  });

  it("classes of the marker's size show the markers alone, in neutral grey", () => {
    const legend = legendOf(
      {
        symbol: { line: { color: "#2166ac" }, marker: { color: "#2166ac", size: 10 } },
        classify: [
          {
            field: "traffic",
            method: "manual",
            target: "marker.size",
            classes: [
              { to: 2000, marker: { size: 8 } },
              { from: 2000, marker: { size: 16 } },
            ],
          },
        ],
      },
      "line"
    );
    const section = legend.sections[0];
    expect(section.kind === "entries" && section.sized).toBe(true);
    const swatches = (
      entries(section) as Array<{ swatch: { geometry: string; marker?: { color?: string } } }>
    ).map((e) => e.swatch);
    expect(swatches.map((s) => s.geometry)).toEqual(["point", "point"]);
    expect(swatches.map((s) => s.marker?.color)).toEqual([LEGEND_NEUTRAL, LEGEND_NEUTRAL]);
  });

  it("the swatch draws the area with the marker on it, and the line with the marker in its middle", () => {
    const area = render(
      <SwatchIcon
        swatch={{
          geometry: "polygon",
          fill: { color: "#f0f0f0", opacity: 1, pattern: "none" },
          marker: { shape: "circle", color: "#08519c", size: 12, opacity: 1 },
        }}
      />
    );
    expect(area.container.querySelector("rect")).not.toBeNull();
    const dot = area.container.querySelector("[data-marker-shape]") as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.backgroundColor).toBe("rgb(8, 81, 156)");
    const line = render(
      <SwatchIcon
        swatch={{
          geometry: "line",
          line: { color: "#2166ac", width: 2, opacity: 1 },
          marker: { shape: "square", color: "#d7301f", size: 10, opacity: 1 },
        }}
      />
    );
    expect(line.container.querySelector("line")).not.toBeNull();
    expect(line.container.querySelector("[data-marker-shape='square']")).not.toBeNull();
  });
});
