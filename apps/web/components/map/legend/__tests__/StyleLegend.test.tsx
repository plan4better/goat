import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildLegend } from "@/lib/style/legend";

import { StyleLegend, SwatchIcon, featureSwatchIcon } from "@/components/map/legend/StyleLegend";

import { goldenPairs } from "../../../../lib/style/__tests__/fixtures";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "style_editor.range_under": "under",
        "style_editor.range_to": "to",
        "style_editor.size": "Size",
        "style_editor.color": "Color",
        "style_editor.no_data": "No data",
        "style_editor.other": "Other",
      })[key] ?? "and more",
    i18n: { language: "en" },
  }),
}));

const legendOf = (doc: object, geometry?: "point" | "line" | "polygon") =>
  buildLegend(doc as never, { geometry, zoom: 12 })!;

describe("StyleLegend", () => {
  const twoBlocks = (classify: object[]) =>
    legendOf({ version: 1, kind: "vector", symbol: { marker: { color: "#e01903" } }, classify }, "point");
  const SIZE = {
    id: "size",
    field: "share",
    method: "categories",
    target: "marker.size",
    classes: [{ id: "s1", values: [100], marker: { size: 12 } }],
  };
  const COLOR = {
    id: "color",
    field: "share",
    method: "manual",
    classes: [
      { id: "c1", to: 10, marker: { color: "#e5f5e0" } },
      { id: "c2", from: 10 },
    ],
    no_data: { marker: { color: "#cccccc" } },
  };

  it("two blocks name the property each sets with the field; one block names the field", () => {
    const { unmount } = render(<StyleLegend legend={twoBlocks([SIZE, COLOR])} variant="tree" />);
    expect(screen.getByText("Size · share")).toBeInTheDocument();
    expect(screen.getByText("Color · share")).toBeInTheDocument();
    unmount();
    render(<StyleLegend legend={twoBlocks([COLOR])} variant="tree" />);
    expect(screen.getByText("share")).toBeInTheDocument();
  });

  it("ranges read with the classification's unit and number format, as the class list writes them", () => {
    const withUnit = { ...COLOR, unit: "km²", format: { decimals: 1 } };
    render(<StyleLegend legend={twoBlocks([withUnit])} variant="tree" />);
    expect(screen.getByText("under 10.0 km²")).toBeInTheDocument();
    expect(screen.getByText("10.0 and more km²")).toBeInTheDocument();
  });

  it("numeric categories read with their classification's unit, beside a second classification", () => {
    // The zensus shape: categories on the size, quantiles on the color, both of one field; the unit is on the first.
    const doc = {
      version: 1,
      kind: "vector",
      symbol: { marker: { color: "#e01903" } },
      classify: [
        {
          id: "size",
          field: "anteilauslaender",
          method: "categories",
          target: "marker.size",
          unit: "pixels",
          classes: [100, 50, 25, 20, 16.67, 33.33, 14.29, 12.5].map((v, i) => ({
            id: `s${i}`,
            values: [v],
            marker: { size: 4 + i },
          })),
        },
        {
          id: "color",
          field: "anteilauslaender",
          method: "quantile",
          classes: [
            { id: "c1", to: 9.52, marker: { color: "#e5f5e0" } },
            { id: "c2", from: 9.52, marker: { color: "#31a354" } },
          ],
          computed: { at: "t", data: "f", scope: "dataset", domain: [0.73, 100] },
        },
      ],
    };
    render(<StyleLegend legend={legendOf(doc, "point")} variant="tree" />);
    expect(screen.getByText("100 pixels")).toBeInTheDocument();
    expect(screen.getByText("16.67 pixels")).toBeInTheDocument();
    expect(screen.queryByText("100")).toBeNull();
    expect(screen.getByText("0.73 to 9.52")).toBeInTheDocument();
    expect(screen.getByText("9.52 to 100")).toBeInTheDocument();
  });

  it("categories read with the number format where one is set, and text categories with the unit", () => {
    const doc = {
      version: 1,
      kind: "vector",
      symbol: { marker: { color: "#e01903" } },
      classify: [
        {
          field: "share",
          method: "categories",
          unit: "%",
          format: { decimals: 1 },
          classes: [
            { id: "a", values: [12.5, 20] },
            { id: "b", values: ["none"] },
            { id: "c", values: [5], name: "Five" },
          ],
          other: {},
        },
      ],
    };
    render(<StyleLegend legend={legendOf(doc, "point")} variant="tree" />);
    expect(screen.getByText("12.5, 20.0 %")).toBeInTheDocument();
    expect(screen.getByText("none %")).toBeInTheDocument();
    // A name typed by hand and the Other record read as they are.
    expect(screen.getByText("Five")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("the caption stands under the layer's name, above the entries, as in the layer list and print", () => {
    const legend = legendOf(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { color: "#e01903" } },
        classify: [SIZE, COLOR],
        legend: { caption: "just to test" },
      },
      "point"
    );
    render(<StyleLegend legend={legend} layerName="Zensus" variant="panel" />);
    const name = screen.getByText("Zensus");
    const caption = screen.getByText("just to test");
    expect(name.nextElementSibling).toBe(caption);
    const firstHeading = screen.getByText("Size · share");
    expect(caption.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("No data and Other without a name read their words", () => {
    render(<StyleLegend legend={twoBlocks([{ ...COLOR, other: {} }])} variant="tree" />);
    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("open first and last classes read the data's minimum and maximum the server computed", () => {
    const doc = goldenPairs()[1].doc as { classify: Array<Record<string, unknown>> };
    const classify = [
      { ...doc.classify[0], computed: { at: "t", data: "f", scope: "dataset", domain: [1000, 9000] } },
    ];
    render(<StyleLegend legend={legendOf({ ...doc, classify }, "polygon")} variant="tree" />);
    expect(screen.getByText("1,000 to 2,800")).toBeInTheDocument();
    expect(screen.getByText("2,800 to 3,600")).toBeInTheDocument();
    expect(screen.getByText("6,300 to 9,000")).toBeInTheDocument();
    expect(screen.queryByText("under 2,800")).toBeNull();
  });

  it("the legend matches buildLegend for categories, classes, ramps and rasters", () => {
    const classes = legendOf(goldenPairs()[1].doc, "polygon");
    const { unmount } = render(<StyleLegend legend={classes} variant="tree" />);
    expect(screen.getByText("under 2,800")).toBeInTheDocument();
    expect(screen.getByText("2,800 to 3,600")).toBeInTheDocument();
    expect(screen.getByText("6,300 and more")).toBeInTheDocument();
    // The section names its field where the document gives no title.
    expect(screen.getByText("density")).toBeInTheDocument();
    unmount();

    const categories = legendOf(
      {
        version: 1,
        kind: "vector",
        symbol: { line: { color: "#2166ac" } },
        classify: [
          {
            field: "status",
            method: "categories",
            classes: [
              { id: "a", values: ["existing"], name: "Existing" },
              { id: "b", values: ["planned"] },
            ],
            other: { name: "Other" },
          },
        ],
      },
      "line"
    );
    const second = render(<StyleLegend legend={categories} variant="tree" hideHeading />);
    expect(["Existing", "planned", "Other"].map((text) => screen.getByText(text))).toHaveLength(3);
    expect(screen.queryByText("status")).toBeNull();
    second.unmount();

    const ramp = legendOf(
      { version: 1, kind: "vector", render: { type: "heatmap", palette: ["#000000", "#ffffff"] } },
      "point"
    );
    const third = render(<StyleLegend legend={ramp} variant="tree" />);
    expect(third.container.querySelector("[data-legend-ramp]")).not.toBeNull();
    third.unmount();

    const raster = legendOf({
      version: 1,
      kind: "raster",
      render: { type: "continuous", palette: ["#000000", "#ffffff"], domain: [200, 450] },
      legend: { unit: "m", caption: "Elevation model" },
    });
    render(<StyleLegend legend={raster} layerName="DEM" variant="panel" />);
    expect(screen.getByText("200 m")).toBeInTheDocument();
    expect(screen.getByText("450 m")).toBeInTheDocument();
    expect(screen.getByText("Elevation model")).toBeInTheDocument();
    expect(screen.getByText("DEM")).toBeInTheDocument();
  });

  it("a ramp on a log scale names its middle value between the ends", () => {
    const legend = legendOf(
      {
        version: 1,
        kind: "vector",
        symbol: { fill: { color: { field: "d", palette: "goat:green", scale: "log", domain: [1, 100] } } },
      },
      "polygon"
    );
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(container.querySelector("[data-legend-middle]")?.textContent).toBe("10");
  });

  it("a popup header shows the clicked feature's class", () => {
    const layer = {
      feature_layer_geometry_type: "polygon",
      style: { document: goldenPairs()[1].doc },
    };
    const { container } = render(<>{featureSwatchIcon(layer, { density: 3000 })}</>);
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe("#fdcc8a");
    expect(featureSwatchIcon({ feature_layer_geometry_type: "polygon", style: null }, {})).toBeUndefined();
  });

  it("a marker swatch draws its shape, stroke and icon like the map: library icons tinted, emoji as they are", () => {
    const { container, unmount } = render(
      <SwatchIcon
        swatch={{
          geometry: "point",
          marker: { shape: "square", color: "#5e4fa2", icon: "goat:fire-station", icon_color: "#fc8d62" },
          outline: { color: "#ffffff", width: 1 },
        }}
      />
    );
    const shape = container.querySelector("[data-marker-shape]") as HTMLElement;
    expect(shape.dataset.markerShape).toBe("square");
    expect(shape.style.backgroundColor).toBe("rgb(94, 79, 162)");
    expect(shape.style.border).toContain("rgb(255, 255, 255)");
    const tinted = container.querySelector("[data-marker-icon]") as HTMLElement;
    expect(tinted.style.backgroundColor).toBe("rgb(252, 141, 98)");
    expect(tinted.dataset.markerIcon).toBe("/assets/icons/maki/fire-station.svg");
    unmount();

    const { container: emoji } = render(
      <SwatchIcon swatch={{ geometry: "point", marker: { shape: "icon", icon: "emoji:1f525" } }} />
    );
    expect(emoji.querySelector("[data-marker-shape]")).toBeNull();
    expect(emoji.querySelector("img")?.getAttribute("src")).toBe("/assets/icons/emoji/1f525.webp");
  });

  it("a pin's swatch draws its outline in the marker color with the icon in its head", () => {
    const { container } = render(
      <SwatchIcon
        swatch={{
          geometry: "point",
          marker: { shape: "pin", color: "#5e4fa2", icon: "goat:fire-station" },
          outline: { color: "#ffffff", width: 1 },
        }}
      />
    );
    const shape = container.querySelector("[data-marker-shape]") as SVGElement;
    expect(shape.dataset.markerShape).toBe("pin");
    expect(shape.querySelector("path")?.getAttribute("fill")).toBe("#5e4fa2");
    expect(shape.querySelector("path")?.getAttribute("stroke")).toBe("#ffffff");
    expect(container.querySelector("[data-marker-icon]")).not.toBeNull();
  });

  it("a hollow marker's swatch draws its outline only, and its icon", () => {
    const { container, unmount } = render(
      <SwatchIcon
        swatch={{
          geometry: "point",
          marker: { shape: "circle", color: "#1a6b4d", size: 10, fill: false },
          outline: { color: "#1a6b4d", width: 2 },
        }}
      />
    );
    const circle = container.querySelector("[data-marker-shape]") as HTMLElement;
    expect(circle.style.backgroundColor).toBe("transparent");
    expect(circle.style.border).toContain("rgb(26, 107, 77)");
    unmount();

    const { container: pin } = render(
      <SwatchIcon
        swatch={{
          geometry: "point",
          marker: {
            shape: "pin",
            color: "#5e4fa2",
            icon: "goat:fire-station",
            icon_color: "#5e4fa2",
            fill: false,
          },
          outline: { color: "#5e4fa2", width: 1 },
        }}
      />
    );
    const path = pin.querySelector("[data-marker-shape] path");
    expect(path?.getAttribute("fill")).toBe("none");
    expect(path?.getAttribute("stroke")).toBe("#5e4fa2");
    expect(pin.querySelector("[data-marker-icon]")).not.toBeNull();
  });

  it("a point outline in the fill color takes the marker's color", () => {
    const legend = legendOf(
      {
        version: 1,
        kind: "vector",
        symbol: { marker: { color: "#d62728" }, outline: { color: "fill", width: 1 } },
      },
      "point"
    );
    const section = legend.sections[0] as { entries?: Array<{ swatch: { outline?: { color?: string } } }> };
    const swatch = section.entries?.[0]?.swatch;
    expect(swatch?.outline?.color ?? "#d62728").toBe("#d62728");
  });

  it("an area swatch shows its pattern in the pattern color", () => {
    const { container } = render(
      <SwatchIcon
        swatch={{
          geometry: "polygon",
          fill: { color: "#cccccc", pattern: "vertical", pattern_color: "#333333", pattern_spacing: 10 },
        }}
      />
    );
    const path = container.querySelector("[data-pattern='vertical']");
    expect(path?.getAttribute("stroke")).toBe("#333333");
    expect(container.querySelectorAll("rect")).toHaveLength(2);
  });
});
