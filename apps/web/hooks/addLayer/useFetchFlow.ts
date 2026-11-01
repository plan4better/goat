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

export type FetchSource = "osm" | "overture" | "street_network";
export type AreaMode = "view" | "region" | "point" | "polygon";
export type FilterMode = "builder" | "sql";
export type MatchMode = "all" | "any";
export type Bbox = [number, number, number, number];
export type TagFilter = { id: number; key: string; values: string[] };

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
  tag_filters?: { key: string; values: string[] }[];
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
    return { params, filters, spatial };
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
  setEstimate: (estimate: number | undefined) => void;
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
  addFilter: () => void;
  updateFilter: (id: number, change: Partial<Omit<TagFilter, "id">>) => void;
  removeFilter: (id: number) => void;
  sql: string;
  setSql: (value: string) => void;
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
    ...(seed ? { [seed.params.source as FetchSource]: seed.filters } : {}),
  }));
  const [sql, setSql] = useState(seed?.params.where ?? "");
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

  // A street network is cut whole: no layer type, no filters.
  const isNetwork = source === "street_network";
  const featureType = source === "osm" ? osmType : isNetwork ? "" : overtureType;
  const filters = filtersBySource[source];
  const setFilters = useCallback(
    (update: (current: TagFilter[]) => TagFilter[]) =>
      setFiltersBySource((all) => ({ ...all, [source]: update(all[source]) })),
    [source]
  );

  const addFilter = useCallback(
    () => setFilters((current) => [...current, { id: nextId.current++, key: "", values: [] }]),
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

  const suggestedName = isNetwork
    ? t("fetch_features_source_street_network")
    : `${t(`fetch_features_source_short_${source}`)} ${t(`fetch_features_type_${featureType}`).toLowerCase()}`;
  const name = customName ?? suggestedName;

  const reset = useCallback(() => {
    setAreaMode("view");
    setViewBox(roundBox(viewport ?? DEFAULT_VIEW_BOX));
    setViewChosen(!!viewport);
    heldArea.current = undefined;
    setSpatial(null);
    setKept(undefined);
    setFiltersBySource({ osm: [], overture: [], street_network: [] });
    setSql("");
    setCustomName(null);
    setIsBusy(false);
    setSelectedFolder(undefined);
    folderInitialized.current = false;
  }, [viewport]);

  const usedFilters = filters.filter((f) => f.key.trim());
  const sqlMissing = !isNetwork && filterMode === "sql" && !sql.trim();
  // Kept with the area, source and layer it was counted for: another one has none yet.
  const sizedFor = useMemo(() => JSON.stringify([area, source, featureType]), [area, source, featureType]);
  const [sized, setSized] = useState<{ for: string; estimate?: number }>();
  const estimate = sized?.for === sizedFor ? sized.estimate : undefined;
  const setEstimate = useCallback(
    (next: number | undefined) => setSized({ for: sizedFor, estimate: next }),
    [sizedFor]
  );
  // Kept apart from the estimate, which the lists also set: only the size check ends the wait.
  const [checked, setChecked] = useState<{ for: string; tooLarge: boolean }>();
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
          setSized((last) => ({
            for: sizedFor,
            estimate: last?.for === sizedFor && last.estimate != null ? Math.max(last.estimate, n ?? 0) : n,
          }));
          setChecked({ for: sizedFor, tooLarge: large });
        })
        // The tool checks the size itself, so a failed check does not block.
        .catch(() => current && setSizeFailedFor(sizedFor));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [sizedFor]);
  const sizePending = !!area && checked?.for !== sizedFor && sizeFailedFor !== sizedFor;
  // Only values narrow: a tag alone (highway) over a large area still passes the
  // cap. With "any", one tag without values keeps the result that broad. A SQL
  // condition is taken as narrowing: only the fetch can tell.
  const withValues = usedFilters.filter((f) => f.values.length > 0);
  const narrowed =
    filterMode === "sql"
      ? !!sql.trim()
      : withValues.length > 0 && (match === "all" || withValues.length === usedFilters.length);
  // Decided by the size check, which knows both limits: features and geometry.
  const tooLarge = checked?.for === sizedFor && checked.tooLarge;
  const tooBig = tooLarge || (!narrowed && (estimate ?? 0) > MAX_FEATURES);

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
            tag_filters: usedFilters.map(({ key, values }) => ({ key: key.trim(), values })),
          }),
    }),
    [source, osmType, overtureType, filterMode, sql, match, usedFilters]
  );

  const submit = useCallback(async () => {
    if (!area || !selectedFolder || !name.trim() || sqlMissing || tooBig || sizePending) return;
    try {
      setIsBusy(true);
      const job = isNetwork
        ? await executeProcessAsync("fetch_street_network", {
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
    selectedFolder,
    name,
    sqlMissing,
    tooBig,
    sizePending,
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
    if (!workflow || !area || sqlMissing || tooBig || sizePending) return;
    try {
      setIsBusy(true);
      const { columns, geometryType } = await getMirrorColumns(area, featureType, source);
      const areaChoice = kept
        ? undefined
        : areaMode === "view"
          ? viewBox && { kind: "view" as const, bbox: viewBox }
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
    sizePending,
    featureType,
    source,
    t,
    suggestedName,
    kept,
    areaMode,
    viewBox,
    spatial,
    fetchParams,
    reset,
    onDone,
  ]);

  const reason = !area
    ? t("fetch_features_area_needed")
    : sizePending
      ? t("fetch_features_checking_area")
      : tooLarge
        ? t(isNetwork ? "fetch_features_street_network_too_large" : "fetch_features_area_too_large")
        : tooBig
          ? t("fetch_features_reduce_area")
          : sqlMissing
            ? t("fetch_features_sql_needed")
            : workflow
              ? isNetwork
                ? t("fetch_features_street_network_not_in_workflow")
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
      setEstimate,
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
