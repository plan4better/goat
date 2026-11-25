// The map's overlays: the active feature's pulse, pending edits, drawing, measuring, a filter's area and the PT network
// Explorer. They annotate the map, so they are neither data nor basemap and stay above every data layer.
const OVERLAY_PREFIXES = [
  "popup-active-feature",
  "pending-features",
  "gl-draw",
  "mapbox-gl-draw",
  "__measure",
  "filter-area",
  "explorer-",
];

export const isOverlayId = (id: string) => OVERLAY_PREFIXES.some((prefix) => id.startsWith(prefix));

/** The lowest overlay among the map's layers (bottom first): the project layers go below it. */
export const lowestOverlayId = (layers: Array<{ id: string }> | undefined): string | undefined =>
  layers?.find((layer) => isOverlayId(layer.id))?.id;
