import { useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";

import { fetcher } from "@/lib/api/fetcher";
import type { CatalogStyle } from "@/lib/catalog/style";
import { CATALOG_BASE_URL } from "@/lib/constants";
import type {
  CatalogAggregations,
  CatalogCollections,
  CatalogItem,
  CatalogItemCollection,
  CatalogNutsRegion,
  CatalogPreview,
  CatalogResolved,
} from "@/lib/validations/catalog";

/**
 * Hooks over the catalog STAC API (apps/catalog).
 *
 * Two things differ from the other API modules here, both deliberate:
 *
 * **The query string is built here, not by `fetcher`.** The shared fetcher
 * accepts `[url, queryParams]` and stringifies with `new URLSearchParams(obj)`,
 * which comma-joins array values. The catalog accepts that form, but it also
 * accepts repeated keys, and the array-aware branch inside `fetcher` is dead
 * code — so relying on the comma behaviour would be relying on a quirk.
 * Passing a finished URL keeps the request shape visible at the call site and
 * makes the SWR cache key the URL itself.
 *
 * **Nothing is a fixed list.** The aggregations to run come from
 * `useCatalogAggregations` (discovery), so a facet added server-side appears
 * without a change here. See `goat:filter_param` in `lib/validations/catalog.ts`
 * for why the name alone is not enough, and `hooks/catalog/useCatalogFacetBuckets`
 * for how the counts are actually fetched.
 */

export const CATALOG_API_BASE_URL = CATALOG_BASE_URL;

/** Item Search caps `limit` at 100 and serves a larger value as the maximum. */
export const CATALOG_MAX_PAGE_SIZE = 100;

export type CatalogSearchParams = Record<string, string | string[] | number | undefined | null>;

/**
 * Encode UI state as a STAC query string.
 *
 * Arrays become repeated keys (`?type=feature&type=table`), which the API reads
 * as OR within a facet. Empty values are dropped rather than sent as blanks, so
 * a cleared filter leaves no trace in the request.
 */
export const buildCatalogQuery = (params: CatalogSearchParams): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      value.filter((v) => v !== "").forEach((v) => search.append(key, String(v)));
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
};

const catalogUrl = (path: string, params?: CatalogSearchParams) =>
  `${CATALOG_API_BASE_URL}${path}${params ? buildCatalogQuery(params) : ""}`;

/**
 * The result list: **Collection Search** (`/stac/collections`), one row per
 * dataset.
 *
 * Not Item Search. A card stands for a dataset, and a dataset *is* a STAC
 * Collection — it carries the title, description, keywords, licence, providers,
 * category and extent the card shows. Item Search returns layers, so the list
 * used to ask for one designated layer per dataset (`grouped=true`) and read
 * dataset identity off it. That cost three things: facet counts came out in layer
 * units (8,166 "bundles" for 1,207 datasets), cards showed a layer's title where
 * it differed from the dataset's, and — worst — the filter was applied to the
 * designated layer, so a dataset whose *other* layer matched was dropped: 1,886
 * datasets contain a polygon layer but only 1,658 were findable.
 *
 * Item-level filters still work here; the API promotes them to a semi-join, which
 * is the only correct reading of "datasets with a polygon layer".
 */
export const useCatalogDatasets = (params: CatalogSearchParams, enabled = true) => {
  const { data, isLoading, error, isValidating, mutate } = useSWR<CatalogCollections>(
    enabled && CATALOG_API_BASE_URL ? catalogUrl("/collections", params) : null,
    fetcher,
    { keepPreviousData: true }
  );
  return {
    datasets: data?.collections ?? [],
    total: data?.numberMatched ?? undefined,
    links: data?.links ?? [],
    isLoading,
    isValidating,
    isError: error,
    mutate,
  };
};

/**
 * The same result list, accumulated page by page — what a picker scrolls through.
 *
 * A page of results is a page either way; the difference is that this keeps the ones
 * already seen. In a picker that matters: with pages, everything ticked on page 1
 * disappears the moment you look at page 2, and the count in the footer is the only
 * evidence it is still selected.
 *
 * `offset` is this hook's business, so callers pass the query without one.
 */
export const useCatalogDatasetPages = (
  params: CatalogSearchParams,
  { pageSize, enabled = true }: { pageSize: number; enabled?: boolean }
) => {
  const { data, size, setSize, isLoading, isValidating, error } = useSWRInfinite<CatalogCollections>(
    (index, previous: CatalogCollections | null) => {
      if (!enabled || !CATALOG_API_BASE_URL) return null;
      // Nothing came back last time, so there is no page after it.
      if (previous && previous.collections.length === 0) return null;
      return catalogUrl("/collections", { ...params, limit: pageSize, offset: index * pageSize });
    },
    fetcher,
    // The first page is not re-fetched on every `setSize`: pages already on screen
    // must not be reordered under a cursor that is picking things.
    { revalidateFirstPage: false, keepPreviousData: true }
  );

  const pages = data ?? [];
  const numberInArea = pages[0]?.numberInArea ?? undefined;
  // By id, because two requests are two moments: a mirror re-synced mid-scroll can
  // shift a dataset across the boundary and hand it back twice; a duplicate in the
  // area moves the "Elsewhere" header up by one.
  const { datasets, inArea } = useMemo(() => {
    const seen = new Set<string>();
    let droppedInArea = 0;
    const kept = (data ?? [])
      .flatMap((page) => page.collections)
      .filter((collection, index) => {
        if (seen.has(collection.id)) {
          if (numberInArea !== undefined && index < numberInArea) droppedInArea += 1;
          return false;
        }
        seen.add(collection.id);
        return true;
      });
    return {
      datasets: kept,
      inArea: numberInArea !== undefined ? numberInArea - droppedInArea : undefined,
    };
  }, [data, numberInArea]);
  const total = pages[0]?.numberMatched ?? undefined;
  // Counted BEFORE dedup: `total` is the server's count, so comparing it to the
  // deduped list would never reach it after one duplicate, and the skeleton
  // row would spin forever under the last result.
  const fetched = pages.reduce((n, page) => n + page.collections.length, 0);
  return {
    datasets,
    total,
    /** How many of `datasets` lead as "In this area", when the server ranked by the map view. */
    inArea,
    /** How many matched datasets lie elsewhere, from the server's counts like `total`. */
    elsewhere: numberInArea !== undefined && total !== undefined ? total - numberInArea : undefined,
    /** Waiting for the first page, with nothing to show yet. */
    isLoading: isLoading && datasets.length === 0,
    /** Waiting for a further page, under results already on screen. */
    isLoadingMore: size > pages.length || (isValidating && pages.length > 0 && size > 1),
    hasMore: total !== undefined ? fetched < total : pages.length === size,
    loadMore: () => setSize((current) => current + 1),
    /** Back to a single page — what a changed filter means. */
    resetPages: () => setSize(1),
    isError: error,
  };
};

/**
 * Cross-collection Item Search — layers, not datasets.
 *
 * Kept for the surfaces that genuinely ask about layers (and for API parity); the
 * result list uses `useCatalogDatasets`.
 */
export const useCatalogSearch = (params: CatalogSearchParams, enabled = true) => {
  const { data, isLoading, error, isValidating, mutate } = useSWR<CatalogItemCollection>(
    enabled && CATALOG_API_BASE_URL ? catalogUrl("/search", params) : null,
    fetcher,
    { keepPreviousData: true }
  );
  return {
    items: data?.features ?? [],
    total: data?.numberMatched ?? undefined,
    links: data?.links ?? [],
    isLoading,
    isValidating,
    isError: error,
    mutate,
  };
};

/**
 * Which aggregations this catalog offers, and the parameter that narrows each.
 *
 * The filter sidebar is built from this rather than from a list in the client,
 * so a facet whose column the harvester dropped simply stops being offered.
 * Derived from the loaded file, so it changes at most once per sync — cached
 * for an hour to keep it off the interaction path.
 */
export const useCatalogAggregations = () => {
  const { data, isLoading, error } = useSWR<CatalogAggregations>(
    CATALOG_API_BASE_URL ? catalogUrl("/aggregations", { unit: "collections" }) : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60 * 60 * 1000 }
  );
  return { aggregations: data?.aggregations ?? [], isLoading, isError: error };
};

/**
 * Resolve a catalog id to whatever it is — a bundle or a single dataset.
 *
 * The detail route receives the id a card carried without knowing which kind it
 * is (grouped cards carry a collection, ungrouped an item). One request settles
 * it and returns the counterpart, so the view never fetches twice or reads a 404
 * as a type test.
 */
export const useCatalogResolve = (entryId?: string) => {
  const { data, isLoading, error } = useSWR<CatalogResolved>(
    entryId && CATALOG_API_BASE_URL ? catalogUrl(`/resolve/${encodeURIComponent(entryId)}`) : null,
    fetcher
  );
  const isCollection = data?.kind === "collection";
  return {
    resolved: data,
    /** The bundle, when this id is a collection. */
    collection: isCollection ? data.collection : undefined,
    /** A bundle's members, when this id is a collection. */
    members: isCollection ? data.items : [],
    /** The dataset, when this id is a single item. */
    item: data?.kind === "item" ? data.item : undefined,
    /** An item's parent, for the breadcrumb. */
    parent: data?.kind === "item" ? (data.collection ?? undefined) : undefined,
    isLoading,
    isError: error,
  };
};

/** One item by id, without needing to know its collection. */
export const useCatalogItem = (itemId?: string) => {
  const { data, isLoading, error } = useSWR<CatalogItem>(
    itemId && CATALOG_API_BASE_URL ? catalogUrl(`/items/${encodeURIComponent(itemId)}`) : null,
    fetcher
  );
  return { item: data, isLoading, isError: error };
};

/** The members of a bundle. */
export const useCatalogCollectionItems = (collectionId?: string, params: CatalogSearchParams = {}) => {
  const { data, isLoading, error } = useSWR<CatalogItemCollection>(
    collectionId && CATALOG_API_BASE_URL
      ? catalogUrl(`/collections/${encodeURIComponent(collectionId)}/items`, params)
      : null,
    fetcher
  );
  return {
    items: data?.features ?? [],
    total: data?.numberMatched ?? undefined,
    isLoading,
    isError: error,
  };
};

/**
 * The live catalog version of each given item, as {item id: version}.
 *
 * Feeds the "update available" badge: a promoted layer carries the version it
 * was promoted at in its snapshot, and a difference against the mirror's
 * current version means the provider has published newer data. Ids that no
 * longer exist in the mirror simply don't appear — absence is not an update.
 */
export const useCatalogItemVersions = (itemIds: string[]) => {
  // The server clamps `limit` to CATALOG_MAX_PAGE_SIZE, so one request per
  // chunk of ids — asking for `limit: itemIds.length` silently lost every
  // layer past the hundredth.
  const key = itemIds.length > 0 && CATALOG_API_BASE_URL ? ["catalog-item-versions", ...itemIds] : null;
  const { data } = useSWR<CatalogItem[]>(key, async () => {
    const features: CatalogItem[] = [];
    for (let i = 0; i < itemIds.length; i += CATALOG_MAX_PAGE_SIZE) {
      const chunk = itemIds.slice(i, i + CATALOG_MAX_PAGE_SIZE);
      const page = (await fetcher(
        catalogUrl("/search", { ids: chunk, limit: CATALOG_MAX_PAGE_SIZE })
      )) as CatalogItemCollection;
      features.push(...(page?.features ?? []));
    }
    return features;
  });
  const versions = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        (data ?? []).map((feature) => [feature.id, String(feature.properties?.version ?? "")])
      ),
    [data]
  );
  return { versions, isLoading: itemIds.length > 0 && data === undefined };
};

/**
 * A dataset's own rendering style, from the asset href the item carries.
 *
 * Takes the href rather than an id: the served item states where its style is
 * (`/assets/{id}/style`), and a client that composed that URL itself would be
 * guessing at a route it was already told. No href means the dataset published
 * no style — 108 of 10,793 layers — which is not an error.
 *
 * Immutable for the life of a mirror generation, like the preview, so it never
 * revalidates and a failure is simply "no style".
 */
export const useCatalogStyle = (href?: string, enabled = true) => {
  const { data, isLoading, error } = useSWR<CatalogStyle>(enabled && href ? href : null, fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });
  return { style: data, isLoading, isError: error };
};

/**
 * A bounded sample of an item's features, for the preview map.
 *
 * Answers 404 unless the deployment configured a catalog bucket, so treat an
 * error as "no preview available" rather than a failure. Immutable for the life
 * of a mirror generation, so it never needs revalidating.
 */
export const useCatalogPreview = (itemId?: string, enabled = true) => {
  const { data, isLoading, error } = useSWR<CatalogPreview>(
    enabled && itemId && CATALOG_API_BASE_URL
      ? catalogUrl(`/items/${encodeURIComponent(itemId)}/preview`)
      : null,
    fetcher,
    { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false }
  );
  return { preview: data, isLoading, isError: error };
};

/** NUTS region typeahead, for the spatial filter. */
export const useCatalogNutsRegions = (query?: string, level?: number) => {
  const { data, isLoading, error } = useSWR<CatalogNutsRegion[]>(
    query && query.length >= 2 && CATALOG_API_BASE_URL
      ? catalogUrl("/nuts", { q: query, level, limit: 10 })
      : null,
    fetcher,
    { keepPreviousData: true }
  );
  return { regions: data ?? [], isLoading, isError: error };
};
