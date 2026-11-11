import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SCALEBAR_PADDING_PX, snapScalebarWidths } from "@/lib/print/scalebar";
import { mmToPx } from "@/lib/print/units";
import type { ReportElement } from "@/lib/validations/reportLayout";

import ScalebarElementRenderer from "@/components/reports/elements/renderers/ScalebarElementRenderer";

// A 100 mm wide rectangle at zoom 12 / lat 48 spans ~4.8 km; the bar rounds
// that down to 2 km, so it only fills part of the rectangle until snapped.
const mapElement = {
  id: "map-1",
  type: "map",
  position: { x: 0, y: 0, width: 200, height: 150, z_index: 0 },
  config: { viewState: { zoom: 12, latitude: 48, longitude: 11 } },
} as unknown as ReportElement;

const scalebar = (config: Record<string, unknown> = {}) =>
  ({
    id: "scalebar-1",
    type: "scalebar",
    position: { x: 0, y: 0, width: 100, height: 20, z_index: 0 },
    config: { mapElementId: "map-1", style: "single_box", unit: "kilometers", segmentsRight: 2, ...config },
  }) as unknown as ReportElement;

const bar = (container: HTMLElement) => container.querySelector('[data-testid="scalebar-bar"]') as HTMLElement;

describe("ScalebarElementRenderer", () => {
  it("draws the bar shorter than an unsnapped rectangle, with the round distance as its last label", () => {
    const { container, getByText } = render(
      <ScalebarElementRenderer element={scalebar()} mapElements={[mapElement]} />
    );
    const width = parseFloat(bar(container).style.width);
    expect(width).toBeLessThan(100);
    expect(width).toBeGreaterThan(0);
    getByText("2 km");
  });

  it("fills the rectangle once it has been snapped to the bar", () => {
    const [, snapped] = snapScalebarWidths([mapElement, scalebar()]);
    const { container } = render(<ScalebarElementRenderer element={snapped} mapElements={[mapElement]} />);
    expect(parseFloat(bar(container).style.width)).toBeCloseTo(100, 6);
    // and the snapped rectangle is the bar plus the padding on both sides
    expect(mmToPx(snapped.position.width)).toBeGreaterThan(2 * SCALEBAR_PADDING_PX);
  });

  it("sizes the bar from the remembered maximum, not from the current rectangle", () => {
    // Snapped at zoom 11.8 the bar is 5 km and nearly fills the maximum. Zoomed
    // in to 12.2 the rectangle has not been refit yet, but the bar is already
    // the shorter 2 km one, centred in the stale rectangle.
    const at118 = { ...mapElement, config: { viewState: { zoom: 11.8, latitude: 48 } } } as ReportElement;
    const [, snapped] = snapScalebarWidths([at118, scalebar()]);
    const zoomedIn = { ...mapElement, config: { viewState: { zoom: 12.2, latitude: 48 } } } as ReportElement;
    const { container, getByText } = render(<ScalebarElementRenderer element={snapped} mapElements={[zoomedIn]} />);
    expect(parseFloat(bar(container).style.width)).toBeLessThan(100);
    getByText("2 km");
  });

  it("uses the whole rectangle for the numeric style", () => {
    const { container } = render(
      <ScalebarElementRenderer element={scalebar({ style: "numeric" })} mapElements={[mapElement]} />
    );
    expect(bar(container).style.width).toBe("100%");
  });
});

describe("ScalebarElementRenderer on a tilted map (3D spec 10)", () => {
  const tilted = (pitch: number) =>
    ({ ...mapElement, config: { viewState: { zoom: 12, latitude: 48, longitude: 11, pitch } } }) as ReportElement;

  it("says the map is not to scale instead of drawing a bar", () => {
    const { container, getByTestId } = render(
      <ScalebarElementRenderer element={scalebar()} mapElements={[tilted(55)]} />
    );
    expect(getByTestId("scalebar-not-to-scale").textContent).toBe("report_scalebar_not_to_scale");
    expect(bar(container)).toBeNull();
  });

  it("draws the bar on a flat map", () => {
    const { container, queryByTestId } = render(
      <ScalebarElementRenderer element={scalebar()} mapElements={[tilted(0)]} />
    );
    expect(queryByTestId("scalebar-not-to-scale")).toBeNull();
    expect(bar(container)).not.toBeNull();
  });
});
