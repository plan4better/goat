// Inputs and outputs of the GOAT Style compiler (spec section 16).
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterTileset, RasterValues } from "@/lib/style/raster/values";

/** A field's type as the data describes it (goatlib `FieldType`). */
export type FieldType = "string" | "number" | "integer" | "boolean" | "date" | "datetime";

export type Geometry = "point" | "line" | "polygon";
export type Position = "top" | "below_labels" | "below_roads";

/** Where the layer's data comes from; URLs are built by the caller, the compiler only adds the style's parts. */
export type CompileSource =
  | { type: "tiles"; id: string; tiles: string[]; maxzoom?: number }
  /** The points themselves: a URL of GeoJSON, or features held in the browser. */
  | { type: "points"; id: string; data: string | GeoJSON.FeatureCollection }
  | {
      type: "service";
      id: string;
      service: "wms" | "wmts" | "xyz";
      tiles: string;
      tileSize?: number;
      /** How many service layers the URL draws (WMS `LAYERS`). */
      layers?: number;
    }
  /** A raster file served by geoapi: its image tile template (`{z}/{x}/{y}`), the colored tiles' description, its
   * coverage tileset (value tiles), its version (`v=` of the image tiles), the file's bounds where the layer knows them
   * and, once loaded, the description of the value tiles the style reads or of the colored tiles an image draws. */
  | {
      type: "raster";
      id: string;
      tiles: string;
      /** The colored tiles' description (`tiles` without z/x/y): an image render draws once it has answered. */
      tileset?: string;
      coverage: string;
      version?: string;
      /** West, south, east and north in degrees: the map asks only for the tiles that touch them. */
      bounds?: [number, number, number, number];
      /** Null: an image drawn with its file's color table whose values failed (it draws the colored tiles instead). */
      values?: RasterValues | null;
      /** The colored tiles' description once answered: the file's bounds, native zoom and version, or null when there
       * is none (the image draws with the layer's own bounds). */
      image?: RasterTileset | null;
    };

export interface CompileInput {
  /** Layer ids are `${id}-<part>`. */
  id: string;
  style: LayerStyle;
  /** The dataset's geometry; it wins over the document's `geometry`. */
  geometry?: Geometry;
  fields?: Record<string, FieldType>;
  source: CompileSource;
  /** The layer's entry in the map document (section 10). */
  entry?: { visible?: boolean; position?: Position; time?: { value?: string | number } };
  /** Mark the active and hovered feature through `feature-state` in each part's paint. */
  highlight?: boolean;
  /** Where an icon reference's image comes from; the default resolves GOAT's library and built-in images. */
  resolveIcon?: (ref: string) => { url: string; sdf: boolean } | null;
}

/** An image the map must have before the layers draw: loaded at `height` px with `pixelRatio`. */
export interface ImageRequest {
  name: string;
  url: string;
  sdf: boolean;
  height: number;
  pixelRatio: number;
}

export interface CompiledLayer {
  /** The compiled layer's id (`CompileInput.id`): its layer ids start with it. */
  id: string;
  sources: Record<string, SourceSpecification>;
  /** Bottom to top. */
  layers: LayerSpecification[];
  images: ImageRequest[];
  /** Entries of the style's root `state` (global state defaults): "locale", `${id}:time`. */
  state: Record<string, { default: unknown }>;
  /** What the data URL must ask geoapi for: polygon label anchors, line decoration points, the fields they carry;
   * for the points of a GeoJSON URL (clusters) the fields the layers read. */
  tileParams: { label?: true; decorations?: Array<"start" | "end" | "center">; fields?: string[] };
  position: Position;
  /** Capability names of spec section 19 this style needs and this compiler cannot render yet. */
  unsupported: string[];
}
