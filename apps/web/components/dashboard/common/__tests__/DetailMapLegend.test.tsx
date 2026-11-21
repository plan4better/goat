import { createTheme } from "@mui/material";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildLegend } from "@/lib/style/legend";

import DetailMapLegend from "@/components/dashboard/common/DetailMapLegend";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const BODY2 = createTheme().typography.body2.fontSize;

const rasterLegend = () =>
  buildLegend(
    {
      version: "1.0.0",
      kind: "raster",
      render: { type: "continuous", palette: ["#000000", "#ffffff"], domain: [0, 255] },
      legend: { unit: "m", caption: "Elevation model" },
    } as never,
    { zoom: 12 }
  )!;

const manyClasses = () =>
  buildLegend(
    {
      version: "1.0.0",
      kind: "vector",
      symbol: { fill: { color: "#2bb381" } },
      classify: [
        {
          id: "c",
          field: "zone",
          method: "categories",
          classes: Array.from({ length: 40 }, (_, i) => ({
            id: `k${i}`,
            values: [`zone ${i}`],
            fill: { color: "#2166ac" },
          })),
        },
      ],
    } as never,
    { geometry: "polygon", zoom: 12 }
  )!;

const box = () => document.querySelector("[data-detail-map-legend]") as HTMLElement;

describe("DetailMapLegend", () => {
  it("draws nothing without a legend", () => {
    const { container } = render(<DetailMapLegend legend={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("floats the legend in the map's bottom-left corner, at least 200 px wide so a ramp spans it", () => {
    render(<DetailMapLegend legend={rasterLegend()} />);

    expect(screen.getByTestId("legend-preview")).toBeInTheDocument();
    expect(box()).toHaveStyle({
      position: "absolute",
      left: "8px",
      bottom: "8px",
      minWidth: "200px",
      maxWidth: "280px",
      zIndex: "2",
    });
  });

  it("names a ramp's ends with the style's unit, apart, in text one step above the layer list's", () => {
    const { container } = render(<DetailMapLegend legend={rasterLegend()} />);

    const labels = container.querySelector("[data-legend-ramp-labels]") as HTMLElement;
    expect([...labels.children].map((child) => child.textContent)).toEqual(["0 m", "255 m"]);
    expect(getComputedStyle(screen.getByText("255 m")).fontSize).toBe(BODY2);
  });

  it("writes the legend's caption at the entries' size, so the sizes do not mix", () => {
    render(<DetailMapLegend legend={rasterLegend()} />);

    expect(getComputedStyle(screen.getByText("Elevation model")).fontSize).toBe(BODY2);
  });

  it("writes entries and their heading one step above the layer list's caption", () => {
    render(<DetailMapLegend legend={manyClasses()} />);

    expect(getComputedStyle(screen.getByText("zone 0")).fontSize).toBe(BODY2);
    expect(getComputedStyle(screen.getByText("zone")).fontSize).toBe(BODY2);
  });

  it("scrolls a long class list inside the box rather than covering the map", () => {
    render(<DetailMapLegend legend={manyClasses()} />);

    expect(screen.getByText("zone 39")).toBeInTheDocument();
    expect(box()).toHaveStyle({ maxHeight: "70%", overflowY: "auto" });
  });
});
