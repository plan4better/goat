import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { buildLegend } from "@/lib/style/legend";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { StyleLegend } from "@/components/map/legend/StyleLegend";
import LegendElementRenderer from "@/components/reports/elements/renderers/LegendElementRenderer";

import { goldenPairs } from "../../../../../lib/style/__tests__/fixtures";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "style_editor.range_under": "under",
        "style_editor.range_to": "to",
        "style_editor.range_and_more": "and more",
      })[key] ?? key,
    i18n: { language: "en" },
  }),
}));

const CLASSES = goldenPairs()[1].doc as LayerStyle;
const PLAIN = { version: 1, kind: "vector", symbol: { fill: { color: "#00ff00" } } } as LayerStyle;

const layer = (id: number, name: string, document: LayerStyle, visible = true) =>
  ({
    id,
    name,
    type: "feature",
    feature_layer_geometry_type: "polygon",
    visible,
    entry: { type: "layer", id },
    style: { id: `s${id}`, name: "Default", position: 0, revision: 1, document, issues: [], stale: false },
    otherStyles: [],
  }) as unknown as MapLayer;

const legendElement = (config: Record<string, unknown> = {}): ReportElement => ({
  id: "legend-1",
  type: "legend",
  position: { x: 0, y: 0, width: 80, height: 80, z_index: 1 },
  config,
  style: { opacity: 1, padding: 0 },
});

const entryTexts = (root: HTMLElement) =>
  within(root)
    .getAllByText(/under|to|and more/)
    .map((node) => node.textContent);

describe("the print legend", () => {
  it("a print legend equals the project legend", () => {
    const districts = layer(5, "Districts", CLASSES);
    const tree = render(
      <StyleLegend
        legend={buildLegend(CLASSES as never, { geometry: "polygon", zoom: 12 })!}
        variant="tree"
      />
    );
    const expected = entryTexts(tree.container);
    tree.unmount();

    const { container } = render(
      <LegendElementRenderer
        element={legendElement()}
        projectLayers={[districts, layer(6, "Parks", PLAIN), layer(7, "Hidden", CLASSES, false)]}
      />
    );
    expect(expected).toEqual([
      "under 2,800",
      "2,800 to 3,600",
      expect.any(String),
      expect.any(String),
      "6,300 and more",
    ]);
    expect(entryTexts(container)).toEqual(expected);
    expect(screen.getByText("Districts")).toBeInTheDocument();
    expect(screen.getByText("Parks")).toBeInTheDocument();
    expect(screen.queryByText("Hidden")).toBeNull();
  });

  it("a connected locked map's legend shows its frozen documents", () => {
    const map: ReportElement = {
      id: "map-1",
      type: "map",
      position: { x: 0, y: 0, width: 80, height: 80, z_index: 1 },
      config: {
        lock_layers: true,
        lock_styles: true,
        locked_layer_ids: [5],
        locked_layer_styles: { 5: CLASSES },
      },
      style: { opacity: 1, padding: 0 },
    };
    const { container } = render(
      <LegendElementRenderer
        element={legendElement({ mapElementId: "map-1" })}
        projectLayers={[layer(5, "Districts", PLAIN), layer(6, "Parks", PLAIN)]}
        mapElements={[map]}
      />
    );
    expect(entryTexts(container)[0]).toBe("under 2,800");
    expect(screen.queryByText("Parks")).toBeNull();
  });

  it("text overrides saved before GOAT Style still rename the entries", () => {
    const element = legendElement({
      auto_update: false,
      textOverrides: { legenditem_5_item_0: "Low", legenditem_5_item_1: "Middle" },
    });
    const { unmount } = render(
      <LegendElementRenderer element={element} projectLayers={[layer(5, "Districts", CLASSES)]} />
    );
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("Middle")).toBeInTheDocument();
    expect(screen.queryByText("under 2,800")).toBeNull();
    unmount();
    // A key of the new form wins over the old one.
    const legend = buildLegend(CLASSES as never, { geometry: "polygon", zoom: 12 })!;
    const first = legend.sections.find((section) => section.kind === "entries")!;
    const key = `legenditem_5_${first.id}_${(first as { entries: { id: string }[] }).entries[0].id}`;
    render(
      <LegendElementRenderer
        element={legendElement({
          auto_update: false,
          textOverrides: { legenditem_5_item_0: "Low", [key]: "Lowest" },
        })}
        projectLayers={[layer(5, "Districts", CLASSES)]}
      />
    );
    expect(screen.getByText("Lowest")).toBeInTheDocument();
  });
});
