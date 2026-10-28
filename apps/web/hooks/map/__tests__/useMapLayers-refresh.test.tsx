import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MapResponse } from "@/lib/api/map";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { ProjectLayer } from "@/lib/validations/project";

import { useMapLayers } from "@/hooks/map/useMapLayers";

const { fetchMock, rowsFetcher } = vi.hoisted(() => ({ fetchMock: vi.fn(), rowsFetcher: vi.fn() }));
// The map request goes through apiRequestAuth; the layer rows through the shared fetcher (parsed JSON).
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: fetchMock, fetcher: rowsFetcher }));
vi.mock("@/lib/providers/PublicProjectProvider", () => ({ useIsPublicProject: () => false }));

const PROJECT = "00000000-0000-0000-0000-000000000001";
const DOC = { version: 1, kind: "vector" } as LayerStyle;
const row = (id: number) =>
  ({ id, layer_id: `dataset-${id}`, name: `L${id}`, type: "feature", order: 0 }) as unknown as ProjectLayer;
const style = (id: string) => ({
  id,
  name: id,
  position: 0,
  revision: 1,
  document: DOC,
  issues: [],
  stale: false,
});
const mapOf = (ids: number[]): MapResponse => ({
  map: {
    version: 1,
    layers: ids.map((id) => ({ type: "layer" as const, id, visible: true, style: `s${id}` })),
  },
  styles: Object.fromEntries(ids.map((id) => [String(id), { active: style(`s${id}`), others: [] }])),
  unpublished: [],
});

let rows: ProjectLayer[] = [];
let mapIds: number[] = [];
const reply = (json: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => Promise.resolve(json),
});
const mapCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/map"));

describe("useMapLayers", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(reply(mapOf(mapIds))));
    rowsFetcher.mockReset();
    rowsFetcher.mockImplementation(async () => rows);
  });

  it("a layer added to the project asks the map request again, once", async () => {
    rows = [row(5)];
    mapIds = [5];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const { result } = renderHook(() => useMapLayers(PROJECT), { wrapper });
    await waitFor(() => expect(result.current.layers.map((l) => l.id)).toEqual([5]));
    const before = mapCalls().length;

    // A dataset picker added layer 7: the rows know it, the map document does not yet.
    rows = [row(5), row(7)];
    mapIds = [5, 7];
    await act(async () => {
      await result.current.mutateRows();
    });
    await waitFor(() => expect(result.current.layers.map((l) => l.id)).toEqual([5, 7]));
    expect(mapCalls().length).toBe(before + 1);
  });

  it("a stale style is asked for once, so the map draws it recomputed; a hidden one when it is shown", async () => {
    rows = [row(5), row(6)];
    mapIds = [5, 6];
    const RECOMPUTED = { version: 1, kind: "vector", opacity: 0.5 } as LayerStyle;
    const map = mapOf([5, 6]);
    map.styles["5"].active.stale = true;
    map.styles["6"].active.stale = true;
    (map.map.layers![1] as { visible: boolean }).visible = false;
    fetchMock.mockImplementation((url: string) => {
      const style = String(url).match(/\/layer\/(\d+)\/style\/(s\d+)$/);
      if (style)
        return Promise.resolve(
          reply({ ...map.styles[style[1]].active, document: RECOMPUTED, revision: 2, stale: false })
        );
      return Promise.resolve(reply(map));
    });
    const styleCalls = () => fetchMock.mock.calls.filter(([url]) => /\/style\/s\d+$/.test(String(url)));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const { result } = renderHook(() => useMapLayers(PROJECT), { wrapper });
    await waitFor(() =>
      expect(result.current.layers.find((l) => l.id === 5)?.style?.document).toEqual(RECOMPUTED)
    );
    expect(result.current.layers.find((l) => l.id === 5)?.style?.stale).toBe(false);
    expect(styleCalls().map(([url]) => String(url).replace(/^.*\/layer\//, ""))).toEqual(["5/style/s5"]);

    // Shown: the hidden stale layer is asked for now, once.
    await act(async () => {
      await result.current.viewLayerState(6, { visible: true });
    });
    await waitFor(() =>
      expect(result.current.layers.find((l) => l.id === 6)?.style?.document).toEqual(RECOMPUTED)
    );
    expect(styleCalls()).toHaveLength(2);
  });
});
