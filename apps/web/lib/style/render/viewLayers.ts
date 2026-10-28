// A map's layers as the renderer draws them: each layer's active style on its data, with the layer's filter
// and the temporary ones, the feature editor's dynamic tiles, hidden and pending features, the highlighted feature and
// the atlas page. Pure: StyledLayers puts the result on the map. Map events go back from MapLibre layer ids to these
// layers through the renderer's registry.
import type { MapGeoJSONFeature } from "maplibre-gl";

import type { TemporaryFilter } from "@/lib/store/map/slice";
import { sourceKind } from "@/lib/style/compile";
import { ICON_HEIGHT } from "@/lib/style/compile/constants";
import type { Geometry, Position } from "@/lib/style/compile/types";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";
import { type SourceLayer, compileSourceFor } from "@/lib/style/layerSource";
import { type RenderLayer, mapLayerIdsOf, projectLayerOf } from "@/lib/style/render/mapLayers";

/** One layer of a map: a project layer (`MapLayer`), a dataset in a preview, a published layer. */
export interface ViewLayer extends SourceLayer {
  name?: string | null;
  feature_layer_geometry_type?: string | null;
  query?: { cql?: unknown } | null;
  /** When the dataset's data last changed (tile cache busting). */
  dataset_updated_at?: string | null;
  /** Drawn: the layer and every group around it are visible. */
  visible: boolean;
  /** Its own entry in the map document (its own visibility, position and time). */
  entry?: { visible?: boolean | null; position?: string | null; time?: { value?: unknown } | null } | null;
  /** The active style; null draws nothing (a layer locked for this user, a snapshot without styles). */
  style: { id?: string; revision?: number; document: LayerStyle } | null;
  /** A viewer's opacity, applied over the style's (view state). */
  opacity?: number | null;
}

export interface RenderOptions {
  /** Filter widgets and click to filter (none in the data view). */
  temporaryFilters?: TemporaryFilter[];
  /** The feature editor: its dataset's tiles are made from the table, its edited features are hidden in the tiles
   * and the pending ones drawn on top. */
  editing?: { dataset: string; exclude: Array<number | string>; pending?: GeoJSON.FeatureCollection };
  highlight?: { key: string; id: number | string };
  /** The atlas page's feature on the coverage layer: the only one drawn. */
  atlas?: { key: string; feature: number };
  /** Clustered layers shown at least once: their points load only then. */
  revealed?: ReadonlySet<string>;
  /** Where a time slider without a value starts, by layer key: the latest step (spec 7.3). */
  timeDefaults?: Readonly<Record<string, string | number>>;
}

/** The key of the feature editor's pending features (`pending-features-<part>`); `-mark` outlines them. */
export const PENDING_KEY = "pending-features";

/** Parts that draw a feature's geometry: what snapping and the feature editor's click query. */
export const GEOMETRY_PARTS = ["fill", "outline", "casing", "line", "marker", "icon", "heatmap"];
/** Parts a click or hover finds a feature on. */
export const INTERACTIVE_PARTS = [...GEOMETRY_PARTS, "pattern", "label", "cluster"];

const RED = "#ef4444";

/** The temporary filters that apply to a layer's own data: its own (not click to filter's, which keeps every feature
 * clickable) and those other filters target it with. */
export function temporaryFiltersFor(layerId: number | string, filters: TemporaryFilter[] = []): object[] {
  return [
    ...filters.filter((f) => f.layer_id === layerId && !f.excludeFromSourceLayer).map((f) => f.filter),
    ...filters
      .flatMap((f) => f.additional_targets ?? [])
      .filter((t) => t.layer_id === layerId)
      .map((t) => t.filter),
  ];
}

const geometryOf = (layer: ViewLayer): Geometry | undefined => {
  const g = layer.feature_layer_geometry_type?.toLowerCase();
  return g === "point" || g === "line" || g === "polygon" ? g : undefined;
};

const datasetOf = (layer: ViewLayer) => String(layer.layer_id ?? layer.id);

/** The pending features' outline: dashed for lines and polygons, a ring around points. */
function markStyle(geometry: Geometry | undefined): LayerStyle {
  const symbol =
    geometry === "point"
      ? { marker: { shape: "circle", size: 28, opacity: 0 }, outline: { color: RED, width: 2 } }
      : geometry === "line"
        ? { line: { color: RED, width: 2, dash: "dashed" } }
        : { fill: false, outline: { color: RED, width: 2, dash: "dashed" } };
  return { version: 1, kind: "vector", symbol } as LayerStyle;
}

function pendingLayers(layer: ViewLayer, pending: GeoJSON.FeatureCollection): RenderLayer[] {
  const geometry = geometryOf(layer);
  const document = layer.style?.document;
  if (!document || !pending.features.length) return [];
  const source = (key: string) => ({ type: "points" as const, id: `src-${key}`, data: pending });
  // The pending features are few and drawn whole: no clusters.
  const { render: _render, ...style } = document as LayerStyle & { render?: unknown };
  const mark = `${PENDING_KEY}-mark`;
  return [
    { key: mark, style: markStyle(geometry), geometry, entry: {}, source: source(mark) },
    { key: PENDING_KEY, style: style as LayerStyle, geometry, entry: {}, source: source(PENDING_KEY) },
  ];
}

/** The renderer's layers, top first: the pending features, then every layer with a style. */
export function renderLayersOf(layers: ViewLayer[], opts: RenderOptions = {}): RenderLayer[] {
  const edited = opts.editing && layers.find((l) => datasetOf(l) === opts.editing?.dataset);
  const out: RenderLayer[] =
    edited && opts.editing?.pending ? pendingLayers(edited, opts.editing.pending) : [];
  for (const layer of layers) {
    const style = layer.style;
    if (!style) continue;
    const key = String(layer.id);
    const kind = sourceKind(style.document);
    if (kind === "points" && !layer.visible && !opts.revealed?.has(key)) continue;
    // Every project layer of the edited dataset (a dataset can be in a project twice); the first draws the overlay.
    const isEdited = !!opts.editing && datasetOf(layer) === opts.editing.dataset;
    const source = compileSourceFor(layer, {
      kind,
      cql: layer.query?.cql,
      extra: temporaryFiltersFor(layer.id, opts.temporaryFilters),
      dynamic: isEdited,
      version: layer.dataset_updated_at,
    });
    if (!source) continue;
    const filter = {
      ...(isEdited && opts.editing?.exclude.length ? { exclude: opts.editing.exclude } : {}),
      ...(opts.atlas?.key === key ? { atlas: opts.atlas.feature } : {}),
    };
    const time = (layer.entry?.time?.value ?? opts.timeDefaults?.[key]) as string | number | undefined;
    const viewed = typeof layer.opacity === "number";
    out.push({
      key,
      style: viewed ? { ...style.document, opacity: layer.opacity } : style.document,
      version:
        style.id !== undefined
          ? `${style.id}:${style.revision ?? 0}${viewed ? `@${layer.opacity}` : ""}`
          : undefined,
      geometry: geometryOf(layer),
      entry: {
        visible: layer.visible,
        ...(layer.entry?.position ? { position: layer.entry.position as Position } : {}),
        ...(time !== undefined ? { time: { value: time } } : {}),
      },
      source,
      ...(Object.keys(filter).length ? { filter } : {}),
      ...(opts.highlight?.key === key ? { highlight: opts.highlight.id } : {}),
    });
  }
  return out;
}

/** The layer a MapLibre layer draws, if the renderer drew it. */
export function layerOfMapLayer<T extends { id: number | string }>(
  map: object,
  mapLayerId: string,
  layers: readonly T[] | undefined
): T | undefined {
  const key = projectLayerOf(map, mapLayerId);
  return key === undefined ? undefined : layers?.find((l) => String(l.id) === key);
}

/** The edited layer's MapLibre layers, bottom to top: those drawing its geometry (`snap`), else also its labels and
 * the pending features, which a click selects from. */
export function editorLayerIds(map: object, key: string, opts: { snap?: boolean } = {}): string[] {
  if (opts.snap) return mapLayerIdsOf(map, key, { kinds: GEOMETRY_PARTS });
  const kinds = [...GEOMETRY_PARTS, "pattern", "label"];
  return [
    ...mapLayerIdsOf(map, key, { kinds }),
    ...mapLayerIdsOf(map, PENDING_KEY, { kinds }),
    ...mapLayerIdsOf(map, `${PENDING_KEY}-mark`, { kinds }),
  ];
}

/** The edited layer's icon for the features being drawn (MapboxDraw's `user__icon*` properties, drawn with a selection
 * ring around it): its base marker icon when the style draws icons, else null (the drawing tools' circle). */
export function editorIconProps(
  style: LayerStyle | null | undefined
): Record<string, string | number> | null {
  const symbol = (style as { symbol?: unknown } | null | undefined)?.symbol;
  const marker = isObject(symbol) && isObject(symbol.marker) ? symbol.marker : null;
  if (!marker || marker.shape !== "icon") return null;
  const size = typeof marker.size === "number" ? marker.size : (DEFAULTS["marker.size"] as number);
  return {
    _iconImage: typeof marker.icon === "string" ? marker.icon : "goat:marker",
    _iconSize: size / ICON_HEIGHT,
    _iconAnchor: typeof marker.anchor === "string" ? marker.anchor.replace("_", "-") : "center",
    _iconOpacity: typeof marker.opacity === "number" ? marker.opacity : 1,
    _iconColor: typeof marker.color === "string" ? marker.color : (DEFAULTS["marker.color"] as string),
    _iconRadius: Math.round(size / 2 + 4),
  };
}

/** Every project layer's MapLibre layers drawing geometry, in the map's order: what measuring snaps to. */
export function projectGeometryLayerIds(map: {
  getStyle(): { layers?: Array<{ id: string }> } | undefined;
}): string[] {
  return (map.getStyle()?.layers ?? [])
    .map((l) => l.id)
    .filter((id) => {
      const key = projectLayerOf(map, id);
      return (
        key !== undefined &&
        !key.startsWith(PENDING_KEY) &&
        mapLayerIdsOf(map, key, { kinds: GEOMETRY_PARTS }).includes(id)
      );
    });
}

/** The topmost feature whose layer `accept`s, with that layer. */
export function topFeature<T extends { id: number | string }>(
  map: object,
  features: readonly MapGeoJSONFeature[] | undefined,
  layers: readonly T[] | undefined,
  accept: (layer: T) => boolean
): { feature: MapGeoJSONFeature; layer: T } | undefined {
  for (const feature of features ?? []) {
    const layer = layerOfMapLayer(map, feature.layer.id, layers);
    if (layer && accept(layer)) return { feature, layer };
  }
  return undefined;
}

/** A clicked cluster: a feature of one of the renderer's cluster layers that carries a cluster id. */
export function clusterFeatureOf(
  map: object,
  features: readonly MapGeoJSONFeature[] | undefined
): MapGeoJSONFeature | undefined {
  return features?.find((f) => {
    const key = projectLayerOf(map, f.layer.id);
    return (
      key !== undefined &&
      f.properties?.cluster_id != null &&
      mapLayerIdsOf(map, key, { kinds: ["cluster"] }).includes(f.layer.id)
    );
  });
}

interface ClusterMap {
  getSource(id: string): unknown;
  easeTo(options: { center: [number, number]; zoom: number; duration: number }): unknown;
}

/** Zooms to where a cluster breaks apart. */
export async function zoomToCluster(map: ClusterMap, cluster: MapGeoJSONFeature): Promise<void> {
  const source = map.getSource(cluster.layer.source) as
    | { getClusterExpansionZoom?: (id: number) => Promise<number> }
    | undefined;
  const id = cluster.properties?.cluster_id;
  if (!source?.getClusterExpansionZoom || id == null) return;
  try {
    const zoom = await source.getClusterExpansionZoom(id);
    const geometry = cluster.geometry;
    if (geometry?.type === "Point")
      map.easeTo({ center: geometry.coordinates as [number, number], zoom, duration: 500 });
  } catch {
    // The cluster source may have gone between the click and the answer.
  }
}
