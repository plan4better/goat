import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogItem, CatalogItemProperties } from "@/lib/validations/catalog";

import { useCatalogSample } from "@/hooks/catalog/useCatalogSample";

/**
 * The sample of a dataset's rows is the dataset's own data, which the catalog answers to signed-in users only: the
 * page asks for it with a sign-in, and never for an item that has no rows to sample.
 */

const state = vi.hoisted(() => ({ signedIn: false }));
const useCatalogPreview = vi.hoisted(() => vi.fn(() => ({ preview: undefined, isLoading: false })));

vi.mock("@/hooks/catalog/useCatalogPreviewAccess", () => ({ useCatalogPreviewAccess: () => state.signedIn }));
vi.mock("@/lib/api/catalog", () => ({ useCatalogPreview }));

const item = (properties: Partial<CatalogItemProperties>, links: CatalogItem["links"] = []): CatalogItem => ({
  type: "Feature",
  id: "x",
  properties: { title: "t", "goat:layerType": "feature", ...properties },
  assets: {},
  links,
});

const asked = (it: CatalogItem) => {
  renderHook(() => useCatalogSample(it));
  return useCatalogPreview.mock.calls.at(-1);
};

beforeEach(() => {
  state.signedIn = false;
  useCatalogPreview.mockClear();
});

describe("useCatalogSample", () => {
  it("asks for no sample without a sign-in", () => {
    expect(asked(item({ "goat:geometryType": "polygon" }))).toEqual(["x", false]);
  });

  it("asks for the sample of a dataset with rows when signed in", () => {
    state.signedIn = true;
    expect(asked(item({ "goat:geometryType": "polygon" }))).toEqual(["x", true]);
    expect(asked(item({ "goat:layerType": "table" }))).toEqual(["x", true]);
  });

  it("asks for none of a raster or a map service, which have no rows", () => {
    state.signedIn = true;
    expect(asked(item({ "goat:layerType": "raster" }))).toEqual(["x", false]);
    const wms = item({ "goat:layerType": "wms" }, [{ rel: "wms", href: "https://g/ows", title: "a" }]);
    expect(asked(wms)).toEqual(["x", false]);
  });
});
