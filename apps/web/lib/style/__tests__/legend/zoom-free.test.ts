// Legends that read no zoom: `legendDependsOnZoom` says which, so the layer list keeps their rows while the map zooms.
// Each legend case it calls free of the zoom gives the same legend and swatch at every zoom.
import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/style/json";
import { baseSwatch, buildLegend, legendDependsOnZoom } from "@/lib/style/legend";

import { legendCases } from "./cases";

const ZOOMS = [0, 3.5, 9.95, 12, 12.96, 14, 16.4, 22];

describe("legends free of the zoom", () => {
  it("a value by zoom anywhere, clusters, heatmaps and hexagons read the zoom", () => {
    const vector = (extra: JsonObject): JsonObject => ({ version: "1.0.0", kind: "vector", ...extra });
    expect(legendDependsOnZoom(vector({ symbol: { marker: { color: "#ff0000" } } }))).toBe(false);
    expect(
      legendDependsOnZoom(
        vector({
          symbol: {
            marker: {
              size: {
                zoom: [
                  [10, 4],
                  [16, 12],
                ],
              },
            },
          },
        })
      )
    ).toBe(true);
    expect(
      legendDependsOnZoom(
        vector({
          classify: [
            {
              field: "k",
              method: "categories",
              classes: [
                {
                  values: ["a"],
                  marker: {
                    color: {
                      zoom: [
                        [10, "#000000"],
                        [16, "#ffffff"],
                      ],
                    },
                  },
                },
              ],
            },
          ],
        })
      )
    ).toBe(true);
    for (const type of ["cluster", "heatmap", "h3"])
      expect(legendDependsOnZoom(vector({ render: { type } })), type).toBe(true);
  });

  const free = legendCases().filter((c) => !legendDependsOnZoom(c.style));
  it("covers most cases", () => {
    expect(free.length).toBeGreaterThan(80);
  });

  it.each(free.map((c) => [c.id, c] as const))("%s: the same legend at every zoom", (_id, c) => {
    const at = (zoom: number) => ({
      legend: buildLegend(c.style, {
        geometry: c.geometry,
        zoom,
        ...(c.serviceLegendUrl ? { serviceLegendUrl: c.serviceLegendUrl } : {}),
      }),
      swatch: c.geometry ? baseSwatch(c.style, { geometry: c.geometry, zoom }) : null,
    });
    const first = at(ZOOMS[0]);
    for (const zoom of ZOOMS.slice(1)) expect(at(zoom), `zoom ${zoom}`).toEqual(first);
  });
});
