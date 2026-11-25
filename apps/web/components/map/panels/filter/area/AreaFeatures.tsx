"use client";

// The lists features are picked from for the area: the administrative regions of the catalog, and the features of
// another polygon layer of the project, as far as its saved filter shows them on the map. Both are one searchable
// check list, the picked features first. A list mounts only when it is opened, so a closed one asks the server for
// nothing.
import { Box, Divider, MenuList, Typography } from "@mui/material";
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCatalogNutsRegions } from "@/lib/api/catalog";
import { useDatasetCollectionItems, useLayerQueryables } from "@/lib/api/layers";
import { type PolygonCoords, featureCount, geometryPolygons, roundPolygons } from "@/lib/filter/area";

import { useCatalogNutsGeometries } from "@/hooks/catalog/useCatalogNutsGeometries";
import { useDebouncedValue } from "@/hooks/dashboard/home/useDebouncedValue";

import { stringColumnsFromQueryables } from "@/components/map/controls/search/editorSearchLayers";
import {
  ListSearch,
  NEAR_END,
  SEARCH_PAUSE,
  VALUES_PAGE,
  ValueRow,
  WILDCARD,
} from "@/components/map/panels/filter/ValuePicker";
import { AreaNoteText } from "@/components/map/panels/filter/area/AreaNote";
import { useAreaTools } from "@/components/map/panels/filter/area/AreaTools";
import {
  REGION_SOURCE,
  featuresPiece,
  withFeature,
  withoutFeature,
} from "@/components/map/panels/filter/area/pieces";

/** A feature as a list shows it. */
interface Listed {
  id: string;
  name: string;
  /** After the name, to tell features of one name apart. */
  code?: string;
}

const NONE: Listed[] = [];
const OPTION = "[role='option']";

/** The check list both sources share. Unticking is the same for both (the feature leaves the area with its
 * polygons); ticking is the source's, as it has the feature's outline or loads it. */
function CheckList({
  source,
  search,
  onSearch,
  searchLabel,
  listed,
  pending = NONE,
  loading,
  emptyText,
  note,
  footer,
  onAdd,
  onDrop,
  onEnd,
}: {
  source: string;
  search: string;
  onSearch: (text: string) => void;
  searchLabel: string;
  /** The features the search found. */
  listed: Listed[];
  /** Ticked, their outlines on the way. */
  pending?: Listed[];
  loading: boolean;
  emptyText: string;
  /** A line under the search. */
  note?: string;
  /** A line under the list. */
  footer?: string;
  onAdd: (feature: Listed) => void;
  /** A ticked feature that is not in the area yet is unticked. */
  onDrop?: (id: string) => void;
  /** The list was scrolled to its end. */
  onEnd?: () => void;
}) {
  const { t } = useTranslation("common");
  const { area, read, setArea, limits, dismissFrom } = useAreaTools();
  const picked = featuresPiece(area, source)?.features;
  // A question about an outline of this list goes with the list.
  useEffect(() => () => dismissFrom(source), [dismissFrom, source]);
  const count = area ? featureCount(area) : 0;
  const full = !!limits && count + pending.length >= limits.features;

  // The features picked when the list opened stay first while they are picked.
  const [first] = useState(() => new Set(picked?.map((feature) => feature.id)));
  const ticked = new Set([...(picked ?? []).map((feature) => feature.id), ...pending.map((p) => p.id)]);
  const listedIds = new Set(listed.map((item) => item.id));
  // At the top: those, and any picked since that the list does not hold, so it can be taken out. A search narrows
  // them too.
  const lower = search.trim().toLocaleLowerCase();
  const top: Listed[] = [];
  for (const feature of [...(picked ?? []), ...pending]) {
    const name = feature.name ?? feature.id;
    if (!first.has(feature.id) && listedIds.has(feature.id)) continue;
    if (lower && !name.toLocaleLowerCase().includes(lower)) continue;
    top.push({ id: feature.id, name });
  }
  const onTop = new Set(top.map((item) => item.id));
  const rest = listed.filter((item) => !onTop.has(item.id));

  // The rows' pick never changes, so a pick renders the row it changed and not the others.
  const latest = useRef({ top, rest, ticked, full, onAdd, onDrop });
  latest.current = { top, rest, ticked, full, onAdd, onDrop };
  const pick = useCallback(
    (value: string | number) => {
      const id = String(value);
      const { top, rest, ticked, full, onAdd, onDrop } = latest.current;
      if (ticked.has(id)) {
        const now = read();
        if (featuresPiece(now, source)?.features.some((feature) => feature.id === id))
          setArea(withoutFeature(now, source, id));
        else onDrop?.(id);
        return;
      }
      const feature = [...top, ...rest].find((item) => item.id === id);
      if (feature && !full) onAdd(feature);
    },
    [read, setArea, source]
  );

  const list = useRef<HTMLUListElement | null>(null);
  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    list.current?.querySelector<HTMLElement>(OPTION)?.focus();
  };
  const row = (item: Listed) => (
    <ValueRow
      key={item.id}
      value={item.id}
      label={item.name}
      count={item.code}
      selected={ticked.has(item.id)}
      disabled={full && !ticked.has(item.id)}
      multiple
      onPick={pick}
    />
  );
  const nothing = !top.length && !rest.length;
  return (
    <Box sx={{ px: 1, pt: 1 }}>
      <ListSearch value={search} onChange={onSearch} label={searchLabel} onKeyDown={onSearchKey} />
      {note && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 2, pb: 1 }}>
          {note}
        </Typography>
      )}
      <MenuList
        ref={list}
        role="listbox"
        aria-label={searchLabel}
        aria-multiselectable
        disablePadding
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_END) onEnd?.();
        }}
        sx={{ maxHeight: 252, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}>
        {top.map(row)}
        {top.length > 0 && rest.length > 0 && <Divider component="li" sx={{ mx: 2, my: 1 }} />}
        {rest.map(row)}
      </MenuList>
      {nothing && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
          {loading ? t("loading") : emptyText}
        </Typography>
      )}
      {footer && !nothing && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 2, pt: 1 }}>
          {footer}
        </Typography>
      )}
      {limits && (
        <Typography
          variant="caption"
          color={full ? "warning.main" : "text.secondary"}
          sx={{ display: "block", px: 2, pt: 1.5 }}>
          {full
            ? t("filter_panel.area_limit_features", { limit: limits.features })
            : t("filter_panel.picked", { count, limit: limits.features })}
        </Typography>
      )}
      <Box sx={{ pt: 1 }}>
        <AreaNoteText from={source} px={2} />
      </Box>
    </Box>
  );
}

/** The regions of the catalog, found by name. A ticked region's outline is loaded, then it joins the area. */
export const RegionFeatures = memo(function RegionFeatures() {
  const { t } = useTranslation("common");
  const { read, limits, add: addOutline } = useAreaTools();
  const [search, setSearch] = useState("");
  const needle = useDebouncedValue(search.trim(), SEARCH_PAUSE);
  const { regions, isLoading } = useCatalogNutsRegions(needle);
  // The search keeps its last answer while the next one loads: under two characters nothing was asked.
  const listed = useMemo<Listed[]>(
    () =>
      needle.length < 2
        ? NONE
        : regions.map((region) => ({ id: region.nuts_id, name: region.nuts_name, code: region.nuts_id })),
    [regions, needle]
  );

  const [pending, setPending] = useState<Listed[]>(NONE);
  const pendingIds = useMemo(() => pending.map((region) => region.id), [pending]);
  const { shapes } = useCatalogNutsGeometries(pendingIds);
  useEffect(() => {
    const loaded = pending.filter((region) => region.id in shapes);
    if (!loaded.length) return;
    for (const region of loaded) {
      // The area as it is now: it can have changed while the outline loaded.
      const now = read();
      if (featuresPiece(now, REGION_SOURCE)?.features.some((feature) => feature.id === region.id)) continue;
      if (limits && now && featureCount(now) >= limits.features) break;
      // A region whose outline did not load is left out.
      const outline = geometryPolygons(shapes[region.id]?.geometry);
      if (!outline?.length) continue;
      addOutline(
        roundPolygons(outline),
        (polygons) =>
          withFeature(
            read(),
            REGION_SOURCE,
            { id: region.id, name: region.name, n: polygons.length },
            polygons
          ),
        REGION_SOURCE
      );
    }
    setPending((list) => list.filter((region) => !loaded.includes(region)));
  }, [pending, shapes, read, limits, addOutline]);

  const add = useCallback((region: Listed) => setPending((list) => [...list, region]), []);
  const drop = useCallback((id: string) => setPending((list) => list.filter((r) => r.id !== id)), []);
  return (
    <CheckList
      source={REGION_SOURCE}
      search={search}
      onSearch={setSearch}
      searchLabel={t("filter_panel.area_search_regions")}
      listed={listed}
      pending={pending}
      loading={isLoading}
      emptyText={needle.length < 2 ? t("catalog_region_hint") : t("filter_panel.area_no_regions")}
      onAdd={add}
      onDrop={drop}
    />
  );
});

/** A feature of the items request, as far as the list reads it. */
interface ItemFeature {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
}

/** A page of the items request, as far as the list reads it. */
interface ItemsPage {
  features: ItemFeature[];
  /** The features its filter finds in all. */
  total: number;
}

/** The features of a polygon layer of the project, named by the layer's likeliest name column: the ones its saved
 * filter keeps (what the map shows of it), a search narrowing them further. As the value list, the list holds a page
 * of them and grows by a page when scrolled to its end; a new search starts at the first again. A feature's outline
 * comes with its row, so a page is no bigger than the value list's. */
export const LayerFeatures = memo(function LayerFeatures({ layerId }: { layerId: string }) {
  const { t } = useTranslation("common");
  const { read, add: addOutline, layers } = useAreaTools();
  const shown = useMemo(() => layers.find((layer) => layer.id === layerId)?.filter, [layers, layerId]);
  const [search, setSearch] = useState("");
  const needle = useDebouncedValue(search.trim(), SEARCH_PAUSE);
  const wildcard = WILDCARD.test(needle);
  const { queryables, isLoading: loadingFields } = useLayerQueryables(layerId);
  const column = useMemo(() => stringColumnsFromQueryables(queryables)[0], [queryables]);
  const query = useMemo(() => {
    const like = column && needle ? { op: "like", args: [{ property: column }, `%${needle}%`] } : undefined;
    const scoped = like && shown ? { op: "and", args: [shown, like] } : (like ?? shown);
    return scoped ? JSON.stringify(scoped) : "";
  }, [column, needle, shown]);
  // The page shown so far, for the search it belongs to: a new search starts at the first again.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const params = useMemo(
    () => ({
      limit: VALUES_PAGE,
      offset: (page - 1) * VALUES_PAGE,
      ...(column && { properties: column }),
      ...(query && { filter: query }),
    }),
    [column, page, query]
  );
  // Asked once the name column is known, so the list is not loaded twice. The answer is the one of these params.
  const { data, isLoading } = useDatasetCollectionItems(loadingFields || wildcard ? "" : layerId, params);
  // The pages loaded, by search and page; the list is the pages of the current search up to the one shown.
  const [pages, setPages] = useState<Record<string, ItemsPage>>({});
  useEffect(() => {
    const answer = data as { features?: ItemFeature[]; numberMatched?: number } | undefined;
    if (!answer?.features) return;
    const key = `${query}|${page}`;
    const features = answer.features;
    setPages((loaded) =>
      loaded[key]?.features === features
        ? loaded
        : { ...loaded, [key]: { features, total: answer.numberMatched ?? 0 } }
    );
  }, [data, query, page]);
  const { listed, outlines, count } = useMemo(() => {
    const listed: Listed[] = [];
    const outlines = new Map<string, unknown>();
    let count = 0;
    for (let i = 1; i <= (wildcard ? 0 : page); i += 1)
      for (const feature of pages[`${query}|${i}`]?.features ?? []) {
        count += 1;
        if (feature.id === undefined || feature.id === null) continue;
        const id = String(feature.id);
        const name = column ? feature.properties?.[column] : undefined;
        listed.push({ id, name: name === undefined || name === null || name === "" ? id : String(name) });
        outlines.set(id, feature.geometry);
      }
    return { listed, outlines, count };
  }, [pages, page, query, column, wildcard]);
  const last = pages[`${query}|${page}`];
  const total = last?.total ?? 0;
  // More after the page shown: fewer listed than found, or a full page where the count was not to be had.
  const hasMore = !wildcard && !!last && (total ? count < total : last.features.length >= VALUES_PAGE);
  const more = useCallback(() => {
    if (hasMore && !isLoading) setPaging({ query, page: page + 1 });
  }, [hasMore, isLoading, query, page]);

  const add = useCallback(
    (feature: Listed) => {
      const outline = geometryPolygons(outlines.get(feature.id));
      if (!outline?.length) return;
      addOutline(
        roundPolygons(outline),
        (polygons: PolygonCoords[]) =>
          withFeature(read(), layerId, { id: feature.id, name: feature.name, n: polygons.length }, polygons),
        layerId
      );
    },
    [outlines, addOutline, read, layerId]
  );
  return (
    <CheckList
      source={layerId}
      search={search}
      onSearch={setSearch}
      searchLabel={t("filter_panel.area_search_features")}
      listed={listed}
      loading={isLoading || loadingFields}
      emptyText={t("filter_panel.area_no_features")}
      note={wildcard ? t("filter_panel.wildcard") : undefined}
      footer={
        hasMore && total > listed.length
          ? t("filter_panel.area_more", { shown: listed.length, total })
          : undefined
      }
      onAdd={add}
      onEnd={more}
    />
  );
});
