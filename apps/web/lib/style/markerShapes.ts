// The marker shapes (spec 3.3 `shape`), one outline each in a 24 x 24 box that the marker's size fills: the renderer
// draws it, the legend, the popup and the panel show it. A pin's tip is at the bottom centre of its box (12, 24), so
// anchored at the bottom it points at its place; the icon sits in the shape's head.

export interface MarkerShapeSpec {
  /** The outline as SVG path data in the 24 box. */
  path: string;
  /** Where the icon goes: its centre, and its side as a share of the marker's size. */
  icon: { cx: number; cy: number; share: number };
  /** Points at its place with its tip: anchored at the bottom unless the style sets an anchor. */
  pin: boolean;
}

export const MARKER_SHAPES = {
  circle: { path: "M12 0a12 12 0 1 0 0.01 0Z", icon: { cx: 12, cy: 12, share: 0.6 }, pin: false },
  square: {
    path: "M4.8 0h14.4A4.8 4.8 0 0 1 24 4.8v14.4a4.8 4.8 0 0 1-4.8 4.8H4.8A4.8 4.8 0 0 1 0 19.2V4.8A4.8 4.8 0 0 1 4.8 0Z",
    icon: { cx: 12, cy: 12, share: 0.6 },
    pin: false,
  },
  diamond: { path: "M12 0 24 12 12 24 0 12Z", icon: { cx: 12, cy: 12, share: 0.46 }, pin: false },
  hexagon: { path: "M12 0 22.4 6v12L12 24 1.6 18V6Z", icon: { cx: 12, cy: 12, share: 0.54 }, pin: false },
  shield: {
    path: "M12 0 23 4v7c0 6.5-5 11-11 13C6 22 1 17.5 1 11V4Z",
    icon: { cx: 12, cy: 10.5, share: 0.52 },
    pin: false,
  },
  pin: {
    path: "M12 24C12 24 3 15.2 3 9a9 9 0 0 1 18 0c0 6.2-9 15-9 15Z",
    icon: { cx: 12, cy: 9, share: 0.5 },
    pin: true,
  },
  round_pin: {
    path: "M12 24 8.4 20.4A10.5 10.5 0 1 1 15.6 20.4Z",
    icon: { cx: 12, cy: 10.5, share: 0.56 },
    pin: true,
  },
  needle: {
    path: "M12 0a8 8 0 1 0 0.01 0ZM11 15.5h2V24h-2Z",
    icon: { cx: 12, cy: 8, share: 0.44 },
    pin: true,
  },
  square_pin: {
    path: "M4 0h16a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-4.6L12 24l-3.4-4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z",
    icon: { cx: 12, cy: 10, share: 0.56 },
    pin: true,
  },
  tag_pin: {
    path: "M4 0h16a4 4 0 0 1 4 4v11.5L12 24 0 15.5V4a4 4 0 0 1 4-4Z",
    icon: { cx: 12, cy: 9.5, share: 0.52 },
    pin: true,
  },
  // The pole stands in the middle, so the flag points at its place like any pin; the cloth flies to the right.
  flag: {
    path: "M11 0h2v24h-2ZM13 0h11l-3.5 6.5L24 13H13Z",
    icon: { cx: 17.8, cy: 6.5, share: 0.36 },
    pin: true,
  },
} as const satisfies Record<string, MarkerShapeSpec>;

export type MarkerShapeId = keyof typeof MARKER_SHAPES;

/** The shapes in the order the panel offers them: shapes, then pins. */
export const SHAPE_IDS = Object.keys(MARKER_SHAPES) as MarkerShapeId[];

/** The shape a style's `marker.shape` draws: a known shape, else the circle (the default); "icon" is no shape. */
export function markerShapeOf(value: unknown): MarkerShapeId {
  return typeof value === "string" && value in MARKER_SHAPES ? (value as MarkerShapeId) : "circle";
}

export const isPin = (shape: unknown): boolean =>
  markerShapeOf(shape) === shape && MARKER_SHAPES[shape as MarkerShapeId].pin;

/** Whether a marker draws as one image (a shape with or without an icon): a circle without an icon stays a circle
 * layer, and an icon alone is a symbol of its own. */
export function drawsAsImage(shape: unknown, hasIcon: boolean): boolean {
  if (shape === "icon") return false;
  return markerShapeOf(shape) !== "circle" || hasIcon;
}

/** The shape a library symbol draws: the shapes are symbols too (`goat:shape-pin`), for a marker that is a pin alone. */
export function symbolShape(ref: unknown): MarkerShapeId | undefined {
  if (typeof ref !== "string" || !ref.startsWith("goat:shape-")) return undefined;
  const id = ref.slice("goat:shape-".length).replace(/-/g, "_");
  return id in MARKER_SHAPES ? (id as MarkerShapeId) : undefined;
}
