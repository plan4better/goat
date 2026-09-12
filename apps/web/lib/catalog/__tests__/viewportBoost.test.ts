import { describe, expect, it } from "vitest";

import { DEFAULT_SORT, buildSearchParams } from "@/lib/catalog/searchQuery";

/**
 * Opening the catalog from a project should surface the datasets around the
 * current map view first — someone working in Munich means Munich data. It is
 * a ranking signal (`bbox_boost`), never a filter: the whole catalog is still
 * returned and the result count does not change.
 */
const state = (extra: Record<string, unknown> = {}) =>
  ({ page: 1, facetSelections: {}, ...extra }) as never;

const MUNICH: [number, number, number, number] = [11.36, 48.06, 11.72, 48.25];

describe("buildSearchParams — viewport", () => {
  it("sends the map view as a ranking boost", () => {
    const params = buildSearchParams(state(), { viewport: MUNICH });

    expect(params.bbox_boost).toBe("11.36,48.06,11.72,48.25");
  });

  it("never sends it as a filter", () => {
    const params = buildSearchParams(state(), { viewport: MUNICH });

    expect(params.bbox).toBeUndefined();
    expect(params.intersects).toBeUndefined();
  });

  it("sends nothing outside a project, where there is no map", () => {
    expect(buildSearchParams(state()).bbox_boost).toBeUndefined();
  });

  it("drops a boost the user's own sort would contradict", () => {
    // The server would honour it anyway — a boost is a caller's explicit
    // request, not one of the signals `sortby` gates — but someone who asked
    // for "Title A-Z" did not ask for the map to reorder it.
    const params = buildSearchParams(state({ sortby: "title" }), { viewport: MUNICH });

    expect(params.bbox_boost).toBeUndefined();
  });

  it("still boosts under the default sort, which nobody chose", () => {
    // The default is the server's own order, so it is never sent: sending any
    // sort switches every ranking signal off. `-updated` is a real choice now.
    const params = buildSearchParams(state({ sortby: DEFAULT_SORT }), { viewport: MUNICH });

    expect(params.bbox_boost).toBe("11.36,48.06,11.72,48.25");
    expect(params.sortby).toBeUndefined();

    const recency = buildSearchParams(state({ sortby: "-updated" }), { viewport: MUNICH });

    expect(recency.sortby).toBe("-updated,id");
    expect(recency.bbox_boost).toBeUndefined();
  });

  it("keeps a real sort choice, with the paging tiebreaker", () => {
    const params = buildSearchParams(state({ sortby: "title" }));

    expect(params.sortby).toBe("title,id");
  });
});
