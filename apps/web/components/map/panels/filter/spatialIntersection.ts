import { ICON_NAME } from "@p4b/ui/components/Icon";

import { SpatialIntersectionGeomType } from "@/lib/validations/filter";

import type { SelectorItem } from "@/types/map/common";

/**
 * The spatial intersections a filter row offers: the map extent, plus a
 * boundary when the row already holds one (the assistant sets a region's
 * boundary). Drawing a boundary by hand is not offered.
 */
export const spatialIntersectionOptions = (
  t: (key: string) => string,
  current: string | null
): SelectorItem[] => [
  { value: SpatialIntersectionGeomType.BBOX, label: t("map_extent"), icon: ICON_NAME.BOUNDING_BOX },
  ...(current === SpatialIntersectionGeomType.BOUNDARY
    ? [{ value: SpatialIntersectionGeomType.BOUNDARY, label: t("boundary"), icon: ICON_NAME.DRAW_POLYGON }]
    : []),
];

/** A spatial row's geometry: GeoJSON whose `properties` name the kind of
 * area (`type`) and what the row shows for it (`label`). */
export type SpatialRowGeometry = {
  type?: unknown;
  coordinates?: unknown;
  properties?: { type?: unknown; label?: unknown } | null;
};

/** The geometry a spatial row holds (stored as JSON text), or null when the
 * value is not the JSON of an object. */
export const spatialGeometry = (value: unknown): SpatialRowGeometry | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as SpatialRowGeometry) : null;
  } catch {
    return null;
  }
};

/** The `properties.type` of a spatial row's geometry, or null. */
export const spatialGeometryType = (value: unknown): string | null => {
  const type = spatialGeometry(value)?.properties?.type;
  return typeof type === "string" ? type : null;
};
