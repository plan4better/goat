import type { Theme } from "@mui/material";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { catalogCollectionId } from "@/lib/catalog/preview";
import { GEOAPI_BASE_URL } from "@/lib/constants";
import { coverageUrl, imageTilesetUrl } from "@/lib/style/layerSource";
import { wmsTileTemplate } from "@/lib/utils/externalService";
import type { CatalogCollection, CatalogItem } from "@/lib/validations/catalog";

/** What kind of thing a catalog result is. */

/**
 * `vector` covers point, line and polygon alike; `unknown` is for an item whose
 * kind genuinely cannot be told from what the catalog publishes.
 */
export type CatalogKind = "bundle" | "raster" | "wms" | "wmts" | "table" | "vector" | "unknown";

/** Pass `asMember` when the item is one layer of a bundle that is already on screen. */
export const catalogKindOf = (item: CatalogItem, asMember?: boolean): CatalogKind => {
  const props = item.properties;
  if (!asMember && (props["goat:member_count"] ?? 1) > 1) return "bundle";
  switch (props["goat:layerType"]) {
    case "raster":
      return "raster";
    case "wms":
      return "wms";
    case "wmts":
      return "wmts";
    case "table":
      return "table";
    case "feature":
      return "vector";
    default: {
      // Geometry first: a vector layer may also offer a map view. Otherwise a member that inherited
      // `bundle` says it is a map service in its own link. Same rule as goatlib's `is_wms`.
      if (props["goat:geometryType"]) return "vector";
      const service = item.links?.find((link) => link.rel === "wms" || link.rel === "wmts")?.rel;
      if (service === "wms" || service === "wmts") return service;
      if (typeof props["table:row_count"] === "number") return "table";
      // A GeoTIFF among a bundle's or a plan's layers: goatlib's `layer_type` reads it the same way.
      if (/\.tiff?$/i.test(item.assets?.data?.href ?? "")) return "raster";
      return "unknown";
    }
  }
};

/**
 * The tile template a map service item draws live from. A WMS: its `rel="wms"`
 * links on the first link's server, the link title naming the layers. A WMTS:
 * its `rel="xyz"` link, the tile address goat-data picked from the capabilities.
 * `null` for anything else, or a service that cannot be drawn.
 */
export const catalogServiceTiles = (item: CatalogItem): string | null => {
  const kind = catalogKindOf(item, true);
  if (kind === "wmts") return item.links.find((link) => link.rel === "xyz" && link.href)?.href ?? null;
  if (kind !== "wms") return null;
  const links = item.links.filter((link) => link.rel === "wms" && link.href);
  if (!links.length) return null;
  const href = links[0].href;
  // Several layers of one link are named in its title, comma-separated: the mirror keeps no `wms:layers`.
  const layers = links
    .filter((link) => link.href === href && link.title)
    .flatMap((link) => (link.title as string).split(",").map((name) => name.trim()))
    .filter(Boolean)
    // Encoded: a name with `&`, `#` or a space would cut the request short.
    .map((name) => encodeURIComponent(name).replace(/%3A/gi, ":"));
  // goat-data publishes the clean server address, so it goes in as it is.
  return layers.length ? wmsTileTemplate(href, layers) : null;
};

/**
 * The tile address of a layer's published tiles, which geoapi reads for the item's collection
 * (`catalogCollectionId`); `null` for an item without them, when the detail map draws the sample instead.
 */
export const catalogTilesUrl = (
  item: CatalogItem,
  base: string | undefined = GEOAPI_BASE_URL
): string | null =>
  base && item.properties["goat:tiles"] === true
    ? `${base}/collections/${catalogCollectionId(item.id)}/tiles/WebMercatorQuad/{z}/{x}/{y}`
    : null;

/**
 * A raster item's colored tiles, their description and its value tiles (`coverage`), on the routes geoapi has for a
 * layer's raster file; `null` for anything else.
 */
export const catalogRasterSource = (
  item: CatalogItem,
  base: string | undefined = GEOAPI_BASE_URL
): { tiles: string; tileset: string; coverage: string } | null => {
  if (!base || catalogKindOf(item, true) !== "raster") return null;
  const collection = catalogCollectionId(item.id);
  return {
    tiles: `${imageTilesetUrl(collection, base)}/{z}/{x}/{y}.webp`,
    tileset: imageTilesetUrl(collection, base),
    coverage: coverageUrl(collection, base),
  };
};

/**
 * What a mark can be drawn for. The catalog's five kinds, plus the three
 * things only Content holds — a project, a folder and a template have no
 * catalog kind, but they are marked from the same mapping so one type looks
 * the same on both pages.
 */
export type MarkKind = CatalogKind | "project" | "folder" | "template";

/** The subject of a mark: its kind, plus the shape detail a vector layer
 * states (`point` / `line` / `polygon`). */
export type MarkSubject = {
  kind: MarkKind;
  geometryType?: string | null;
};

/**
 * The one glyph mapping for a piece of content, wherever it is marked — a
 * catalog thumbnail, a feed card's placeholder, a list row's icon block, a
 * details panel. The most specific thing the caller knows wins: a table or a
 * raster is marked by its kind, a vector layer by its geometry, and anything
 * whose shape is genuinely unknown falls back to the generic layers glyph.
 */
export const markFor = ({ kind, geometryType }: MarkSubject): ICON_NAME => {
  if (kind === "folder") return ICON_NAME.FOLDER;
  if (kind === "project") return ICON_NAME.MAP;
  if (kind === "template") return ICON_NAME.CLONE;
  if (kind === "table") return ICON_NAME.TABLE;
  if (kind === "wms" || kind === "wmts") return ICON_NAME.WMS;
  if (kind === "raster") return ICON_NAME.RASTER;
  switch (geometryType) {
    case "point":
      return ICON_NAME.POINT_FEATURE;
    case "line":
      return ICON_NAME.LINE_FEATURE;
    case "polygon":
      return ICON_NAME.POLYGON_FEATURE;
    default:
      return ICON_NAME.LAYERS;
  }
};

/**
 * The palette keys a kind can be tinted with. `primary-dark` is the one that
 * is not a `<key>.main` colour — read every tone through `toneColorOf` rather
 * than indexing the palette directly.
 */
export type ContentTone = "primary" | "primary-dark" | "info" | "warning" | "secondary";

/**
 * The tone a kind carries wherever it is tinted — a list row's icon block, a
 * card with no picture of its own, a shortcut tile — so one kind looks the same
 * in every layout.
 *
 * A bundle takes `primary-dark` rather than `success`: `success` is a status
 * colour everywhere else in the app, and its green is close enough to the brand
 * mint that a bundle and a project were hard to tell apart in a mixed list.
 */
export const toneFor = (kind: MarkKind): ContentTone => {
  if (kind === "folder" || kind === "project") return "primary";
  if (kind === "bundle") return "primary-dark";
  if (kind === "raster" || kind === "wms" || kind === "wmts") return "warning";
  if (kind === "table" || kind === "template") return "secondary";
  return "info";
};

/** A tone's colour. The tinted ground behind it is `alpha(this, 0.12)`. */
export const toneColorOf = (theme: Theme, tone: ContentTone): string =>
  tone === "primary-dark" ? theme.palette.primary.dark : theme.palette[tone].main;

/** A typed bundle's type (`xplan`): such a dataset is added whole, never layer by layer. */
export const catalogBundleType = (collection: CatalogCollection): string | undefined => {
  const type = collection["goat:bundleType"]?.toLowerCase();
  return type && type !== "generic" ? type : undefined;
};
