import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilterArea } from "@/lib/filter/area";

import FilterAreaLayer from "@/components/map/FilterAreaLayer";
import { areaOutlineStore } from "@/components/map/panels/filter/area/outline";

const { sources, layers } = vi.hoisted(() => ({
  sources: [] as Record<string, unknown>[],
  layers: [] as Record<string, unknown>[],
}));
vi.mock("react-map-gl/maplibre", () => ({
  Source: ({ children, ...props }: { children: React.ReactNode }) => {
    sources.push(props);
    return <>{children}</>;
  },
  Layer: (props: Record<string, unknown>) => {
    layers.push(props);
    return null;
  },
}));

const area = (enabled: boolean): FilterArea => ({
  pieces: [
    {
      kind: "shape",
      polygons: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    },
  ],
  op: "inside",
  enabled,
});

const owner = {};
/** The layers as they were last rendered: the halo under the line. */
const drawn = () => {
  const last = layers.slice(-2);
  return { halo: last[0], line: last[1], fill: last.find((l) => l.type === "fill") };
};
const paintOf = (layer: Record<string, unknown> | undefined) => layer?.paint as Record<string, unknown>;

describe("FilterAreaLayer", () => {
  afterEach(() => {
    act(() => areaOutlineStore.clear(owner));
    sources.length = 0;
    layers.length = 0;
  });

  it("draws nothing without an area", () => {
    const { container } = render(<FilterAreaLayer />);
    expect(container).toBeEmptyDOMElement();
    expect(sources).toHaveLength(0);
  });

  it("draws the area as an outline over a halo, without a fill", () => {
    render(<FilterAreaLayer />);
    act(() => areaOutlineStore.show(owner, area(true)));
    expect(sources.at(-1)).toMatchObject({ type: "geojson", data: areaOutlineStore.getSnapshot()?.geometry });
    const { halo, line, fill } = drawn();
    expect(fill).toBeUndefined();
    expect([halo.type, line.type]).toEqual(["line", "line"]);
    expect(paintOf(halo)["line-width"] as number).toBeGreaterThan(paintOf(line)["line-width"] as number);
    expect(paintOf(line)["line-dasharray"]).toBeUndefined();
  });

  it("dashes the outline of a switched-off area and keeps the source data", () => {
    render(<FilterAreaLayer />);
    const shown = area(true);
    act(() => areaOutlineStore.show(owner, shown));
    const data = sources.at(-1)?.data;
    act(() => areaOutlineStore.show(owner, { ...shown, enabled: false }));
    expect(paintOf(drawn().line)["line-dasharray"]).toBeDefined();
    expect(sources.at(-1)?.data).toBe(data);
  });
});
