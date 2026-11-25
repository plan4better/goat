// What the area picker works on: an area someone else keeps (the filter panel's draft, the fetch dialog, the catalog's
// location filter), what it may hold and the map its shapes are drawn on. The picker reads and changes the area only
// through this.
import type { FilterArea } from "@/lib/filter/area";

/** A way to add to the area, as "Add to area" offers it. `point` is a circle around a clicked centre whose radius is
 * set with a slider; `circle` is drawn with two clicks. */
export type AreaWay = "view" | "polygon" | "circle" | "point" | "regions" | "features";

/** The map the shapes are drawn on and the view is read from. */
export interface AreaMap {
  /** The map's id in its MapProvider. */
  id: string;
  /** Whether it is the project's map: measuring and feature editing use its draw tool too, and its cursor and its
   * popups are switched while a shape is drawn. */
  main: boolean;
}

export const MAIN_MAP: AreaMap = { id: "map", main: true };

/** What one area may hold. */
export interface AreaLimits {
  shapes: number;
  features: number;
  /** Whether an area this big still fits, its outlines as they are. */
  fits: (area: FilterArea) => boolean;
}

export interface AreaHost {
  /** The area as it is when the host renders. */
  area: FilterArea | undefined;
  /** The area as it is now: an outline that loaded or a shape that was finished joins this one. */
  read: () => FilterArea | undefined;
  setArea: (area: FilterArea | undefined) => void;
  /** Without limits every outline joins the area as it is. */
  limits?: AreaLimits;
  /** Whether the features can be kept outside the area. */
  ops: boolean;
  /** The ways the picker offers; it lists them in its own order. */
  ways: readonly AreaWay[];
  map: AreaMap;
}
