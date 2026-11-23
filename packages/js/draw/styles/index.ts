/**
 * @p4b/draw - MapboxDraw styles
 */
import type { DrawStyle } from "../types";

/**
 * Default styles - red dashed lines with white-outlined vertices
 */
// Default color — used when feature doesn't have user properties set
const DEFAULT_COLOR = "#ef4444";

/** The id of a feature whose midpoints show while it is edited (direct_select), so that a click on one adds a corner
 * there. Everyone else's midpoints stay hidden. */
export const SHOWN_MIDPOINTS_ID = "shown-midpoints";

export const defaultDrawStyles: DrawStyle[] = [
  // Polygon fill — uses user__fillColor if set on the feature, else default
  {
    id: "gl-draw-polygon-fill-inactive",
    type: "fill",
    filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
    paint: {
      "fill-color": ["coalesce", ["get", "user__fillColor"], DEFAULT_COLOR],
      "fill-outline-color": ["coalesce", ["get", "user__fillColor"], DEFAULT_COLOR],
      "fill-opacity": ["coalesce", ["get", "user__fillOpacity"], 0.1],
    },
  },
  {
    id: "gl-draw-polygon-fill-active",
    type: "fill",
    filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
    paint: {
      "fill-color": ["coalesce", ["get", "user__fillColor"], DEFAULT_COLOR],
      "fill-outline-color": ["coalesce", ["get", "user__fillColor"], DEFAULT_COLOR],
      "fill-opacity": ["coalesce", ["get", "user__fillOpacity"], 0.15],
    },
  },
  // Polygon stroke
  {
    id: "gl-draw-polygon-stroke-inactive",
    type: "line",
    filter: ["all", ["==", "active", "false"], ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ef4444", "line-dasharray": [2, 2], "line-width": 2 },
  },
  {
    id: "gl-draw-polygon-stroke-active",
    type: "line",
    filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ef4444", "line-dasharray": [2, 2], "line-width": 3 },
  },
  // Line
  {
    id: "gl-draw-line-inactive",
    type: "line",
    filter: ["all", ["==", "active", "false"], ["==", "$type", "LineString"], ["!=", "mode", "static"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ef4444", "line-dasharray": [2, 2], "line-width": 2 },
  },
  {
    id: "gl-draw-line-active",
    type: "line",
    filter: ["all", ["==", "$type", "LineString"], ["==", "active", "true"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ef4444", "line-dasharray": [2, 2], "line-width": 3 },
  },
  // Vertex stroke (white background)
  {
    id: "gl-draw-polygon-and-line-vertex-stroke-inactive",
    type: "circle",
    filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
    paint: { "circle-radius": 8, "circle-color": "#fff" },
  },
  // Vertex fill (red inner)
  {
    id: "gl-draw-polygon-and-line-vertex-inactive",
    type: "circle",
    filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
    paint: { "circle-radius": 6, "circle-color": "#ef4444" },
  },
  // Midpoints (hidden)
  {
    id: "gl-draw-polygon-midpoint",
    type: "circle",
    filter: ["all", ["==", "$type", "Point"], ["==", "meta", "midpoint"]],
    paint: { "circle-radius": 0, "circle-color": "#ef4444", "circle-opacity": 0 },
  },
  // Midpoints of the one feature that shows them: smaller than a vertex, white with the line's colour around
  {
    id: "gl-draw-polygon-midpoint-shown",
    type: "circle",
    filter: [
      "all",
      ["==", "$type", "Point"],
      ["==", "meta", "midpoint"],
      ["==", "parent", SHOWN_MIDPOINTS_ID],
    ],
    paint: {
      "circle-radius": 4,
      "circle-color": "#fff",
      "circle-stroke-color": "#ef4444",
      "circle-stroke-width": 2,
    },
  },
  // Point — when _iconImage is set, circle becomes a transparent selection ring around the icon
  {
    id: "gl-draw-point-inactive",
    type: "circle",
    filter: ["all", ["==", "active", "false"], ["==", "$type", "Point"], ["==", "meta", "feature"]],
    paint: {
      // Ring around the icon: prefer the measured pixel radius supplied by
      // the editor (_iconRadius — accounts for the image's intrinsic size);
      // fall back to a size-based estimate, then to the plain point radius.
      "circle-radius": [
        "case",
        ["has", "user__iconRadius"],
        ["get", "user__iconRadius"],
        ["has", "user__iconImage"],
        ["max", 8, ["*", ["coalesce", ["get", "user__iconSize"], 0.5], 16]],
        5,
      ],
      "circle-color": ["case", ["has", "user__iconImage"], "transparent", "#fff"],
      "circle-stroke-color": "#ef4444",
      "circle-stroke-width": 2,
    },
  },
  {
    id: "gl-draw-point-active",
    type: "circle",
    filter: ["all", ["==", "$type", "Point"], ["==", "meta", "feature"], ["==", "active", "true"]],
    paint: {
      "circle-radius": [
        "case",
        ["has", "user__iconRadius"],
        ["+", ["get", "user__iconRadius"], 2],
        ["has", "user__iconImage"],
        ["+", ["max", 8, ["*", ["coalesce", ["get", "user__iconSize"], 0.5], 16]], 2],
        7,
      ],
      "circle-color": ["case", ["has", "user__iconImage"], "transparent", "#fff"],
      "circle-stroke-color": "#ef4444",
      "circle-stroke-width": 3,
    },
  },
  // Symbol layer for custom marker icons — driven by user properties set on the feature.
  // Only renders when user__iconImage is set (empty string = no icon rendered).
  {
    id: "gl-draw-point-icon-inactive",
    type: "symbol",
    filter: ["all", ["==", "active", "false"], ["==", "$type", "Point"], ["==", "meta", "feature"]],
    layout: {
      "icon-image": ["coalesce", ["get", "user__iconImage"], ""],
      "icon-size": ["coalesce", ["get", "user__iconSize"], 0.5],
      "icon-allow-overlap": true,
      "icon-anchor": ["coalesce", ["get", "user__iconAnchor"], "center"],
    },
    paint: {
      "icon-opacity": ["coalesce", ["get", "user__iconOpacity"], 1],
      "icon-color": ["coalesce", ["get", "user__iconColor"], "#000000"],
    },
  },
  {
    id: "gl-draw-point-icon-active",
    type: "symbol",
    filter: ["all", ["==", "active", "true"], ["==", "$type", "Point"], ["==", "meta", "feature"]],
    layout: {
      "icon-image": ["coalesce", ["get", "user__iconImage"], ""],
      "icon-size": ["coalesce", ["get", "user__iconSize"], 0.5],
      "icon-allow-overlap": true,
      "icon-anchor": ["coalesce", ["get", "user__iconAnchor"], "center"],
    },
    paint: {
      "icon-opacity": ["coalesce", ["get", "user__iconOpacity"], 1],
      "icon-color": ["coalesce", ["get", "user__iconColor"], "#000000"],
    },
  },
];

/**
 * Create styles with a custom color
 */
export function createDrawStyles(color: string): DrawStyle[] {
  return defaultDrawStyles.map((style) => {
    const newStyle = { ...style, paint: { ...style.paint } };
    if (newStyle.paint) {
      for (const key of Object.keys(newStyle.paint)) {
        if (newStyle.paint[key] === "#ef4444") {
          newStyle.paint[key] = color;
        }
      }
    }
    return newStyle;
  });
}
