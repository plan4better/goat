// What one legend costs: the work per entry stays small however many classes a classification has.
import { describe, expect, it, vi } from "vitest";

import { buildLegend } from "@/lib/style/legend";

const { calls } = vi.hoisted(() => ({ calls: { markersAsImages: 0 } }));

vi.mock("@/lib/style/compile/points", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/style/compile/points")>();
  return {
    ...actual,
    markersAsImages: (...args: Parameters<typeof actual.markersAsImages>) => {
      calls.markersAsImages += 1;
      return actual.markersAsImages(...args);
    },
  };
});

describe("a legend's cost", () => {
  it("reads which colors the map draws in images once per legend, not once per entry", () => {
    const style = {
      version: "1.0.0",
      kind: "vector",
      symbol: { marker: { shape: "pin", color: "#888888", size: 16 } },
      classify: [
        {
          id: "kind",
          field: "kind",
          method: "categories",
          classes: Array.from({ length: 40 }, (_, i) => ({
            values: [`v${i}`],
            marker: { color: `#00${(i + 16).toString(16)}00` },
          })),
        },
      ],
    };
    calls.markersAsImages = 0;
    const legend = buildLegend(style, { geometry: "point", zoom: 12 });
    expect(legend?.sections[0].kind === "entries" && legend.sections[0].entries).toHaveLength(40);
    expect(calls.markersAsImages).toBeLessThanOrEqual(2);
  });
});
