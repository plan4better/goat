import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadLayerDirect } from "@/lib/api/layers";

const KIND_IS_A = { op: "=", args: [{ property: "kind" }, "a"] };

describe("the public download", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["z"])) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  const sentParams = () => new URL(String(fetchMock.mock.calls[0][0]), "http://x").searchParams;

  it("sends the layer's filter, so the file holds what the map shows", async () => {
    await downloadLayerDirect("layer-1", "csv", "Layer", undefined, KIND_IS_A);
    expect(JSON.parse(sentParams().get("filter") ?? "null")).toEqual(KIND_IS_A);
  });

  it("sends no filter for a layer without one", async () => {
    await downloadLayerDirect("layer-1", "csv", "Layer", "EPSG:4326", {});
    expect(sentParams().has("filter")).toBe(false);
    expect(sentParams().get("crs")).toBe("EPSG:4326");
  });
});
