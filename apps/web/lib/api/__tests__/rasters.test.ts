import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import {
  fetchRasterPoint,
  loadFormulaSample,
  rasterErrorOf,
  rasterInfoUrl,
  useRasterInfo,
} from "@/lib/api/rasters";
import { bandBreaks } from "@/lib/style/raster/metadata";

vi.mock("@/lib/api/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/fetcher")>()),
  fetcher: vi.fn(),
  apiRequestAuth: vi.fn(),
}));

describe("raster service errors", () => {
  it("a refused address and a file that cannot be read are told apart", () => {
    expect(rasterErrorOf(undefined)).toBeUndefined();
    expect(rasterErrorOf({ status: 422 })).toBe("refused");
    expect(rasterErrorOf({ status: 504 })).toBe("unavailable");
    expect(rasterErrorOf(new Error("network"))).toBe("unavailable");
  });
});

describe("a raster file's info", () => {
  /** The info as geoapi answers it for `asked`: breaks for that band only. */
  const json = (breaks: number[], asked?: number) => ({
    width: 10,
    height: 10,
    bounds: [11.5, 48.1, 11.6, 48.2],
    count: 2,
    dtype: "float32",
    nodata: null,
    bits: [32, 32],
    color_table: null,
    names: ["", ""],
    scales: [1, 1],
    offsets: [0, 0],
    bands: [1, 2].map((index) => ({
      index,
      min: 0,
      max: 10,
      mean: 5,
      std: 1,
      p2: 0,
      p98: 10,
      histogram: { counts: [], edges: [] },
      values: null,
      approximate: true,
      ...(index === asked ? { breaks: { quantile: { "3": breaks } } } : {}),
    })),
  });

  it("is asked for the breaks of one band; switching the band keeps the info shown until the new one answers", async () => {
    expect(rasterInfoUrl("d1")).toMatch(/\/collections\/d1\/raster\/info$/);
    expect(rasterInfoUrl("d1", 2)).toMatch(/\/collections\/d1\/raster\/info\?band=2$/);
    let answerSecond: (value: unknown) => void = () => undefined;
    vi.mocked(fetcher).mockImplementation((url: string) =>
      url.endsWith("band=2")
        ? new Promise((resolve) => {
            answerSecond = resolve;
          })
        : Promise.resolve(json([3, 6], 1))
    );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
    const { result, rerender } = renderHook(({ band }) => useRasterInfo("d1", band), {
      initialProps: { band: 1 as number | undefined },
      wrapper,
    });
    await waitFor(() => expect(result.current.info?.stats[0].breaks?.quantile["3"]).toEqual([3, 6]));
    rerender({ band: 2 });
    await waitFor(() => expect(vi.mocked(fetcher).mock.calls.at(-1)?.[0]).toMatch(/info\?band=2$/));
    // The rows that need the info do not wait again for a band switch; the info shown is still the first band's,
    // which has no breaks for the second.
    expect(result.current.info?.bands).toBe(2);
    expect(bandBreaks(result.current.info, 1, "quantile", 3)).toEqual([3, 6]);
    expect(bandBreaks(result.current.info, 2, "quantile", 3)).toBeUndefined();
    await act(async () => answerSecond(json([4, 7], 2)));
    await waitFor(() => expect(bandBreaks(result.current.info, 2, "quantile", 3)).toEqual([4, 7]));
    // The second band's info does not carry the first band's breaks.
    expect(bandBreaks(result.current.info, 1, "quantile", 3)).toBeUndefined();
  });

  it("is asked for a band formula's statistics by its expression, which start its range", async () => {
    const ndvi = "(b2 - b1) / (b2 + b1)";
    expect(rasterInfoUrl("d1", ndvi)).toMatch(
      /\/collections\/d1\/raster\/info\?formula=\(b2%20-%20b1\)%20%2F%20\(b2%20%2B%20b1\)$/
    );
    vi.mocked(fetcher).mockImplementation(async (url: string) => ({
      ...json([3, 6]),
      formula: {
        ...json([])["bands"][0],
        p2: -0.42,
        p98: 0.87,
        expression: decodeURIComponent(url.split("formula=")[1]),
      },
    }));
    expect(await loadFormulaSample("d1", ndvi)).toEqual({ min: -0.42, max: 0.87, values: [], formula: true });
    // Refused (a formula the file cannot compute) or unreadable: none.
    vi.mocked(fetcher).mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400 }));
    expect(await loadFormulaSample("d1", "b9 * 2")).toBeNull();
  });
});

describe("a raster point", () => {
  it("sends a click on a world copy with its longitude between -180 and 180", async () => {
    vi.mocked(apiRequestAuth).mockImplementation(
      async () => new Response(JSON.stringify({ values: [1], styled: null }), { status: 200 })
    );
    const asked = async (lng: number) => {
      vi.mocked(apiRequestAuth).mockClear();
      await fetchRasterPoint("d1", { lng, lat: 48.1 });
      return new URL(String(vi.mocked(apiRequestAuth).mock.calls[0][0]), "http://x").searchParams.get("lon");
    };
    expect(await asked(11.5)).toBe("11.5");
    expect(await asked(371.5)).toBe("11.5");
    expect(await asked(-348.5)).toBe("11.5");
    expect(await asked(180)).toBe("180");
    expect(await asked(-180)).toBe("-180");
    expect(Number(await asked(190))).toBeCloseTo(-170);
  });
});
