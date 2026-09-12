import { useCallback, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { mutate } from "swr";
import { useTranslation } from "react-i18next";

import { useCatalogAggregations, useCatalogDatasetPages } from "@/lib/api/catalog";
import { useFavoriteStars } from "@/lib/api/favorites";
import {
  CATALOG_PAGE_SIZE,
  buildFacetParams,
  buildSearchParams,
  countActiveFilters,
} from "@/lib/catalog/searchQuery";

import { addCatalogLayersToProject, projectLayersKey } from "@/lib/api/projects";
import { DEFAULT_SORT } from "@/lib/catalog/searchQuery";
import type { CatalogSpatialFilter } from "@/lib/catalog/spatial";
import type { CatalogAggregation, CatalogCollection } from "@/lib/validations/catalog";

import type { FlowController } from "@/hooks/addLayer/flow";
import { useShareNotice } from "@/hooks/addLayer/useShareNotice";
import { FACET_HIDDEN } from "@/hooks/catalog/useCatalogFacetSections";

/**
 * Picking datasets from the catalog to add as layers.
 *
 * Filters are held in memory rather than in the URL: this runs inside a modal over
 * a project map, and a picker has no business rewriting that page's address. The
 * query itself comes from `lib/catalog/searchQuery`, the same builder the catalog
 * page uses, so both ask the API the same way.
 */

/**
 * What is selected, always as **layer** ids.
 *
 * A plain dataset contributes its own item; an open bundle contributes its members
 * individually, which is what makes "Add 3 layers" count layers rather than cards —
 * and matches promotion, where members promote one by one into a shared bundle
 * group. A locked bundle would contribute a single id, but nothing publishes one
 * yet (catalog design S11), so that branch has no data to exercise it.
 */
export type CatalogSelection = {
  ids: string[];
  toggle: (id: string) => void;
  /** Replaces the selection for a whole group — the bundle card's own checkbox. */
  setMany: (ids: string[], selected: boolean) => void;
  clear: () => void;
};

export type CatalogFlowState = {
  /**
   * Narrow to saved datasets. A filter, not a mode: it sits with the others in the
   * panel, as it does on the catalog page, and counts towards "Clear (n)".
   */
  favouritesOnly: boolean;
  toggleFavourites: () => void;
  q: string;
  setQ: (value: string) => void;
  spatial: CatalogSpatialFilter | null;
  setSpatial: (filter: CatalogSpatialFilter | null) => void;
  /** Publication period, as the panel's two date inputs hold it: `YYYY-MM-DD`. */
  dateFrom: string | null;
  dateTo: string | null;
  setDates: (range: { from: string | null; to: string | null }) => void;
  aggregations: CatalogAggregation[];
  facetSelections: Record<string, string[]>;
  toggleFacet: (param: string, value: string) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  facetQueryParams: ReturnType<typeof buildFacetParams>;
  datasets: CatalogCollection[];
  total: number;
  isLoading: boolean;
  /** More results exist beyond the ones loaded. */
  hasMore: boolean;
  /** A further page is on its way, under what is already on screen. */
  isLoadingMore: boolean;
  loadMore: () => void;
  /**
   * Changes whenever the query does. The body watches it to send the list back to
   * the top — landing halfway down a freshly filtered list reads as a bug.
   */
  queryKey: string;
  selection: CatalogSelection;
  /** Saved datasets, in memory until core keeps them — as on the catalog page. */
  starred: Record<string, boolean>;
  toggleStar: (id: string) => void;
};

export type CatalogFlow = FlowController & { catalog: CatalogFlowState };

export const useCatalogFlow = ({
  projectId,
  onDone,
  viewport,
}: {
  projectId?: string;
  onDone?: () => void;
  /** The project's map view, ranked first without filtering anything out. */
  viewport?: [number, number, number, number];
}): CatalogFlow => {
  const { t } = useTranslation("common");
  const notice = useShareNotice(projectId);

  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [q, setQValue] = useState("");

  const [spatial, setSpatialValue] = useState<CatalogSpatialFilter | null>(null);
  const [dates, setDatesValue] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });
  const [facetSelections, setFacetSelections] = useState<Record<string, string[]>>({});
  const [ids, setIds] = useState<string[]>([]);
  const { starred, toggleStar } = useFavoriteStars("catalog_item");

  const { aggregations: served } = useCatalogAggregations();
  const aggregations = useMemo(
    () => served.filter((a) => !FACET_HIDDEN.has(a["goat:filter_param"] ?? "")),
    [served]
  );

  const queryState = useMemo(
    () => ({
      q,
      // The server's own order, never sent — sending a sort switches every
      // ranking signal off, the viewport boost included.
      sortby: DEFAULT_SORT,
      // The accumulating fetch owns paging; this state only describes the query.
      page: 1,
      spatial,
      from: dates.from,
      to: dates.to,
      facetSelections,
    }),
    [q, spatial, dates, facetSelections]
  );
  const searchParams = useMemo(
    () => buildSearchParams(queryState, { viewport }),
    [queryState, viewport]
  );
  const facetQueryParams = useMemo(() => buildFacetParams(searchParams), [searchParams]);
  // Favourites filter server-side, like the catalog page: the saved ids join
  // the search, so counts and paging describe the favourites — and nothing
  // starred means nothing to ask for.
  const starredIds = useMemo(() => Object.keys(starred), [starred]);
  const effectiveParams = useMemo(
    () => (favouritesOnly ? { ...searchParams, ids: starredIds } : searchParams),
    [favouritesOnly, searchParams, starredIds]
  );
  const { datasets, total, isLoading, isLoadingMore, hasMore, loadMore, resetPages } =
    useCatalogDatasetPages(effectiveParams, {
      pageSize: CATALOG_PAGE_SIZE,
      enabled: !(favouritesOnly && starredIds.length === 0),
    });

  // Narrowing a filter drops back to the first page: results already accumulated
  // belong to the old query.
  const setQ = useCallback(
    (value: string) => {
      setQValue(value);
      resetPages();
    },
    [resetPages]
  );
  const setSpatial = useCallback(
    (filter: CatalogSpatialFilter | null) => {
      setSpatialValue(filter);
      resetPages();
    },
    [resetPages]
  );
  const setDates = useCallback(
    (range: { from: string | null; to: string | null }) => {
      setDatesValue(range);
      resetPages();
    },
    [resetPages]
  );
  const toggleFavourites = useCallback(() => {
    setFavouritesOnly((on) => !on);
    // The filter changes the query, so accumulated pages belong to the old one.
    resetPages();
  }, [resetPages]);
  const toggleFacet = useCallback((param: string, value: string) => {
    setFacetSelections((current) => {
      const values = current[param] ?? [];
      const next = values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value];
      const { [param]: _dropped, ...rest } = current;
      return next.length ? { ...rest, [param]: next } : rest;
    });
    resetPages();
  }, [resetPages]);
  const clearFilters = useCallback(() => {
    setFavouritesOnly(false);
    setFacetSelections({});
    setSpatialValue(null);
    setDatesValue({ from: null, to: null });
    resetPages();
  }, [resetPages]);

  const selection = useMemo<CatalogSelection>(
    () => ({
      ids,
      toggle: (id) =>
        setIds((current) =>
          current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
        ),
      setMany: (many, selected) =>
        setIds((current) =>
          selected
            ? Array.from(new Set([...current, ...many]))
            : current.filter((value) => !many.includes(value))
        ),
      clear: () => setIds([]),
    }),
    [ids]
  );

  const reset = useCallback(() => {
    setFavouritesOnly(false);
    setQValue("");
    resetPages();
    setSpatialValue(null);
    setDatesValue({ from: null, to: null });
    setFacetSelections({});
    setIds([]);
  }, [resetPages]);

  /**
   * Promote-on-use: the selection holds what the picker cards stand for — a
   * dataset's own Collection id, and a bundle's member *item* ids, which is
   * what listing its layers individually means. Core resolves either kind
   * against the mirror before promoting, so the ids go over verbatim.
   * The response's layers may be `pending`; the layer tree polls them to ready.
   */
  const addSelection = useCallback(() => {
    if (!projectId || ids.length === 0) return;
    const selected = ids;
    // Closed on click, not when the server answers. The request promotes each
    // item, enqueues its materialize job and then refetches every project
    // layer — none of which the user is waiting on: materialization is
    // asynchronous either way, so the layer arrives in the tree as
    // "preparing" whether the dialog is still open or not.
    setIds([]);
    onDone?.();
    void addCatalogLayersToProject(projectId, selected)
      .then(async (added) => {
        await mutate(projectLayersKey(projectId));
        toast.success(
          t("catalog_layers_added", { count: added?.length ?? selected.length })
        );
      })
      .catch((error) => {
        // The dialog is gone, so this is the only place a failure can surface —
        // and a refusal ("120 layers is more than the 100 …") is worth reading.
        console.error(error);
        const detail = error instanceof Error ? error.message : "";
        toast.error(detail || t("error_adding_layer"));
      });
  }, [projectId, ids, t, onDone]);

  const action = useMemo(
    () => ({
      label:
        ids.length > 1 ? t("catalog_add_n_layers", { count: ids.length }) : t("add_layer"),
      disabled: !projectId || ids.length === 0,
      reason: !projectId
        ? t("catalog_add_needs_project")
        : ids.length === 0
          ? t("catalog_select_datasets_first")
          : undefined,
      notice,
      run: addSelection,
    }),
    [ids.length, t, projectId, addSelection, notice]
  );

  return {
    action,
    // Nothing to wait for: the dialog closes on click and the add
    // reports itself by toast, like an upload does.
    isBusy: false,
    reset,
    catalog: {
      favouritesOnly,
      toggleFavourites,
      q,
      setQ,
      spatial,
      setSpatial,
      dateFrom: dates.from,
      dateTo: dates.to,
      setDates,
      aggregations,
      facetSelections,
      toggleFacet,
      clearFilters,
      activeFilterCount: countActiveFilters(queryState) + (favouritesOnly ? 1 : 0),
      facetQueryParams,
      datasets: favouritesOnly && starredIds.length === 0 ? [] : datasets,
      total: favouritesOnly && starredIds.length === 0 ? 0 : (total ?? 0),
      isLoading,
      // Server-side favourites filtering: paging works normally under it.
      hasMore,
      isLoadingMore,
      loadMore,
      queryKey: JSON.stringify(effectiveParams),
      selection,
      starred,
      toggleStar,
    },
  };
};
