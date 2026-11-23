import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PRESENCE_PENDING, buildLegend } from "@/lib/style/legend";

import { StyleLegend, SwatchIcon, featureSwatchIcon } from "@/components/map/legend/StyleLegend";

import { goldenPairs } from "../../../../lib/style/__tests__/fixtures";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (
        ({
          "style_editor.range_under": "under",
          "style_editor.range_to": "to",
          "style_editor.size": "Size",
          "style_editor.color": "Color",
          "style_editor.no_data": "No data",
          "style_editor.other": "Other",
          "style_editor.legend_height_storeys": "Height · {{field}} × {{storey}} m",
          "style_editor.legend_height_h3": "Height · {{value_label}}",
          "style_editor.h3_value_sum": "Sum of {{field}}",
          "style_editor.h3_value_mean": "Mean of {{field}}",
          "style_editor.legend_clusters": "Clusters",
          "style_editor.legend_single_points": "Single points",
          "style_editor.legend_none_view": "None in view",
          "style_editor.legend_none_filter": "None kept by the filter",
          show_more_count: "Show {{count}} more",
        })[key] ?? "and more"
      ).replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name] ?? "")),
    i18n: { language: "en" },
  }),
}));

const legendOf = (doc: object, geometry?: "point" | "line" | "polygon") =>
  buildLegend(doc as never, { geometry, zoom: 12 })!;

describe("StyleLegend", () => {
  it("a long list of entries shows its first ten and Show N more where asked; print lists all", () => {
    const legend = {
      sections: [
        {
          kind: "entries" as const,
          id: "raster",
          entries: Array.from({ length: 15 }, (_, i) => ({
            id: String(i),
            name: `Class ${i + 1}`,
            swatch: { geometry: "polygon" as const, fill: { color: "#cccccc" } },
          })),
        },
      ],
    };
    const { unmount } = render(<StyleLegend legend={legend} variant="tree" collapseAfter={10} />);
    expect(screen.getByText("Class 10")).toBeDefined();
    expect(screen.queryByText("Class 11")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getByText("Class 15")).toBeDefined();
    unmount();
    render(<StyleLegend legend={legend} variant="tree" />);
    expect(screen.getByText("Class 15")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show 5 more" })).toBeNull();
  });

  it("a list collapses only where at least three entries hide", () => {
    const entries = (count: number) => ({
      sections: [
        {
          kind: "entries" as const,
          id: "use",
          entries: Array.from({ length: count }, (_, i) => ({
            id: String(i),
            name: `Class ${i + 1}`,
            swatch: { geometry: "polygon" as const, fill: { color: "#cccccc" } },
          })),
        },
      ],
    });
    // One or two entries more than the ten: the link would take the room of what it hides.
    for (const count of [11, 12]) {
      const { unmount } = render(<StyleLegend legend={entries(count)} variant="tree" collapseAfter={10} />);
      expect(screen.getByText(`Class ${count}`)).toBeDefined();
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
    render(<StyleLegend legend={entries(13)} variant="tree" collapseAfter={10} />);
    expect(screen.getByText("Class 10")).toBeDefined();
    expect(screen.queryByText("Class 11")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(screen.getByText("Class 13")).toBeDefined();
  });

  it("a legend of the name only draws its title alone under the layer's row", () => {
    const legend = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        legend: { display: "name_only", title: "Land use 2024" },
      },
      "polygon"
    );
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(screen.getByText("Land use 2024")).toBeDefined();
    expect(container.querySelector("svg")).toBeNull();
  });

  const twoBlocks = (classify: object[]) =>
    legendOf(
      { version: "1.0.0", kind: "vector", symbol: { marker: { color: "#e01903" } }, classify },
      "point"
    );
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

  it("a classification still being counted draws placeholder rows under its heading, no classes", () => {
    const doc = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { color: "#e01903" } },
      classify: [COLOR],
    };
    const legend = buildLegend(doc as never, { geometry: "point", zoom: 12, present: PRESENCE_PENDING })!;
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(screen.getByText("share")).toBeDefined();
    const waiting = container.querySelector("[data-legend-pending]") as HTMLElement;
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    expect(waiting.querySelectorAll("[data-legend-placeholder]")).toHaveLength(3);
    expect(screen.queryByText("No data")).toBeNull();
  });

  it("a legend the counts emptied shows a note in place of a swatch", () => {
    const doc = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { color: "#e01903" } },
      classify: [COLOR],
      legend: { classes: "view" },
    };
    const none = { classes: new Set<string>(), other: false, no_data: false };
    const legend = buildLegend(doc as never, { geometry: "point", zoom: 12, present: { color: none } })!;
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(screen.getByText("None in view")).toBeDefined();
    expect(container.querySelector("[data-marker-shape]")).toBeNull();
    const filtered = buildLegend({ ...doc, legend: { classes: "filter" } } as never, {
      geometry: "point",
      zoom: 12,
      present: { color: none },
    })!;
    render(<StyleLegend legend={filtered} variant="tree" />);
    expect(screen.getByText("None kept by the filter")).toBeDefined();
  });

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
    expect(screen.getByText("10.0 km² and more")).toBeInTheDocument();
  });

  it("numeric categories read with their classification's unit, beside a second classification", () => {
    // The zensus shape: categories on the size, quantiles on the color, both of one field; the unit is on the first.
    const doc = {
      version: "1.0.0",
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

  it("categories read with the number format where one is set; the unit follows numbers, not names", () => {
    const doc = {
      version: "1.0.0",
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
    expect(screen.getByText("none")).toBeInTheDocument();
    // A name typed by hand and the Other record read as they are.
    expect(screen.getByText("Five")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("the caption stands under the layer's name, above the entries, as in the layer list and print", () => {
    const legend = legendOf(
      {
        version: "1.0.0",
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
        version: "1.0.0",
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
      { version: "1.0.0", kind: "vector", render: { type: "heatmap", palette: ["#000000", "#ffffff"] } },
      "point"
    );
    const third = render(<StyleLegend legend={ramp} variant="tree" />);
    expect(third.container.querySelector("[data-legend-ramp]")).not.toBeNull();
    third.unmount();

    const raster = legendOf({
      version: "1.0.0",
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

  it("a raster's nearest stops draw as hard steps, and its other values as an Other entry", () => {
    const stops = legendOf({
      version: "1.0.0",
      kind: "raster",
      render: {
        type: "continuous",
        interpolate: "nearest",
        stops: [
          { value: 0, color: "#000000" },
          { value: 10, color: "#ff0000" },
          { value: 20, color: "#0000ff" },
        ],
      },
    });
    const first = render(<StyleLegend legend={stops} variant="panel" />);
    expect(first.container.querySelector("[data-legend-ramp]")).toHaveStyle({
      background:
        "linear-gradient(90deg, #000000 0%, #000000 25%, #ff0000 25%, #ff0000 75%, #0000ff 75%, #0000ff 100%)",
    });
    first.unmount();

    const categories = legendOf({
      version: "1.0.0",
      kind: "raster",
      render: {
        type: "categorical",
        classes: [{ value: 1, name: "Water", color: "#4a90c2" }],
        other_color: "#cccccc",
      },
    });
    render(<StyleLegend legend={categories} variant="panel" />);
    expect(["Water", "Other"].map((text) => screen.getByText(text))).toHaveLength(2);
  });

  it("a ramp's end labels keep a gap between them, so they never run together in a narrow box", () => {
    const raster = legendOf({
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", palette: ["#000000", "#ffffff"], domain: [0, 255] },
    });
    const { container } = render(<StyleLegend legend={raster} variant="tree" />);
    const labels = container.querySelector("[data-legend-ramp-labels]") as HTMLElement;
    expect(labels).not.toBeNull();
    expect([...labels.children].map((child) => child.textContent)).toEqual(["0", "255"]);
    // The gap is a theme step; any width will do, as long as there is one.
    expect(getComputedStyle(labels).gap).toMatch(/^[1-9][\d.]*(px|rem)$/);
  });

  it("a ramp on a log scale names its middle value between the ends", () => {
    const legend = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: { field: "d", palette: "goat:green", scale: "log", domain: [1, 100] } } },
      },
      "polygon"
    );
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(container.querySelector("[data-legend-middle]")?.textContent).toBe("10");
  });

  it("ramp bars and H3 swatches draw at the features' own opacity, not the layer's", () => {
    const fill = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        opacity: 0.3,
        symbol: { fill: { color: { field: "d", palette: "goat:green", domain: [0, 10] }, opacity: 0.5 } },
      },
      "polygon"
    );
    const first = render(<StyleLegend legend={fill} variant="tree" />);
    expect(first.container.querySelector("[data-legend-ramp]")).toHaveStyle({ opacity: "0.5" });
    first.unmount();

    const stamp = { at: "2026-10-26T00:00:00Z", data: "ducklake:1", scope: "dataset" };
    const h3 = (render: object) =>
      legendOf({ version: "1.0.0", kind: "vector", render: { type: "h3", ...render } }, "point");
    const ramp = render(
      <StyleLegend
        legend={h3({
          resolution: 8,
          palette: ["#000001", "#000002"],
          computed: { ...stamp, resolutions: { "8": { min: 2, max: 40 } } },
        })}
        variant="tree"
      />
    );
    expect(ramp.container.querySelector("[data-legend-ramp]")).toHaveStyle({ opacity: "0.85" });
    ramp.unmount();

    const classes = render(
      <StyleLegend
        legend={h3({
          resolution: 8,
          palette: ["#000001", "#000002"],
          classify: { method: "quantile", count: 2 },
          computed: { ...stamp, resolutions: { "8": { min: 2, max: 40, breaks: [10] } } },
        })}
        variant="tree"
      />
    );
    const rects = [...classes.container.querySelectorAll("svg rect")];
    expect(rects).toHaveLength(2);
    for (const rect of rects) expect(rect.getAttribute("fill-opacity")).toBe("0.85");
    classes.unmount();

    // A heatmap at full strength: the bar is not faded.
    const heatmap = render(
      <StyleLegend
        legend={legendOf(
          { version: "1.0.0", kind: "vector", render: { type: "heatmap", palette: ["#000000", "#ffffff"] } },
          "point"
        )}
        variant="tree"
      />
    );
    expect(heatmap.container.querySelector("[data-legend-ramp]")).toHaveStyle({ opacity: "1" });
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
    // Loaded as a CORS request, as the map loads its icons.
    expect(emoji.querySelector("img")?.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("clusters with a value say what the value is", () => {
    const legend = buildLegend(
      {
        version: "1.0.0",
        kind: "vector",
        render: {
          type: "cluster",
          value: { op: "mean", field: "turnover" },
          symbol: {
            marker: { shape: "circle", size: { field: "value", range: [10, 30], domain: [0, 1000] } },
          },
        },
      },
      { geometry: "point", zoom: 12 }
    )!;
    render(<StyleLegend legend={legend} variant="tree" />);
    expect(screen.getByText("Clusters · Mean of turnover")).toBeDefined();
    // No heading of the field over the Clusters entry: it names it.
    expect(screen.queryByText("turnover")).toBeNull();
    expect(screen.getByText("Mean of turnover")).toBeDefined();
  });

  it("below the Clusters row, the base look reads as the single points", () => {
    const legend = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        render: { type: "cluster" },
        symbol: { marker: { shape: "circle", color: "#283593", size: 8 } },
      },
      "point"
    );
    const { container } = render(<StyleLegend legend={legend} variant="tree" />);
    expect(container.textContent).toBe("ClustersSingle points");
  });

  it("a cluster swatch with a badge draws a dot in the badge color at the marker's upper right", () => {
    const { container } = render(
      <SwatchIcon
        swatch={{
          geometry: "point",
          marker: { shape: "icon", icon: "goat:shop", color: "#5a1846" },
          badge: { color: "#2838b2", text: "#ffff00", ring: "#ffffff" },
        }}
      />
    );
    const badge = container.querySelector("[data-cluster-badge]") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.backgroundColor).toBe("rgb(40, 56, 178)");
    expect(badge.style.border).toBe("1px solid rgb(255, 255, 255)");
    expect(badge.style.top).toBe("0px");
    expect(badge.style.right).toBe("0px");
    const plain = render(<SwatchIcon swatch={{ geometry: "point", marker: { shape: "circle" } }} />);
    expect(plain.container.querySelector("[data-cluster-badge]")).toBeNull();
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
        version: "1.0.0",
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

  it("a layer with height ends with its Height line", () => {
    const storeys = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        symbol: { extrude: { height: { field: "levels" }, unit: "storeys" } },
      },
      "polygon"
    );
    const { unmount } = render(<StyleLegend legend={storeys} variant="tree" />);
    expect(screen.getByText("Height · levels × 3 m")).toBeInTheDocument();
    unmount();
    const h3 = legendOf(
      {
        version: "1.0.0",
        kind: "vector",
        render: { type: "h3", value: { op: "sum", field: "residents" }, extrude: { tallest: 500 } },
      },
      "point"
    );
    render(<StyleLegend legend={h3} variant="tree" />);
    expect(screen.getByText("Height · Sum of residents")).toBeInTheDocument();
  });
});
