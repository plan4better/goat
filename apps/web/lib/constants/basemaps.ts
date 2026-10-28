import { ASSETS_URL, MAPTILER_KEY } from "@/lib/constants";
import type { BuiltInBasemap } from "@/types/map/common";

export type Basemap = BuiltInBasemap;

/** An OpenFreeMap style, by name.
 *
 * OpenFreeMap serves the same OpenMapTiles 3.16 schema MapTiler Planet does,
 * so a style swap needs no change to anything reading the tiles: the
 * source-layer names and their `class`/`subclass` domains are identical, which
 * is what `classifyBasemapLayers` and every basemap-layer override key off.
 * The tiles, glyphs and sprite all come from this one host — behind the same
 * CDN as MapTiler, with the tile paths versioned per planet run and cached
 * immutably.
 *
 * Imagery stays on MapTiler: no free provider serves comparable resolution. */
const OFM_URL = "https://tiles.openfreemap.org";
const OFM_STYLE_URL = (style: string): string => `${OFM_URL}/styles/${style}`;

/** Glyphs for the styles GOAT builds itself (raster and solid basemaps), from the default basemaps' host. */
export const GLYPHS_URL = `${OFM_URL}/fonts/{fontstack}/{range}.pbf`;

/** GOAT's label fonts. Labels take their glyphs from the basemap's glyph server: OpenFreeMap's and basemap.de's both
 * serve Noto Sans (Roboto only basemap.de), and neither serves a combined font stack, so a label names one font. */
export const LABEL_FONT = "Noto Sans Regular";
export const LABEL_FONT_BOLD = "Noto Sans Bold";

/** MapTiler's imagery basemap, offered only when a MapTiler key is configured.
 * A project that saved it resolves to `DEFAULT_BASEMAP` without one. */
const MAPTILER_BASEMAPS: BuiltInBasemap[] = MAPTILER_KEY
  ? [
      {
        source: "builtin",
        type: "vector",
        value: "satellite",
        url: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
        title: "Satellite",
        subtitle: "As seen from space",
        thumbnail: "https://cloud.maptiler.com/static/img/maps/satellite.png",
      },
    ]
  : [];

export const BASEMAPS: BuiltInBasemap[] = [
  {
    source: "builtin",
    type: "vector",
    value: "streets",
    url: OFM_STYLE_URL("liberty"),
    title: "High Fidelity",
    subtitle: "Great for public presentations",
    thumbnail: "/assets/images/basemaps/liberty.png",
  },
  ...MAPTILER_BASEMAPS,
  {
    source: "builtin",
    type: "vector",
    value: "light",
    url: OFM_STYLE_URL("positron"),
    title: "Light",
    subtitle: "For highlighting data overlays",
    thumbnail: "/assets/images/basemaps/positron.png",
  },
  {
    source: "builtin",
    type: "vector",
    value: "dark",
    url: OFM_STYLE_URL("dark"),
    title: "Dark",
    subtitle: "For highlighting data overlays",
    thumbnail: "/assets/images/basemaps/dark.png",
  },
  {
    source: "builtin",
    type: "vector",
    value: "basemap_wld_col",
    url: `https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/styles/bm_web_wld_col.json`,
    title: "BKG Basemap",
    subtitle: "Color (World)",
    thumbnail: "https://basemap.de/viewer/assets/basemap_colour.png",
  },
  {
    source: "builtin",
    type: "vector",
    value: "basemap_de_gry",
    url: `https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/styles/bm_web_gry.json`,
    title: "BKG Basemap",
    subtitle: "Grayscale",
    thumbnail: "https://basemap.de/viewer/assets/basemap_greyscale.png",
  },
  {
    source: "builtin",
    type: "vector",
    value: "basemap_de_top",
    url: `https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/styles/bm_web_top.json`,
    title: "BKG Basemap",
    subtitle: "Topographic",
    thumbnail: "https://basemap.de/viewer/assets/basemap_hillshade.png",
  },
  {
    source: "builtin",
    type: "vector",
    value: "basemap_de_landuse",
    url: `${ASSETS_URL}/goat/basemaps/bm_web_col_landuse_plan4better.json`,
    title: "BKG Basemap",
    subtitle: "Landuse",
    thumbnail: "https://basemap.de/viewer/assets/basemap_hillshade.png",
  },
];

export const DEFAULT_BASEMAP = "light";

export function getBasemapUrl(basemap: string | null | undefined): string {
  const key = basemap || DEFAULT_BASEMAP;
  const found = BASEMAPS.find((b) => b.value === key);
  return found?.url || BASEMAPS.find((b) => b.value === DEFAULT_BASEMAP)!.url;
}

