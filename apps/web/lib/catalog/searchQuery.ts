import type { CatalogSearchParams } from "@/lib/api/catalog";
import { type CatalogSpatialFilter, spatialGeometry } from "@/lib/catalog/spatial";

/**
 * Turning a set of catalog filters into a Collection Search request.
 *
 * Pure, because two surfaces need the same query from different state: the catalog
 * page keeps its filters in the URL (shareable), while the Add Layer picker keeps
 * them in memory (a modal must not rewrite the page's address). Only the ownership
 * differs — the request must not.
 */

/** Page size. */
export const CATALOG_PAGE_SIZE = 12;

export type CatalogQueryState = {
  q?: string | null;
  sortby?: string | null;
  page: number;
  from?: string | null;
  to?: string | null;
  spatial: CatalogSpatialFilter | null;
  /** Selected values per facet parameter — `themes`, `license`, … */
  facetSelections: Record<string, string[]>;
};

/** `2020-01-01` + `2024-12-31` -> `2020-01-01T00:00:00Z/2024-12-31T23:59:59Z`. */
const toDatetimeInterval = (
  from?: string | null,
  to?: string | null
): string | undefined => {
  if (!from && !to) return undefined;
  const start = from ? `${from}T00:00:00Z` : "..";
  const end = to ? `${to}T23:59:59Z` : "..";
  return `${start}/${end}`;
};

/** The one option never sent: it names the server's own order, which is what
 * omitting `sortby` asks for. In the menu so the pill matches what happens. */
export const DEFAULT_SORT = "relevance";

export const buildSearchParams = (
  state: CatalogQueryState,
  {
    pageSize = CATALOG_PAGE_SIZE,
    viewport,
  }: {
    pageSize?: number;
    /**
     * The project's current map view, as `[west, south, east, north]`.
     *
     * Sent as `bbox_boost`, which RANKS rather than filters: a dataset drawn
     * around the visible area comes first, one covering it scores lower, one
     * elsewhere scores zero — and the whole catalog is still returned, so the
     * count is unchanged and everything else is a scroll away. Absent outside a
     * project, where there is no map to read.
     */
    viewport?: [number, number, number, number];
  } = {}
): CatalogSearchParams => {
  // A drawn or buffered shape travels as `intersects`; a region as its id, so the
  // boundary geometry never crosses the wire.
  const geometry = spatialGeometry(state.spatial);
  /**
   * The default sort is not a choice anyone made.
   *
   * Sending it told the server the list was explicitly ordered, which switches
   * OFF every ranking signal — spatial relevance and text relevance alike — so
   * a filtered or boosted list came back in the same order as an unfiltered
   * one. The server's own default is this same order (with a stable
   * tiebreaker), so omitting it changes nothing except letting ranking work.
   */
  const explicitSort = state.sortby && state.sortby !== DEFAULT_SORT ? state.sortby : undefined;
  return {
    limit: pageSize,
    offset: (state.page - 1) * pageSize,
    // `id` as the last key, always: `updated` is far from unique — 3,834 datasets
    // share 970 timestamps, one of them 607 times — so ordering by it alone leaves
    // ties in no defined order, and offset paging then returns the same dataset on
    // two different pages.
    sortby: explicitSort ? `${explicitSort},id` : undefined,
    // Not sent when the user picked an order. The server would still honour it
    // — `bbox_boost` is a caller's explicit ranking request, unlike the filter
    // and text relevance it gates behind `sortby` — but someone who asked for
    // "Title A-Z" did not ask for it to be reshuffled by where the map is.
    bbox_boost: viewport && !explicitSort ? viewport.join(",") : undefined,
    q: state.q ?? undefined,
    nuts: state.spatial?.kind === "region" ? state.spatial.nutsIds : undefined,
    intersects: geometry ? JSON.stringify(geometry) : undefined,
    datetime: toDatetimeInterval(state.from, state.to),
    ...state.facetSelections,
  };
};

/**
 * The same predicates without paging or sorting — what facet counts are computed
 * under, so a bucket count matches what selecting it would return.
 *
 * `unit: "collections"` because counts have to be in the same unit as the results:
 * counting layers under a dataset list once reported 8,166 bundles where selecting
 * that bucket returned 1,207.
 */
export const buildFacetParams = (searchParams: CatalogSearchParams): CatalogSearchParams => {
  const { limit: _limit, offset: _offset, sortby: _sortby, ...rest } = searchParams;
  return { ...rest, unit: "collections" };
};

export const countActiveFilters = (state: CatalogQueryState): number =>
  Object.values(state.facetSelections).reduce((n, values) => n + values.length, 0) +
  // Every spatial shape counts as one filter, not one per parameter.
  (state.spatial ? 1 : 0) +
  (state.from || state.to ? 1 : 0);
