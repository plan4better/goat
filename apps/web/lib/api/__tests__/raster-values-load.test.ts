// The descriptions of raster value tiles, cached by address: asked once, refreshed after 10 minutes, asked again
// 30 s after a failure (on their own after a server error or no answer); whoever waits is called back once when the
// answer arrives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VALUES_RETRY_MS,
  VALUES_TIMEOUT_MS,
  VALUES_TTL_MS,
  loadRasterValues,
  loadedRasterValues,
  subscribeRasterValues,
} from "@/lib/api/rasters";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@/lib/api/fetcher", () => ({ apiRequestAuth: requestMock, fetcher: vi.fn() }));

const description = (version: string) => ({
  maxzoom: 14,
  "goat:values": {
    encoding: { redFactor: 65536, greenFactor: 256, blueFactor: 1, baseShift: 1 },
    range: [0, 255],
    integer: true,
    version,
  },
});
const answer = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
/** Each test its own address: the cache lives as long as the module. */
let n = 0;
const address = () => `https://geoapi/collections/r${++n}/coverage/tiles/WebMercatorQuad?band=1`;

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loadRasterValues", () => {
  it("a loaded description is read by its address whatever its version, without asking; readers hear it arrive", async () => {
    requestMock.mockResolvedValue(answer(description("1-e1")));
    const url = `https://geoapi/collections/r${++n}/coverage/tiles/WebMercatorQuad?formula=b1&resampling=bilinear`;
    const heard = vi.fn();
    const stop = subscribeRasterValues(heard);
    expect(loadedRasterValues(url)).toBeUndefined();
    loadRasterValues(`${url}&v=7`, vi.fn());
    // Another formula that starts the same is another address.
    loadRasterValues(url.replace("formula=b1", "formula=b10"), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toHaveBeenCalled();
    expect(loadedRasterValues(url)).toMatchObject({ range: [0, 255] });
    expect(loadedRasterValues(url.replace("formula=b1", "formula=b2"))).toBeUndefined();
    // Reading asks nothing.
    expect(requestMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it("asks once per address and calls back when the answer arrives", async () => {
    requestMock.mockResolvedValue(answer(description("1-e1")));
    const url = address();
    const a = vi.fn();
    const b = vi.fn();
    expect(loadRasterValues(url, a)).toBeUndefined();
    expect(loadRasterValues(url, b)).toBeUndefined();
    expect(loadRasterValues(url, a)).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(url, { signal: expect.anything() });

    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const values = loadRasterValues(url, a);
    expect(values).toMatchObject({ version: "1-e1", range: [0, 255], integer: true, maxzoom: 14 });
    // Loaded: nothing more to wait for, nobody is called again.
    await vi.advanceTimersByTimeAsync(VALUES_TTL_MS - 1);
    expect(loadRasterValues(url, b)).toBe(values);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("asks again 30 s after a failure", async () => {
    requestMock.mockResolvedValueOnce(answer({ detail: "The file cannot be read now." }, 504));
    const url = address();
    const onLoad = vi.fn();
    expect(loadRasterValues(url, onLoad)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    // Failed: not loading any more, so nothing waits for it.
    expect(loadRasterValues(url, onLoad)).toBeNull();

    await vi.advanceTimersByTimeAsync(VALUES_RETRY_MS - 1);
    expect(loadRasterValues(url, onLoad)).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Asked again on its own, the answer still null while it is under way.
    requestMock.mockResolvedValueOnce(answer(description("1-e1")));
    await vi.advanceTimersByTimeAsync(1);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(loadRasterValues(url, onLoad)).toMatchObject({ version: "1-e1" });
  });

  it("a refused description (a bad formula) is not asked again on its own, only by a later call", async () => {
    requestMock.mockResolvedValueOnce(answer({ detail: "Bad formula" }, 422));
    const url = address();
    const onLoad = vi.fn();
    loadRasterValues(url, onLoad);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRasterValues(url, onLoad)).toBeNull();
    await vi.advanceTimersByTimeAsync(VALUES_RETRY_MS * 3);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledTimes(1);

    requestMock.mockResolvedValueOnce(answer({ detail: "Bad formula" }, 400));
    expect(loadRasterValues(url, onLoad)).toBeNull();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("a description that does not come in time is a failure, asked again on its own", async () => {
    // Fake timers do not drive AbortSignal.timeout, so the test holds the signal.
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    requestMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        )
    );
    const url = address();
    const onLoad = vi.fn();
    expect(loadRasterValues(url, onLoad)).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(VALUES_TIMEOUT_MS);
    expect(VALUES_TIMEOUT_MS).toBe(20_000);
    expect(requestMock.mock.calls[0][1].signal).toBe(timer.signal);

    timer.abort(new DOMException("The description timed out.", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(loadRasterValues(url, onLoad)).toBeNull();

    requestMock.mockResolvedValueOnce(answer(description("1-e1")));
    await vi.advanceTimersByTimeAsync(VALUES_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(loadRasterValues(url, onLoad)).toMatchObject({ version: "1-e1" });
  });

  it("loads the colored tiles' description the same way, which the value tiles' readers never find", async () => {
    const tileset = `https://geoapi/collections/r${++n}/raster/tiles`;
    requestMock.mockResolvedValueOnce(
      answer({ maxzoom: 16, bounds: [11.39, 47.25, 11.41, 47.27], "goat:version": "1-0a1b2c3d-e3" })
    );
    const onLoad = vi.fn();
    expect(loadRasterValues(`${tileset}?tilesize=512&v=7`, onLoad)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(loadRasterValues(`${tileset}?tilesize=512&v=7`, onLoad)).toEqual({
      version: "1-0a1b2c3d-e3",
      maxzoom: 16,
      bounds: [11.39, 47.25, 11.41, 47.27],
    });
    expect(loadedRasterValues(`${tileset}?tilesize=512`)).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("a refused request, an unreachable service or an answer that is no description is a failure", async () => {
    const urls = [address(), address(), address()];
    requestMock
      .mockResolvedValueOnce(answer({ detail: "Bad formula" }, 422))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(answer({ title: "not values" }));
    for (const url of urls) loadRasterValues(url, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls.map((url) => loadRasterValues(url, () => undefined))).toEqual([null, null, null]);
  });

  it("refreshes after 10 minutes and keeps the old description meanwhile", async () => {
    requestMock.mockResolvedValueOnce(answer(description("1-e1")));
    const url = address();
    const onLoad = vi.fn();
    loadRasterValues(url, onLoad);
    await vi.advanceTimersByTimeAsync(0);
    const old = loadRasterValues(url, onLoad);

    await vi.advanceTimersByTimeAsync(VALUES_TTL_MS);
    let resolve: (value: unknown) => void = () => undefined;
    requestMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    expect(loadRasterValues(url, onLoad)).toBe(old);
    expect(loadRasterValues(url, onLoad)).toBe(old);
    expect(requestMock).toHaveBeenCalledTimes(2);

    resolve(answer(description("2-e1")));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(loadRasterValues(url, onLoad)).toMatchObject({ version: "2-e1" });

    // A failed refresh keeps the description it had.
    await vi.advanceTimersByTimeAsync(VALUES_TTL_MS);
    requestMock.mockResolvedValueOnce(answer({}, 504));
    const kept = loadRasterValues(url, onLoad);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRasterValues(url, onLoad)).toBe(kept);
    expect(kept).toMatchObject({ version: "2-e1" });
  });
});
