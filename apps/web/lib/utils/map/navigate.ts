import bbox from "@turf/bbox";
import bboxPolygon from "@turf/bbox-polygon";
import type { BBox } from "@turf/helpers";
import type { MapRef } from "react-map-gl/maplibre";

import { MAP_PANEL_ATTR } from "@/lib/constants";
import { type ExtentLayer, canZoomTo, resolveLayerBounds } from "@/lib/utils/map/layerExtent";
import { wktToGeoJSON } from "@/lib/utils/map/wkt";
import type { ProjectLayer } from "@/lib/validations/project";

/** Web Mercator's latitude limit. */
const MAX_LAT = 85.051129;

export function zoomToLayer(map: MapRef, wkt_extent: string) {
  const geojson = wktToGeoJSON(wkt_extent);
  const boundingBox = bbox(geojson);
  fitBounds(map, boundingBox as [number, number, number, number]);
}

export function fitBounds(
  map: MapRef,
  bounds: [number, number, number, number],
  padding = 40,
  maxZoom = 18,
  duration = 1000
) {
  // Clamp into Web Mercator: past its latitude limit a box has no size MapLibre can fit.
  const clampedBounds: [number, number, number, number] = [
    Math.max(-180, Math.min(180, bounds[0])),
    Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds[1])),
    Math.max(-180, Math.min(180, bounds[2])),
    Math.max(-MAX_LAT, Math.min(MAX_LAT, bounds[3])),
  ];
  map.fitBounds(clampedBounds, {
    padding: padding,
    maxZoom: maxZoom,
    duration: duration,
  });
}

export function getMapExtentCQL(map: MapRef) {
  const bounds = map.getBounds();
  if (!bounds) return;
  const bbox = bounds.toArray().flat();
  if (!bbox) return;
  const polygon = bboxPolygon(bbox as BBox);
  const geometry = polygon.geometry;
  const cqlFilter = `{"op":"s_intersects","args":[{"property":"geom"}, ${JSON.stringify(geometry)}]}`;
  return cqlFilter;
}

export function zoomToFeatureCollection(
  map: MapRef,
  featureCollection: GeoJSON.FeatureCollection,
  options: Partial<{
    padding: number;
    maxZoom: number;
    duration: number;
  }> = {}
) {
  if (!featureCollection || !featureCollection.features.length) return;
  const { padding = 40, maxZoom = 18, duration = 1000 } = options; // Destructure with defaults

  const _bbox = bbox(featureCollection);
  fitBounds(map, _bbox as [number, number, number, number], padding, maxZoom, duration);
}

/** Screen pixels a side of the map is covered, or to keep clear. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The room kept around a layer zoomed to, past the panels. */
const ZOOM_MARGIN = 40;
/** No side is padded by more of the map than this: the rest is where the layer shows. */
const MAX_PADDING_SHARE = 0.4;
/** A single point's zoom: street level. */
const POINT_ZOOM = 16;
const MAX_ZOOM = 18;

/**
 * How far in from each side of `container` the floating panels over it reach. Each panel counts for the side it
 * covers least of the map (the layer tree on the left, a style panel on the right, a data table along the bottom).
 */
export function panelInsets(container: HTMLElement, root: ParentNode = document): Insets {
  const map = container.getBoundingClientRect();
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!map.width || !map.height) return insets;
  root.querySelectorAll<HTMLElement>(`[${MAP_PANEL_ATTR}]`).forEach((panel) => {
    const r = panel.getBoundingClientRect();
    const left = Math.max(r.left, map.left);
    const right = Math.min(r.right, map.right);
    const top = Math.max(r.top, map.top);
    const bottom = Math.min(r.bottom, map.bottom);
    if (right - left <= 0 || bottom - top <= 0) return;
    const sides: Array<[keyof Insets, number, number]> = [
      ["left", right - map.left, map.width],
      ["right", map.right - left, map.width],
      ["top", bottom - map.top, map.height],
      ["bottom", map.bottom - top, map.height],
    ];
    const [side, reach] = sides.reduce((best, next) => (next[1] / next[2] < best[1] / best[2] ? next : best));
    insets[side] = Math.max(insets[side], Math.round(reach));
  });
  return insets;
}

/** The padding of a zoom to layer: a margin past each inset, at most a share of the map on each side. */
export function zoomPadding(size: { width: number; height: number }, insets: Insets): Insets {
  const pad = (inset: number, dimension: number) =>
    Math.round(Math.min(inset + ZOOM_MARGIN, dimension * MAX_PADDING_SHARE));
  return {
    top: pad(insets.top, size.height),
    right: pad(insets.right, size.width),
    bottom: pad(insets.bottom, size.height),
    left: pad(insets.left, size.width),
  };
}

const mercatorY = (lat: number) => {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
};
const latitudeOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/**
 * The camera that shows `bounds` in a `size` map with `padding` kept clear, north up: the bounds as large as they
 * fit, centred in the room the padding leaves. A box of no size (a single point) gets street level, the zoom is at
 * most `maxZoom` and, where the layer shows only between zooms, inside them (`minZoom`, below `maxZoom`). A box whose
 * west lies east of its east crosses the antimeridian.
 */
export function cameraForBounds(
  bounds: [number, number, number, number],
  size: { width: number; height: number },
  padding: Insets,
  range: { minZoom?: number; maxZoom?: number } = {}
): { center: [number, number]; zoom: number } {
  const [west, south, rawEast, north] = bounds;
  const east = rawEast < west ? rawEast + 360 : rawEast;
  const x0 = (west + 180) / 360;
  const x1 = (east + 180) / 360;
  const y0 = mercatorY(north);
  const y1 = mercatorY(south);
  const width = Math.max(1, size.width - padding.left - padding.right);
  const height = Math.max(1, size.height - padding.top - padding.bottom);
  const dx = x1 - x0;
  const dy = y1 - y0;
  let zoom =
    dx < 1e-9 && dy < 1e-9
      ? POINT_ZOOM
      : Math.min(
          MAX_ZOOM,
          Math.log2(Math.min(width / (Math.max(dx, 1e-12) * 512), height / (Math.max(dy, 1e-12) * 512)))
        );
  if (range.maxZoom !== undefined && range.maxZoom < 24) zoom = Math.min(zoom, range.maxZoom - 0.01);
  if (range.minZoom !== undefined && range.minZoom > 0) zoom = Math.max(zoom, range.minZoom);
  zoom = Math.max(0, zoom);
  // The bounds' centre at the middle of the free room: the map's centre is off it by half the padding difference.
  const world = 512 * 2 ** zoom;
  const cx = (x0 + x1) / 2 - (padding.left - padding.right) / 2 / world;
  const cy = (y0 + y1) / 2 - (padding.top - padding.bottom) / 2 / world;
  let lng = cx * 360 - 180;
  if (lng > 180) lng -= 360;
  return { center: [lng, latitudeOf(Math.max(0, Math.min(1, cy)))], zoom };
}

/** The zooms a layer's style shows it at (spec 3.5): none where the style has no limits. */
const styleZooms = (layer: ProjectLayer): { minZoom?: number; maxZoom?: number } => {
  const document = (layer as { style?: { document?: Record<string, unknown> | null } | null }).style
    ?.document;
  const min = document?.["min_zoom"];
  const max = document?.["max_zoom"];
  return {
    ...(typeof min === "number" ? { minZoom: min } : {}),
    ...(typeof max === "number" ? { maxZoom: max } : {}),
  };
};

/**
 * Zoom the map to a project layer: to the area `resolveLayerBounds` finds, clear of the panels over the map and
 * inside the zooms the layer shows at. False, with the map left where it is, when nothing tells the layer's area.
 */
export async function zoomToProjectLayer(
  map: Pick<MapRef, "getContainer" | "flyTo">,
  layer: ProjectLayer
): Promise<boolean> {
  if (!canZoomTo(layer as ExtentLayer)) return false;
  const bounds = await resolveLayerBounds(layer as ExtentLayer);
  if (!bounds) return false;
  const container = map.getContainer();
  const rect = container.getBoundingClientRect();
  const size = { width: rect.width, height: rect.height };
  const padding = zoomPadding(size, panelInsets(container));
  const { center, zoom } = cameraForBounds(bounds, size, padding, styleZooms(layer));
  map.flyTo({ center, zoom, bearing: 0, duration: 1000, essential: true });
  return true;
}
