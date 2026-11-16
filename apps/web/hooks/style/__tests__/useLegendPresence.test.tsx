// Which classes a layer's legend lists (spec 7.2 `legend.classes`): with `filter`, counted by the server under the
// layer's saved filter with the processes requests that take one, once per filter; with `view`, read from the map's
// count; with `all`, nothing to ask. Invented data only.
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFeatureCount, getUniqueValues } from "@/lib/api/processes";
import { getHistogramStats } from "@/lib/api/projects";
import type { JsonObject } from "@/lib/style/json";
import { PRESENCE_PENDING } from "@/lib/style/legend";
import { watchViewPresence } from "@/lib/style/render/viewPresence";

import { useLayerLegend, useLegendPresence, useLegendsWaiting } from "@/hooks/style/useLegendPresence";

vi.mock("@/lib/api/processes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/processes")>()),
  getUniqueValues: vi.fn(),
  getFeatureCount: vi.fn(),
}));
vi.mock("@/lib/api/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/projects")>()),
  getHistogramStats: vi.fn(),
}));

const uniqueValues = vi.mocked(getUniqueValues);
const featureCount = vi.mocked(getFeatureCount);
const histogram = vi.mocked(getHistogramStats);

const STAMP = { at: "2026-01-01T00:00:00Z", data: "synthetic:1", scope: "dataset" };

const KINDS = {
  id: "kind",
  field: "kind",
  method: "categories",
  classes: [
    { id: "c1", values: ["alpha"] },
    { id: "c2", values: ["beta"] },
  ],
  no_data: { marker: { color: "#000005" } },
  computed: { ...STAMP, other: false, no_data: true },
};

const SIZES = {
  id: "size",
  field: "size",
  method: "manual",
  classes: [
    { id: "s1", to: 10 },
    { id: "s2", from: 10, to: 20 },
    { id: "s3", from: 20 },
  ],
  computed: { ...STAMP, other: false, no_data: false },
};

const style = (classify: object[], classes?: string): JsonObject => ({
  version: 1,
  kind: "vector",
  classify,
  ...(classes ? { legend: { classes } } : {}),
});

const CQL = { op: ">", args: [{ property: "rank" }, 3] };
const layer = (cql: unknown = CQL) => ({ key: "7", dataset: "dataset-1", cql });

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const plain = (presence: unknown) =>
  presence === undefined
    ? undefined
    : JSON.parse(JSON.stringify(presence, (_, v) => (v instanceof Set ? [...v] : v)));

beforeEach(() => {
  uniqueValues.mockResolvedValue({
    attribute: "kind",
    total: 2,
    values: [
      { value: "beta", count: 4 },
      { value: "omega", count: 1 },
    ],
  });
  featureCount.mockResolvedValue({ count: 2 });
  histogram.mockResolvedValue({ bins: [{ range: [12, 18], count: 3 }], missing_count: 0, total_rows: 3 });
});
afterEach(() => vi.clearAllMocks());

describe("useLegendPresence", () => {
  it("filter, categories: the values the saved filter keeps, features without a value counted on their own", async () => {
    const { result } = renderHook(() => useLegendPresence(style([KINDS]), layer(), "map"), { wrapper });
    // While the server counts, the legend waits rather than list every class and then shrink.
    expect(result.current).toBe(PRESENCE_PENDING);
    await waitFor(() => expect(result.current).not.toBe(PRESENCE_PENDING));
    expect(plain(result.current)).toEqual({ kind: { classes: ["c2"], other: true, no_data: true } });
    const filter = JSON.stringify(CQL);
    expect(uniqueValues).toHaveBeenCalledWith("dataset-1", "kind", { filter, limit: 1000 });
    expect(featureCount).toHaveBeenCalledWith(
      "dataset-1",
      JSON.stringify({ op: "and", args: [CQL, { op: "isNull", args: [{ property: "kind" }] }] })
    );
  });

  it("filter, numeric classes: the histogram over the class bounds under the filter", async () => {
    const { result } = renderHook(() => useLegendPresence(style([SIZES]), layer(), "map"), { wrapper });
    await waitFor(() => expect(result.current).not.toBe(PRESENCE_PENDING));
    expect(plain(result.current)).toEqual({ size: { classes: ["s2"], other: false, no_data: false } });
    expect(histogram).toHaveBeenCalledWith("dataset-1", {
      column_name: "size",
      num_bins: 3,
      method: "custom_breaks",
      custom_breaks: [10, 20],
      query: JSON.stringify(CQL),
    });
    expect(uniqueValues).not.toHaveBeenCalled();
  });

  it("asks once per layer and filter, however many legends show it; another filter asks again", async () => {
    const doc = style([KINDS]);
    const { result, rerender } = renderHook(
      ({ cql }) => [useLegendPresence(doc, layer(cql), "map"), useLegendPresence(doc, layer(cql), "map")],
      { wrapper, initialProps: { cql: CQL as unknown } }
    );
    await waitFor(() => expect(result.current[1]).not.toBe(PRESENCE_PENDING));
    expect(uniqueValues).toHaveBeenCalledTimes(1);
    rerender({ cql: { op: "<", args: [{ property: "rank" }, 2] } });
    // Until the new counts arrive the legend waits.
    expect(result.current[0]).toBe(PRESENCE_PENDING);
    await waitFor(() => expect(result.current[0]).not.toBe(PRESENCE_PENDING));
    expect(uniqueValues).toHaveBeenCalledTimes(2);
  });

  it("without a saved filter, with `all` or `view`, nothing is asked of the server", async () => {
    const { result } = renderHook(
      () => [
        useLegendPresence(style([KINDS]), layer(null), "map"),
        useLegendPresence(style([KINDS]), layer({}), "map"),
        useLegendPresence(style([KINDS], "all"), layer(), "map"),
        useLegendPresence(style([KINDS], "view"), layer(), "map"),
      ],
      { wrapper }
    );
    await act(async () => undefined);
    // `view` waits for the map's count instead.
    expect(result.current).toEqual([undefined, undefined, undefined, PRESENCE_PENDING]);
    expect(uniqueValues).not.toHaveBeenCalled();
    expect(featureCount).not.toHaveBeenCalled();
    expect(histogram).not.toHaveBeenCalled();
  });

  it("a count that fails lists every class of its classification", async () => {
    histogram.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLegendPresence(style([KINDS, SIZES]), layer(), "map"), {
      wrapper,
    });
    await waitFor(() => expect(result.current).not.toBe(PRESENCE_PENDING));
    expect(Object.keys(result.current as object)).toEqual(["kind"]);
  });

  it("view: the map's count of this layer, in this map", () => {
    vi.useFakeTimers();
    const doc = style([KINDS], "view");
    const map = {
      on: () => undefined,
      off: () => undefined,
      once: () => undefined,
      isMoving: () => false,
      loaded: () => true,
      getLayer: () => ({}),
      queryRenderedFeatures: () => [{ properties: { kind: "alpha" } }],
    };
    const { result } = renderHook(
      () => [useLegendPresence(doc, layer(), "map"), useLegendPresence(doc, layer(), "print:p1")],
      { wrapper }
    );
    // Neither map has counted yet: both legends wait.
    expect(result.current).toEqual([PRESENCE_PENDING, PRESENCE_PENDING]);
    const watch = watchViewPresence(map, "map", () => [{ key: "7", style: doc }], {
      layerIds: () => ["7-marker"],
    });
    act(() => {
      watch.refresh();
      vi.runAllTimers();
    });
    expect(plain(result.current[0])).toEqual({ kind: { classes: ["c1"], other: false, no_data: false } });
    // The print map has not counted: its legend still waits.
    expect(result.current[1]).toBe(PRESENCE_PENDING);
    act(() => watch.dispose());
    vi.useRealTimers();
    expect(uniqueValues).not.toHaveBeenCalled();
  });

  it("tells the print page while any legend waits for its counts, so a PDF never shows a placeholder", async () => {
    const { result, unmount } = renderHook(
      () => {
        useLayerLegend(style([KINDS]), { geometry: "point", zoom: 12 }, layer(), "map");
        return useLegendsWaiting();
      },
      { wrapper }
    );
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
    unmount();
  });
});
