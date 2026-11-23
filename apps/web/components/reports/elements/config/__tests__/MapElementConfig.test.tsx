// The map element's settings for a tilted map (3D spec 10): a note and "Print flat instead".
import { ThemeProvider, createTheme } from "@mui/material";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReportElement } from "@/lib/validations/reportLayout";

import MapElementConfig from "@/components/reports/elements/config/MapElementConfig";

const element = (viewState: Record<string, unknown>) =>
  ({
    id: "map-1",
    type: "map",
    position: { x: 0, y: 0, width: 200, height: 150, z_index: 0 },
    config: { viewState, lock_layers: false },
  }) as unknown as ReportElement;

const renderConfig = (el: ReportElement, onChange = vi.fn()) =>
  render(
    <ThemeProvider theme={createTheme()}>
      <MapElementConfig element={el} onChange={onChange} />
    </ThemeProvider>
  );

describe("MapElementConfig on a tilted map", () => {
  it("explains the tilted print and prints flat on request", () => {
    const onChange = vi.fn();
    const { getByText } = renderConfig(
      element({ latitude: 47.49, longitude: 11.09, zoom: 13, bearing: 30, pitch: 55, mode: "3d" }),
      onChange
    );
    getByText("report_map_tilted_note");
    fireEvent.click(getByText("report_print_flat"));
    expect(onChange).toHaveBeenCalledWith({
      config: expect.objectContaining({
        viewState: expect.objectContaining({ pitch: 0, bearing: 0, mode: "2d", zoom: 13 }),
      }),
    });
  });

  it("shows neither on a flat map", () => {
    const { queryByText } = renderConfig(element({ latitude: 48, longitude: 11, zoom: 12, pitch: 0 }));
    expect(queryByText("report_map_tilted_note")).toBeNull();
    expect(queryByText("report_print_flat")).toBeNull();
  });
});
