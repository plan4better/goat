import bboxPolygon from "@turf/bbox-polygon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { refreshContentFeed, useSpaces } from "@/lib/api/content";
import { getWritableDestinations, useFolders } from "@/lib/api/folders";
import { executeProcessAsync, getMirrorColumns, getMirrorSize, useJobs } from "@/lib/api/processes";
import { useProject } from "@/lib/api/projects";
import { useUserProfile } from "@/lib/api/users";
import { type CatalogSpatialFilter, formatBuffer, spatialGeometry } from "@/lib/catalog/spatial";
import { addRunningJobIds } from "@/lib/store/jobs/slice";
import type { GetContentQueryParams } from "@/lib/validations/common";
import type { Space } from "@/lib/validations/content";
import type { Folder } from "@/lib/validations/folder";
import type { DatasetConnection } from "@/lib/workflows/datasetConnection";

import type { FlowController, WorkflowUse } from "@/hooks/addLayer/flow";
import { useShareNotice } from "@/hooks/addLayer/useShareNotice";
import { useCatalogNutsGeometries } from "@/hooks/catalog/useCatalogNutsGeometries";
import { useAppDispatch } from "@/hooks/store/ContextHooks";

export type FetchSource = "osm" | "overture" | "street_network" | "pt_network";

/** GOAT's own networks, each cut whole to an area as a bundle by its own tool. */
export const NETWORK_TOOLS: Partial<Record<FetchSource, string>> = {
  street_network: "fetch_street_network",
  pt_network: "fetch_pt_network",
};

export const isNetworkSource = (source: FetchSource) => source in NETWORK_TOOLS;
export type AreaMode = "view" | "region" | "point" | "polygon";
export type FilterMode = "builder" | "sql";
export type MatchMode = "all" | "any";
export type Bbox = [number, number, number, number];
/**
 * What a filter asks of its key: one of the values, none of them (features without the key
 * included), the key at all, or its absence.
 */
export type FilterOperator = "is" | "is_not" | "is_set" | "is_not_set";

export type TagFilter = { id: number; key: string; values: string[]; operator?: FilterOperator };

/**
 * A filter's operator as it applies, as the tool reads it: without values "is" is "is set"
 * and "is not" is "is not set"; a filter saved before operators existed is "is".
 */
export const operatorOf = (filter: Pick<TagFilter, "values" | "operator">): FilterOperator => {
  const operator = filter.operator ?? "is";
  if (operator === "is" && !filter.values.length) return "is_set";
  if (operator === "is_not" && !filter.values.length) return "is_not_set";
  return operator;
};

/** A filter as the tool takes it. */
const filterParam = (filter: TagFilter) => ({
  key: filter.key.trim(),
  values: filter.values,
  operator: operatorOf(filter),
});

export const OSM_TYPES = ["points", "lines", "multipolygons"] as const;

/** The tool's own cap: a fetch over it stops, so the form refuses one far above it. */
export const MAX_FEATURES = 1_000_000;

export type Geometry = "point" | "line" | "polygon";

/**
 * Overture's themes as Overture names them, with the tool's type for each geometry a theme
 * holds. A layer has one geometry, so a mixed theme asks which one.
 */
export const OVERTURE_THEMES: { id: string; types: Partial<Record<Geometry, string>> }[] = [
  { id: "places", types: { point: "places" } },
  { id: "buildings", types: { polygon: "buildings" } },
  { id: "divisions", types: { polygon: "divisions" } },
  { id: "land_use", types: { polygon: "land_use", line: "land_use_lines" } },
  { id: "land", types: { polygon: "land", line: "land_lines", point: "land_points" } },
  {
    id: "water",
    types: { polygon: "water_areas", line: "waterways", point: "water_points" },
  },
  {
    id: "infrastructure",
    types: {
      polygon: "infrastructure_areas",
      line: "infrastructure_lines",
      point: "infrastructure_points",
    },
  },
];

/**
 * Overture's filter fields as a SQL condition reads them: the nested ones are struct fields,
 * which the condition check accepts as `parent['child']` only. The plain ones are columns.
 */
const OVERTURE_SQL_COLUMNS: Record<string, string> = {
  category: "taxonomy['primary']",
  brand: "brand['names']['primary']",
};

/** An attribute as a SQL condition names it: an OSM tag, or the Overture column holding it. */
export const sqlColumn = (source: FetchSource, key: string) =>
  source === "osm" ? `tags['${key.replace(/'/g, "''")}']` : (OVERTURE_SQL_COLUMNS[key] ?? key);

/** What the dialog's own map opens on when no project map is behind it: central Europe. */
const DEFAULT_VIEW_BOX: Bbox = [5, 46, 16, 55];

/**
 * A view's bounds widened to the next 0.01°, so a fit, a resize or a nudge of the map does
 * not count as a new area and restart every question asked about it.
 */
export const roundBox = ([w, s, e, n]: Bbox): Bbox => [
  Math.floor(w * 100) / 100,
  Math.floor(s * 100) / 100,
  Math.ceil(e * 100) / 100,
  Math.ceil(n * 100) / 100,
];

/** Several region outlines become one multipolygon: the tool reads one area. */
const mergePolygons = (geometries: (GeoJSON.Geometry | undefined)[]): GeoJSON.MultiPolygon | undefined => {
  const coordinates: GeoJSON.Position[][][] = [];
  for (const geometry of geometries) {
    if (geometry?.type === "Polygon") coordinates.push(geometry.coordinates);
    if (geometry?.type === "MultiPolygon") coordinates.push(...geometry.coordinates);
  }
  return coordinates.length ? { type: "MultiPolygon", coordinates } : undefined;
};

type FetchParams = {
  source: FetchSource;
  feature_type: string;
  overture_type: string;
  area: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  where?: string;
  match_mode?: MatchMode;
  tag_filters?: { key: string; values: string[]; operator?: FilterOperator }[];
};

/**
 * A saved connection's choices, to reopen on. The area comes back as it was chosen; a
 * connection saved without that keeps its geometry as it is.
 */
const seedFrom = (initial: DatasetConnection | undefined) => {
  if (initial?.processId !== "fetch_data") return undefined;
  const params = initial.params as Partial<FetchParams>;
  if (!params.source || !params.area) return undefined;
  const filters = (params.tag_filters ?? []).map((filter, index) => ({ id: index + 1, ...filter }));
  const choice = initial.areaChoice;
  if (choice) {
    // No map behind a workflow: a saved map view stays the box it was.
    const spatial: CatalogSpatialFilter =
      choice.kind === "view"
        ? {
            kind: "polygon",
            ring: [
              [choice.bbox[0], choice.bbox[1]],
              [choice.bbox[2], choice.bbox[1]],
              [choice.bbox[2], choice.bbox[3]],
              [choice.bbox[0], choice.bbox[3]],
            ],
          }
        : choice;
    // Saved again unchanged, it is recorded as the map view it was.
    return { params, filters, spatial, view: choice.kind === "view" ? choice : undefined };
  }
  return { params, filters, kept: { area: params.area } };
};

export type FetchFlowState = {
  areaMode: AreaMode;
  setAreaMode: (mode: AreaMode) => void;
  viewBox?: Bbox;
  /** `moved`: a person moved the map, which is what makes the view an area they chose. */
  setViewBox: (bbox: Bbox, moved?: boolean) => void;
  spatial: CatalogSpatialFilter | null;
  setSpatial: (filter: CatalogSpatialFilter | null) => void;
  regionNames: Record<string, string>;
  area?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  /** What the chosen area is called, e.g. the regions' names; absent until one is chosen. */
  areaLabel?: string;
  source: FetchSource;
  setSource: (source: FetchSource) => void;
  /** The area holds far more than a fetch takes, and no filter with values narrows it. */
  tooBig: boolean;
  /** The area holds more than a fetch reads in reasonable time, filters or not. */
  tooLarge: boolean;
  /** The size check for the current area, source and type has not answered yet. */
  sizePending: boolean;
  /**
   * The one size state the area box, the estimate and the button all follow: unknown until the
   * first answer since opening, then ok or too big. A pending check keeps the last state.
   */
  sizeState: "unknown" | "ok" | "too_big";
  /** Features in the area as last counted; absent while unknown. */
  estimate?: number;
  /** The fetch's filter inputs as they stand, for a sample of what it would write. */
  sampleFilters: Pick<FetchParams, "where" | "match_mode" | "tag_filters">;
  /** A quick pick is on while every one of its values is in a filter on its key. */
  isQuickPickOn: (key: string, values: string[]) => boolean;
  toggleQuickPick: (key: string, values: string[]) => void;
  osmType: string;
  setOsmType: (type: string) => void;
  overtureType: string;
  setOvertureType: (type: string) => void;
  featureType: string;
  filterMode: FilterMode;
  setFilterMode: (mode: FilterMode) => void;
  match: MatchMode;
  setMatch: (mode: MatchMode) => void;
  filters: TagFilter[];
  /** Adds a filter, on `key` when given; returns its id, so a picker can go on editing it. */
  addFilter: (key?: string) => number;
  updateFilter: (id: number, change: Partial<Omit<TagFilter, "id">>) => void;
  removeFilter: (id: number) => void;
  sql: string;
  setSql: (value: string) => void;
  /** Switches to the SQL condition, written from the filters as they stand. */
  startSql: () => void;
  /** The condition was changed since it was written from the filters (or came saved as SQL). */
  sqlEdited: boolean;
  name: string;
  setName: (value: string) => void;
  folders?: Folder[];
  spaces: Space[];
  selectedFolder?: Folder | null;
  setSelectedFolder: (folder: Folder | null) => void;
  /** Saving to a workflow node: there is no layer to name or file. */
  inWorkflow: boolean;
};

export type FetchFlow = FlowController & { fetch: FetchFlowState };

export const useFetchFlow = ({
  projectId,
  defaultFolderId,
  viewport,
  initialSource = "osm",
  workflow,
  onDone,
}: {
  projectId?: string;
  defaultFolderId?: string;
  /** The map's bounds when the dialog opened; absent where there is no map. */
  viewport?: Bbox;
  /** The source picked in Connect service. */
  initialSource?: FetchSource;
  /** Hands the choice to a workflow node instead of fetching it into a layer. */
  workflow?: WorkflowUse;
  onDone?: () => void;
}): FetchFlow => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const { userProfile } = useUserProfile();
  const { mutate: mutateJobs } = useJobs({ read: false });
  const { project } = useProject(projectId);
  const notice = useShareNotice(projectId);
  const queryParams: GetContentQueryParams = { order: "descendent", order_by: "updated_at" };
  const { folders: allFolders } = useFolders(queryParams);
  const { spaces } = useSpaces();
  const folders = getWritableDestinations(allFolders, spaces);

  const [seed] = useState(() => seedFrom(workflow?.initial));
  /** A saved area with no record of how it was chosen: used as it is until another is chosen. */
  const [kept, setKept] = useState(seed?.kept);
  const [areaMode, setAreaMode] = useState<AreaMode>(seed?.spatial?.kind ?? (kept ? "polygon" : "view"));
  const [viewBox, setViewBox] = useState<Bbox | undefined>(roundBox(viewport ?? DEFAULT_VIEW_BOX));
  // Without a project map the view is only a starting point until someone moves it.
  const [viewChosen, setViewChosen] = useState(!!viewport || !!seed);
  const [spatial, setSpatial] = useState<CatalogSpatialFilter | null>(seed?.spatial ?? null);
  const [source, setSource] = useState<FetchSource>(initialSource);
  const [osmType, setOsmType] = useState(seed?.params.feature_type ?? "points");
  const [overtureType, setOvertureType] = useState(seed?.params.overture_type ?? "places");
  const [filterMode, setFilterMode] = useState<FilterMode>(seed?.params.where ? "sql" : "builder");
  const [match, setMatch] = useState<MatchMode>(seed?.params.match_mode ?? "all");
  const [filtersBySource, setFiltersBySource] = useState<Record<FetchSource, TagFilter[]>>(() => ({
    osm: [],
    overture: [],
    street_network: [],
    pt_network: [],
    ...(seed ? { [seed.params.source as FetchSource]: seed.filters } : {}),
  }));
  const [sql, setSql] = useState(seed?.params.where ?? "");
  // What the condition was when it was written from the filters; null for one saved as SQL.
  const [writtenSql, setWrittenSql] = useState<string | null>(null);
  const [customName, setCustomName] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>();
  const [isBusy, setIsBusy] = useState(false);
  const nextId = useRef((seed?.filters.length ?? 0) + 1);
  const folderInitialized = useRef(false);

  useEffect(() => {
    if (!folders.length || folderInitialized.current) return;
    const initial =
      folders.find((folder) => folder.id === project?.folder_id) ??
      folders.find((folder) => folder.id === defaultFolderId);
    if (initial) {
      setSelectedFolder(initial);
      folderInitialized.current = true;
    }
  }, [folders, project?.folder_id, defaultFolderId]);

  const nutsIds = spatial?.kind === "region" ? spatial.nutsIds : [];
  const { geometries, names } = useCatalogNutsGeometries(nutsIds);
  const regionNames = useMemo(
    () => ({ ...names, ...(spatial?.kind === "region" ? spatial.names : {}) }),
    [names, spatial]
  );

  // The last complete area, which stays in force while a new polygon is still being drawn.
  const heldArea = useRef<GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined>(undefined);
  const area = useMemo(() => {
    const keep = (next: GeoJSON.Polygon | GeoJSON.MultiPolygon | undefined) => {
      if (next) heldArea.current = next;
      return next;
    };
    if (kept) return keep(kept.area);
    if (areaMode === "view") return keep(viewBox && viewChosen ? bboxPolygon(viewBox).geometry : undefined);
    if (!spatial || spatial.kind !== areaMode) return undefined;
    if (spatial.kind === "region") {
      // Every picked region or none: one still loading, or failed, would be left out unseen.
      const outlines = spatial.nutsIds.map((id) => geometries[id]);
      return keep(outlines.every(Boolean) ? mergePolygons(outlines) : undefined);
    }
    if (spatial.kind === "polygon" && spatial.ring.length < 3) return heldArea.current;
    return keep(spatialGeometry(spatial));
  }, [areaMode, viewBox, viewChosen, spatial, geometries, kept]);

  const areaLabel = kept
    ? t("catalog_mode_polygon")
    : areaMode === "view"
      ? t("fetch_features_area_view")
      : spatial?.kind !== areaMode
        ? undefined
        : spatial.kind === "region"
          ? spatial.nutsIds.map((id) => regionNames[id] ?? id).join(", ")
          : spatial.kind === "point"
            ? `${spatial.label ?? t("catalog_spatial_point")} · ${formatBuffer(spatial.km)}`
            : t("catalog_spatial_area", { count: spatial.ring.length });

  // A network is cut whole: no layer type, no filters.
  const isNetwork = isNetworkSource(source);
  const featureType = source === "osm" ? osmType : isNetwork ? "" : overtureType;
  const filters = filtersBySource[source];
  const setFilters = useCallback(
    (update: (current: TagFilter[]) => TagFilter[]) =>
      setFiltersBySource((all) => ({ ...all, [source]: update(all[source]) })),
    [source]
  );

  const addFilter = useCallback(
    (key = "") => {
      const id = nextId.current++;
      setFilters((current) => [...current, { id, key, values: [] }]);
      return id;
    },
    [setFilters]
  );
  const updateFilter = useCallback(
    (id: number, change: Partial<Omit<TagFilter, "id">>) =>
      setFilters((current) => current.map((f) => (f.id === id ? { ...f, ...change } : f))),
    [setFilters]
  );
  const removeFilter = useCallback(
    (id: number) => setFilters((current) => current.filter((f) => f.id !== id)),
    [setFilters]
  );
  const isQuickPickOn = useCallback(
    (key: string, values: string[]) =>
      filters.some(
        (f) =>
          f.key.trim() === key && operatorOf(f) === "is" && values.every((value) => f.values.includes(value))
      ),
    [filters]
  );
  // On: its values join the filter on its key (made when missing). Off: they leave it, and a
  // filter left with no values goes too, as one never set would.
  const toggleQuickPick = useCallback(
    (key: string, values: string[]) =>
      setFilters((current) => {
        const existing = current.find((f) => f.key.trim() === key);
        if (existing && values.every((value) => existing.values.includes(value))) {
          const rest = existing.values.filter((value) => !values.includes(value));
          return rest.length
            ? current.map((f) => (f === existing ? { ...f, values: rest } : f))
            : current.filter((f) => f !== existing);
        }
        if (existing)
          return current.map((f) =>
            f === existing
              ? {
                  ...f,
                  // A pick asks for these values, so a filter that excluded values turns into one that asks.
                  operator: "is" as const,
                  values: [
                    ...(operatorOf(f) === "is" ? f.values : []),
                    ...values.filter((v) => operatorOf(f) !== "is" || !f.values.includes(v)),
                  ],
                }
              : f
          );
        // A blank row someone added but never filled takes the pick rather than staying empty.
        const blank = current.find((f) => !f.key.trim());
        if (blank) return current.map((f) => (f === blank ? { ...f, key, values } : f));
        return [...current, { id: nextId.current++, key, values }];
      }),
    [setFilters]
  );

  const suggestedName = isNetwork
    ? t(`fetch_features_source_${source}`)
    : `${t(`fetch_features_source_short_${source}`)} ${t(`fetch_features_type_${featureType}`)}`;
  const name = customName ?? suggestedName;

  const reset = useCallback(() => {
    setAreaMode("view");
    setViewBox(roundBox(viewport ?? DEFAULT_VIEW_BOX));
    setViewChosen(!!viewport);
    heldArea.current = undefined;
    setSpatial(null);
    setKept(undefined);
    setFiltersBySource({ osm: [], overture: [], street_network: [], pt_network: [] });
    setSql("");
    setCustomName(null);
    setIsBusy(false);
    setSelectedFolder(undefined);
    folderInitialized.current = false;
  }, [viewport]);

  const usedFilters = useMemo(() => filters.filter((f) => f.key.trim()), [filters]);
  const sqlMissing = !isNetwork && filterMode === "sql" && !sql.trim();
  // Kept with the area, source and layer it was counted for: another one has none yet.
  const sizedFor = useMemo(() => JSON.stringify([area, source, featureType]), [area, source, featureType]);
  // Only the size check sets the estimate: the key and value lists read capped samples. Its last
  // answer stays, whichever area it was for, until the next one arrives: moving between two
  // large areas then changes nothing on screen, and the button keeps its state meanwhile.
  const [sized, setSized] = useState<{ for: string; estimate?: number; tooLarge: boolean }>();
  const estimate = sized?.estimate;
  // Asked on its own so the size is known before any list; nothing is added until then.
  const [sizeFailedFor, setSizeFailedFor] = useState<string>();
  useEffect(() => {
    const [askedArea, askedSource, askedType] = JSON.parse(sizedFor);
    if (!askedArea) return;
    // The map view changes on every pan; wait until it rests before asking.
    // An answer for an area left behind is dropped, so it cannot replace the current one.
    let current = true;
    const timer = setTimeout(() => {
      getMirrorSize(askedArea, askedType, askedSource)
        .then(({ estimate: n, tooLarge: large }) => {
          if (!current) return;
          setSized({ for: sizedFor, estimate: n, tooLarge: large });
        })
        // The tool checks the size itself, so a failed check does not block.
        .catch(() => current && setSizeFailedFor(sizedFor));
      // Long enough that a pan or a zoom in several steps is asked about once, where it rests.
    }, 800);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [sizedFor]);
  const sizePending = !!area && sized?.for !== sizedFor && sizeFailedFor !== sizedFor;
  // Nothing known yet: the very first size of this dialog is still on its way.
  const firstSizePending = sizePending && !sized;
  // Only values narrow: a tag alone (highway) over a large area still passes the
  // cap. With "any", one tag without values keeps the result that broad. A SQL
  // condition is taken as narrowing: only the fetch can tell.
  // Only "is" with values keeps a list short; "is not" keeps nearly everything.
  const withValues = usedFilters.filter((f) => operatorOf(f) === "is");
  const narrowed =
    filterMode === "sql"
      ? !!sql.trim()
      : withValues.length > 0 && (match === "all" || withValues.length === usedFilters.length);
  // Decided by the size check, which knows both limits: features and geometry.
  const tooLarge = !!area && !!sized?.tooLarge;
  const tooBig = tooLarge || (!narrowed && (estimate ?? 0) > MAX_FEATURES);
  const sizeState = !sized ? "unknown" : tooBig ? "too_big" : "ok";

  const sampleFilters = useMemo(
    () =>
      filterMode === "sql"
        ? { where: sql.trim() || undefined }
        : {
            match_mode: match,
            tag_filters: usedFilters.map(filterParam),
          },
    [filterMode, sql, match, usedFilters]
  );

  /** The filters as a condition, for someone who switches to SQL after building some. */
  const filtersAsSql = () => {
    const listed = (values: string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
    const conditions = usedFilters.map((filter) => {
      const col = sqlColumn(source, filter.key.trim());
      switch (operatorOf(filter)) {
        case "is":
          return `${col} IN (${listed(filter.values)})`;
        case "is_not":
          // A feature without the key has none of the values, so it is kept, as the tool keeps it.
          return `(${col} IS NULL OR ${col} NOT IN (${listed(filter.values)}))`;
        case "is_not_set":
          return `${col} IS NULL`;
        default:
          return `${col} IS NOT NULL`;
      }
    });
    return conditions.join(match === "all" ? " AND " : " OR ");
  };

  /** The fetch's own inputs: a workflow node keeps exactly these and adds the rest per run. */
  const fetchParams = useCallback(
    (fetchArea: FetchParams["area"]): FetchParams => ({
      source,
      feature_type: osmType,
      overture_type: overtureType,
      area: fetchArea,
      ...(filterMode === "sql"
        ? { where: sql.trim() }
        : {
            match_mode: match,
            tag_filters: usedFilters.map(filterParam),
          }),
    }),
    [source, osmType, overtureType, filterMode, sql, match, usedFilters]
  );

  const submit = useCallback(async () => {
    if (!area || !selectedFolder || !name.trim() || sqlMissing || tooBig || firstSizePending) return;
    try {
      setIsBusy(true);
      const job = isNetwork
        ? await executeProcessAsync(NETWORK_TOOLS[source] as string, {
            user_id: userProfile?.id,
            project_id: projectId,
            folder_id: selectedFolder.id,
            result_bundle_name: name.trim(),
            area,
          })
        : await executeProcessAsync("fetch_data", {
            user_id: userProfile?.id,
            project_id: projectId,
            folder_id: selectedFolder.id,
            result_layer_name: name.trim(),
            ...fetchParams(area),
          });
      if (job?.jobID) {
        mutateJobs();
        dispatch(addRunningJobIds([job.jobID]));
      }
      toast.info(t("fetch_features_started", { name: name.trim() }));
      refreshContentFeed();
      reset();
      onDone?.();
    } catch (error) {
      console.error("fetch features failed", error);
      toast.error(t("error_running_tool"));
      setIsBusy(false);
    }
  }, [
    area,
    source,
    selectedFolder,
    name,
    sqlMissing,
    tooBig,
    firstSizePending,
    isNetwork,
    userProfile?.id,
    projectId,
    fetchParams,
    mutateJobs,
    dispatch,
    t,
    reset,
    onDone,
  ]);

  // The columns are asked for at save time: the node needs them before its first run.
  const use = useCallback(async () => {
    if (!workflow || !area || sqlMissing || tooBig || firstSizePending) return;
    try {
      setIsBusy(true);
      const { columns, geometryType } = await getMirrorColumns(area, featureType, source);
      const areaChoice = kept
        ? undefined
        : areaMode === "view"
          ? viewBox && { kind: "view" as const, bbox: viewBox }
          : seed?.view && spatial === seed.spatial
            ? seed.view
            : (spatial ?? undefined);
      workflow.onUse({
        processId: "fetch_data",
        params: fetchParams(area),
        // The node is named as Add layer would name the layer.
        summary: suggestedName,
        geometryType,
        fields: columns,
        ...(areaChoice ? { areaChoice } : {}),
      });
      reset();
      onDone?.();
    } catch (error) {
      console.error("mirror columns failed", error);
      toast.error(t("error_running_tool"));
      setIsBusy(false);
    }
  }, [
    workflow,
    area,
    sqlMissing,
    tooBig,
    firstSizePending,
    featureType,
    source,
    t,
    suggestedName,
    kept,
    areaMode,
    viewBox,
    spatial,
    seed,
    fetchParams,
    reset,
    onDone,
  ]);

  const reason = !area
    ? t("fetch_features_area_needed")
    : firstSizePending
      ? t("fetch_features_checking_area")
      : tooLarge
        ? t(isNetwork ? `fetch_features_${source}_too_large` : "fetch_features_area_too_large")
        : tooBig
          ? t("fetch_features_reduce_area")
          : sqlMissing
            ? t("fetch_features_sql_needed")
            : workflow
              ? isNetwork
                ? t(`fetch_features_${source}_not_in_workflow`)
                : undefined
              : !name.trim()
                ? t("connect_service_name_needed")
                : !selectedFolder
                  ? t("connect_service_folder_needed")
                  : undefined;

  return {
    isBusy,
    reset,
    action: {
      label: t(workflow ? "connect_service_use_in_workflow" : "add_layer"),
      disabled: !!reason || isBusy,
      reason,
      notice: workflow ? undefined : notice,
      run: workflow ? use : submit,
    },
    fetch: {
      areaMode,
      setAreaMode: (mode: AreaMode) => {
        if (mode !== areaMode) {
          // The map was framed on what was chosen, so the view is no longer just the start.
          if (spatial || kept) setViewChosen(true);
          setKept(undefined);
        }
        setAreaMode(mode);
      },
      viewBox,
      setViewBox: (box: Bbox, moved?: boolean) => {
        setViewBox(box);
        if (moved) setViewChosen(true);
      },
      spatial,
      setSpatial: (filter: CatalogSpatialFilter | null) => {
        // A polygon with fewer than three corners is not an area: what was in force stays.
        if (!(filter?.kind === "polygon" && filter.ring.length < 3)) setKept(undefined);
        setSpatial(filter);
      },
      regionNames,
      area,
      areaLabel,
      source,
      setSource: (next: FetchSource) => {
        setSource(next);
        setCustomName(null);
      },
      tooBig,
      tooLarge,
      sizePending,
      sizeState,
      estimate,
      sampleFilters,
      isQuickPickOn,
      toggleQuickPick,
      osmType,
      setOsmType: (next: string) => {
        setOsmType(next);
        setCustomName(null);
      },
      overtureType,
      setOvertureType: (next: string) => {
        setOvertureType(next);
        setCustomName(null);
      },
      featureType,
      filterMode,
      setFilterMode,
      match,
      setMatch,
      filters,
      addFilter,
      updateFilter,
      removeFilter,
      sql,
      setSql,
      startSql: () => {
        const written = filtersAsSql();
        setSql(written);
        setWrittenSql(written);
        setFilterMode("sql");
      },
      sqlEdited: filterMode === "sql" && !!sql.trim() && sql !== writtenSql,
      name,
      setName: setCustomName,
      folders,
      spaces,
      selectedFolder,
      setSelectedFolder,
      inWorkflow: !!workflow,
    },
  };
};
