"use client";

import { parseAsArrayOf, parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";
import { useCallback, useMemo } from "react";

import type { CatalogSearchParams } from "@/lib/api/catalog";
import {
  CATALOG_PAGE_SIZE,
  DEFAULT_SORT,
  buildFacetParams,
  buildSearchParams,
  countActiveFilters,
} from "@/lib/catalog/searchQuery";
import { type CatalogSpatialFilter, decodeSpatial, encodeSpatial } from "@/lib/catalog/spatial";
import type { CatalogAggregation } from "@/lib/validations/catalog";

/**
 * URL-owned state of the catalog page. The query itself is built by
 * `lib/catalog/searchQuery`, which the Add Layer picker shares with local state.
 */

export { CATALOG_PAGE_SIZE };

export type CatalogView = "list" | "grid";

/** The Catalog page's own top-level tab — datasets or the Templates shelf
 * (T4). Kept in the URL like every other filter so `/catalog?tab=templates`
 * (the Home band's link target) survives a reload. */
export type CatalogTab = "datasets" | "templates";

/** Non-facet URL parameters. */
const baseParsers = {
  q: parseAsString,
  sortby: parseAsString.withDefault(DEFAULT_SORT),
  tab: parseAsStringEnum<CatalogTab>(["datasets", "templates"]).withDefault("datasets"),
  /** A NUTS region id — filtered server-side by that region's geometry. */
  nuts: parseAsString,
  /** `lng,lat,km`: a buffered point. See `lib/catalog/spatial`. */
  pt: parseAsString,
  /** `lng lat;lng lat;…`: a drawn area. */
  poly: parseAsString,
  from: parseAsString,
  to: parseAsString,
  page: parseAsInteger.withDefault(1),
  view: parseAsString.withDefault("list"),
};

export type UseCatalogSearchStateOptions = {
  /** Discovery result; supplies the facet parameter names. */
  aggregations: CatalogAggregation[];
};

export const useCatalogSearchState = ({ aggregations }: UseCatalogSearchStateOptions) => {
  /**
   * Every facet's parameter, in the order the server offers them. `total_count`
   * is not a facet and carries no parameter.
   */
  const facetParams = useMemo(
    () => aggregations.map((a) => a["goat:filter_param"]).filter((param): param is string => Boolean(param)),
    [aggregations]
  );

  const parsers = useMemo(
    () => ({
      ...baseParsers,
      ...Object.fromEntries(facetParams.map((param) => [param, parseAsArrayOf(parseAsString)])),
    }),
    [facetParams]
  );

  const [state, setState] = useQueryStates(parsers);

  /** Selected values per facet parameter, for rendering checked state. */
  const facetSelections = useMemo(() => {
    const selections: Record<string, string[]> = {};
    for (const param of facetParams) {
      const value = state[param];
      if (Array.isArray(value) && value.length) selections[param] = value as string[];
    }
    return selections;
  }, [facetParams, state]);

  /** The one spatial filter in force, whichever shape it takes. */
  const spatial = useMemo(
    () => decodeSpatial({ nuts: state.nuts, pt: state.pt, poly: state.poly }),
    [state.nuts, state.pt, state.poly]
  );

  const activeFilterCount = useMemo(
    () =>
      countActiveFilters({
        page: state.page,
        spatial,
        from: state.from,
        to: state.to,
        facetSelections,
      }),
    [facetSelections, spatial, state.from, state.to, state.page]
  );

  /** Toggling a value always returns to page 1: page 7 of a new result set is meaningless. */
  const toggleFacet = useCallback(
    (param: string, value: string) => {
      const current = (state[param] as string[] | null) ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      setState({ [param]: next.length ? next : null, page: 1 });
    },
    [state, setState]
  );

  const setQ = useCallback((value: string) => setState({ q: value || null, page: 1 }), [setState]);
  const setSort = useCallback((value: string) => setState({ sortby: value, page: 1 }), [setState]);
  /** The dataset grid's own paging/filters stay put underneath — switching
   * tabs shouldn't reset a search the user may switch right back to. */
  const setTab = useCallback((tab: CatalogTab) => setState({ tab }), [setState]);
  const setPage = useCallback((page: number) => setState({ page }), [setState]);
  const setView = useCallback((view: CatalogView) => setState({ view }), [setState]);
  const setDateRange = useCallback(
    (from: string | null, to: string | null) => setState({ from, to, page: 1 }),
    [setState]
  );
  /**
   * Replace the spatial filter. The shapes are mutually exclusive — one place at
   * a time — so this always writes all three parameters and `null` clears.
   */
  const setSpatial = useCallback(
    (filter: CatalogSpatialFilter | null) => setState({ ...encodeSpatial(filter), page: 1 }),
    [setState]
  );

  const clearAll = useCallback(() => {
    setState({
      ...Object.fromEntries(facetParams.map((param) => [param, null])),
      ...encodeSpatial(null),
      from: null,
      to: null,
      page: 1,
    });
  }, [facetParams, setState]);

  /** The request, for Collection Search — one row per dataset. */
  const searchParams = useMemo<CatalogSearchParams>(
    () =>
      buildSearchParams({
        q: state.q,
        sortby: state.sortby,
        page: state.page,
        from: state.from,
        to: state.to,
        spatial,
        facetSelections,
      }),
    [state.page, state.sortby, state.q, spatial, state.from, state.to, facetSelections]
  );

  const facetQueryParams = useMemo<CatalogSearchParams>(() => buildFacetParams(searchParams), [searchParams]);

  return {
    state,
    view: (state.view === "grid" ? "grid" : "list") as CatalogView,
    page: state.page,
    tab: state.tab,
    /** The spatial filter in force, decoded from the URL. */
    spatial,
    facetParams,
    facetSelections,
    activeFilterCount,
    searchParams,
    facetQueryParams,
    setQ,
    setSort,
    setPage,
    setView,
    setDateRange,
    setSpatial,
    setTab,
    toggleFacet,
    clearAll,
  };
};
