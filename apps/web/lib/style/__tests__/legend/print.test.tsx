// The print legend (a report's legend element) draws through the same component as the layer list, but writes its
// texts through its own renderer (they can be edited in place). For every case its rows read as the layer list's do.
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { buildLegend, informative } from "@/lib/style/legend";
import type { ReportElement } from "@/lib/validations/reportLayout";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { StyleLegend } from "@/components/map/legend/StyleLegend";
import LegendElementRenderer from "@/components/reports/elements/renderers/LegendElementRenderer";

import { type LegendCase, legendCases } from "./cases";

vi.mock("react-i18next", async () => (await import("./i18n")).reactI18nextMock);

// A print legend without a connected map reads values by zoom at zoom 12.
const ZOOM = 12;
const cases = legendCases().filter((c) => c.values);

const layer = (c: LegendCase) =>
  ({
    id: 5,
    name: "Layer name",
    type: "feature",
    feature_layer_geometry_type: c.geometry,
    visible: true,
    entry: { type: "layer", id: 5 },
    style: {
      id: "s5",
      name: "Default",
      position: 0,
      revision: 1,
      document: c.style as unknown as LayerStyle,
      issues: [],
      stale: false,
    },
    otherStyles: [],
  }) as unknown as MapLayer;

const element: ReportElement = {
  id: "legend-1",
  type: "legend",
  position: { x: 0, y: 0, width: 80, height: 80, z_index: 1 },
  config: {},
  style: { opacity: 1, padding: 0 },
};

/** The text beside each swatch, in drawing order. */
const rows = (root: HTMLElement) =>
  [...root.querySelectorAll('[aria-hidden="true"]')].map((swatch) => swatch.parentElement?.textContent ?? "");

describe("the print legend", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s reads as the layer list's legend", (_id, c) => {
    const legend = buildLegend(c.style, { geometry: c.geometry, zoom: ZOOM })!;
    const list = render(<StyleLegend legend={legend} variant="tree" locale="en" />);
    const expected = rows(list.container);
    list.unmount();

    const { container } = render(<LegendElementRenderer element={element} projectLayers={[layer(c)]} />);
    expect(container.textContent).not.toMatch(/style_editor\.|NaN|undefined/);
    // A layer whose legend is only its base look prints as its name beside one swatch.
    if (!informative(legend)) expect(rows(container)).toHaveLength(1);
    else expect(rows(container)).toEqual(expected);
  });
});
