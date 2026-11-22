// A raster's values under the pointer, read from the value tiles the map loaded (raster/values.ts has their encoding):
// the code of the cell at a place, from the tile the map draws there, and the class or category that cell is drawn in;
// for colored tiles (an image, colors the raster service paints), the color of the pixel the map paints there.
// The tile under a place is the one of the map's covering tiles that holds it (`tileUnder`), picked as MapLibre picks
// the tiles of the value source, so a tilted map, terrain and the globe read the tile of the zoom drawn there. A read
// asks the browser's cache for it under the URL and the Accept header of the map's own request: tiles name their
// version, and a tile read without a sign-in (as the map reads them) is kept for good for a layer anyone may read and
// an hour otherwise, so a tile the map loaded is read from the cache. A tile geoapi let no cache keep
// (`no-store`, as one of another version) is asked for once more.
import { type RasterColorSpec, classReach } from "@/lib/style/raster/color";
import { type RasterValues, TILE_SIZE } from "@/lib/style/raster/values";

/** How a tile is read. */
export interface TileValueDeps {
  /** A tile's bytes; null when there is none (204) or the answer refuses it (4xx). Throws when there is no answer or
   * a failed one (5xx): the tile is asked for again a while later. */
  fetchTile: (url: string) => Promise<ArrayBuffer | null>;
  /** A tile image's pixels, red, green, blue and alpha exactly as stored; throws where they cannot be read exactly. */
  decode: (bytes: ArrayBuffer) => Promise<{ width: number; height: number; rgba: Uint8ClampedArray }>;
}

type Decoded = Awaited<ReturnType<TileValueDeps["decode"]>>;

/** How many decoded tiles are kept, those read last: a 512 px tile's pixels take 1 MB, and a full HD view shows
 * about 12. */
const KEPT_TILES = 24;
/** How long a tile without an answer, or with a failed one, reads as no value before it is asked for again. */
const RETRY_AFTER_MS = 30_000;
/** The zooms of a raster-dem source whose spec gives none (MapLibre's RasterDEMTileSource). */
const MIN_TILE_ZOOM = 0;
const MAX_TILE_ZOOM = 22;
/** Where Web Mercator's tiles end, north and south. */
const MAX_LATITUDE = 85.0511287798066;
/** The Accept header MapLibre sends for image tiles (util/image_request.ts `getImage`). */
const TILE_ACCEPT = "image/webp,*/*";

/** How the default decoding reads a tile image's pixels. */
export interface PixelReaders {
  /** A tile's image from its bytes. */
  image: (bytes: ArrayBuffer) => Promise<ImageBitmap>;
  /** Whether a 2D canvas reads back exactly the pixels drawn on it. */
  canvasExact: () => boolean;
  /** The pixels through a 2D canvas. */
  canvas: (image: ImageBitmap) => Uint8ClampedArray;
  /** The pixels through a video frame, where the browser has one. */
  videoFrame?: (image: ImageBitmap) => Promise<Uint8ClampedArray>;
}

/** Whether a 2D canvas reads back exactly what is drawn on it, by MapLibre's check (util/offscreen_canvas_distorted.ts):
 * browsers that resist fingerprinting (private windows, strict tracking protection) add noise to what a canvas reads
 * back. A 5 x 5 pattern in which byte i (alpha aside) holds i, read back. */
export function readsBackExactly(context: {
  fillStyle: unknown;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray };
}): boolean {
  const size = 5;
  for (let i = 0; i < size * size; i++) {
    const base = i * 4;
    context.fillStyle = `rgb(${base},${base + 1},${base + 2})`;
    context.fillRect(i % size, Math.floor(i / size), 1, 1);
  }
  return context.getImageData(0, 0, size, size).data.every((v, i) => i % 4 === 3 || v === i);
}

/** A 2D context to read pixels back from. */
const context2d = (width: number, height: number) => {
  const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read a value tile with.");
  return context;
};

let canvasExact: boolean | undefined;

/** The browser's readers. */
export const browserReaders: PixelReaders = {
  // No color profile is applied. The codes stay exact through a canvas, which keeps its colors premultiplied by alpha,
  // because value tiles are opaque (alpha 255).
  image: (bytes) =>
    createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" }),
  canvasExact() {
    // Once per page.
    canvasExact ??= readsBackExactly(context2d(5, 5));
    return canvasExact;
  },
  canvas(image) {
    const context = context2d(image.width, image.height);
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  },
  // As MapLibre reads elevation tiles where a canvas adds noise (util/util.ts `readImageUsingVideoFrame`).
  async videoFrame(image) {
    if (typeof VideoFrame === "undefined") throw new Error("No video frames to read a value tile with.");
    const frame = new VideoFrame(image, { timestamp: 0 });
    try {
      const format = frame.format;
      if (!format || !(format.startsWith("RGB") || format.startsWith("BGR")))
        throw new Error(`A video frame of format ${format} is not read.`);
      const { width, height } = image;
      const rgba = new Uint8ClampedArray(width * height * 4);
      await frame.copyTo(rgba, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }],
      });
      if (format.startsWith("BGR"))
        for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
      return rgba;
    } finally {
      frame.close();
    }
  },
};

/** A tile decoding with `readers`: through a canvas where it reads back exactly, else through a video frame; where
 * neither can, it throws, so the tile reads as no value rather than a wrong one. */
export function decodeWith(readers: PixelReaders): TileValueDeps["decode"] {
  return async (bytes) => {
    const image = await readers.image(bytes);
    try {
      const { width, height } = image;
      if (readers.canvasExact()) return { width, height, rgba: readers.canvas(image) };
      if (readers.videoFrame) return { width, height, rgba: await readers.videoFrame(image) };
      throw new Error("No exact way to read a value tile's pixels in this browser.");
    } finally {
      image.close();
    }
  };
}

const defaults: TileValueDeps = {
  async fetchTile(url) {
    // A kept answer however old: the URL names the tiles' version.
    const response = await fetch(url, { cache: "force-cache", headers: { accept: TILE_ACCEPT } });
    if (response.status >= 500) throw new Error(`The value tile answered ${response.status}.`);
    if (!response.ok || response.status === 204) return null;
    return response.arrayBuffer();
  },
  decode: decodeWith(browserReaders),
};

/** A tile that could not be read: no answer, a failed one, or pixels that cannot be read exactly. */
const UNREAD = "unread" as const;

/** A kept tile (null: there is none), and until when (ms since 1970) it is kept. */
interface Kept {
  tile: Promise<Decoded | null | typeof UNREAD>;
  until: number;
}

/** Decoded tiles by URL, the one read last at the end. A tile there is none of, or that cannot be decoded, is kept as
 * null too: hovering would ask for it again on every move. One without an answer or with a failed one is kept as null
 * for RETRY_AFTER_MS. */
const kept = new Map<string, Kept>();

/** The decoded tile at `url`; reads of a tile still loading share its one request and decoding. */
function tileAt(url: string, deps: TileValueDeps): Promise<Decoded | null | typeof UNREAD> {
  let entry = kept.get(url);
  if (!entry || entry.until <= Date.now()) {
    const fresh: Kept = { tile: Promise.resolve(null), until: Number.POSITIVE_INFINITY };
    fresh.tile = Promise.resolve()
      .then(() => deps.fetchTile(url))
      .then(
        (bytes) => (bytes ? deps.decode(bytes) : null),
        () => {
          fresh.until = Date.now() + RETRY_AFTER_MS;
          return UNREAD;
        }
      )
      .catch(() => UNREAD);
    entry = fresh;
  }
  kept.delete(url);
  kept.set(url, entry);
  if (kept.size > KEPT_TILES) kept.delete(kept.keys().next().value!);
  return entry.tile;
}

/** A tile of the map's tiling: its zoom, column and row. */
export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

/** The options MapLibre picks a raster source's tiles with (`coveringTiles`). */
export interface TileOptions {
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  roundZoom: boolean;
}

/** The options of the value tiles' source (compile/rasters.ts `valueSource`): its tile size, its zooms (the
 * description's native zoom, else MapLibre's defaults), and the rounded zoom of every raster source. */
export function valueTileOptions(values: RasterValues): TileOptions {
  return {
    tileSize: TILE_SIZE,
    minzoom: MIN_TILE_ZOOM,
    maxzoom: values.maxzoom ?? MAX_TILE_ZOOM,
    roundZoom: true,
  };
}

/** A covering tile as MapLibre gives one: its address, and the copy of the world it is drawn in. */
interface CoveringTile {
  canonical: TileAddress;
  wrap: number;
}

/** What `tileUnder` asks a map; MapLibre's `Map` has all of it. */
export interface TilesMap {
  coveringTiles(options: TileOptions & { terrain?: unknown }): ReadonlyArray<CoveringTile>;
  getZoom(): number;
  getCenter(): { lng: number; lat: number };
  getPitch(): number;
  getBearing(): number;
  getRoll(): number;
  getPadding(): unknown;
  getProjection(): unknown;
  getCenterElevation(): number;
  getVerticalFieldOfView(): number;
  getRenderWorldCopies(): boolean;
  /** The size MapLibre draws at: `resize()` sets it with the camera's, after the container changed. */
  getCanvas(): { width: number; height: number };
  terrain?: unknown;
  on(type: "render", listener: () => void): unknown;
}

/** A place in the world's tiling from its top left corner, a world wide (Web Mercator); x counts whole worlds east
 * or west of the first one. */
function mercator(lng: number, lat: number): { x: number; y: number } {
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

/** A map's covering tiles for a source's options, at the camera and size they were computed for. */
interface Covering {
  camera: string;
  terrain: unknown;
  tiles: ReadonlyArray<CoveringTile>;
}

const coverings = new WeakMap<TilesMap, Map<string, Covering>>();

/** A map's kept coverings by source options; registers the map's `render` listener once. The globe hands over to
 * Mercator by zoom, and the map applies that when it draws the next frame: coverings computed between a zoom change
 * and that frame are dropped then. */
function coveringsOf(map: TilesMap): Map<string, Covering> {
  let bySource = coverings.get(map);
  if (bySource) return bySource;
  const kept = (bySource = new Map<string, Covering>());
  coverings.set(map, kept);
  let zoom = map.getZoom();
  map.on("render", () => {
    if (map.getZoom() !== zoom) kept.clear();
    zoom = map.getZoom();
  });
  return kept;
}

/** The tiles MapLibre covers the map's view with for a source of `options`, computed once per camera: what
 * `coveringTiles` reads from the map's transform (zoom, center and its terrain height, pitch, bearing, roll, padding,
 * field of view, projection, world copies, and size as the canvas's, which `resize()` sets with it) and its terrain.
 * The terrain goes along, as MapLibre passes it for a source's tiles (`TileManager.update`); the public
 * `coveringTiles` hands its options on as they are. */
function coveringOf(map: TilesMap, options: TileOptions): ReadonlyArray<CoveringTile> {
  const center = map.getCenter();
  const canvas = map.getCanvas();
  const camera = JSON.stringify([
    map.getZoom(),
    center.lng,
    center.lat,
    map.getCenterElevation(),
    map.getPitch(),
    map.getBearing(),
    map.getRoll(),
    map.getPadding(),
    map.getVerticalFieldOfView(),
    map.getProjection(),
    map.getRenderWorldCopies(),
    canvas.width,
    canvas.height,
  ]);
  const source = JSON.stringify(options);
  const bySource = coveringsOf(map);
  const known = bySource.get(source);
  if (known && known.camera === camera && known.terrain === map.terrain) return known.tiles;
  const tiles = map.coveringTiles(map.terrain ? { ...options, terrain: map.terrain } : options);
  bySource.set(source, { camera, terrain: map.terrain, tiles });
  return tiles;
}

/** The tile MapLibre draws at `lngLat` for a source of `options`: the one of the map's covering tiles that holds it,
 * at its own zoom (a tilted map, terrain and the globe cover the view with several). A tile deeper than the source's
 * maxzoom stands for its ancestor there, which MapLibre loads and magnifies. Null where no covering tile holds the
 * place: off the map, or past its latitudes. */
export function tileUnder(
  map: TilesMap,
  options: TileOptions,
  lngLat: { lng: number; lat: number }
): TileAddress | null {
  if (!Number.isFinite(lngLat.lng) || !(Math.abs(lngLat.lat) < MAX_LATITUDE)) return null;
  const { x, y } = mercator(lngLat.lng, lngLat.lat);
  const holds = ({ canonical }: CoveringTile, px: number) => {
    const n = 2 ** canonical.z;
    const tx = px * n - canonical.x;
    const ty = y * n - canonical.y;
    return tx >= 0 && tx < 1 && ty >= 0 && ty < 1;
  };
  const tiles = coveringOf(map, options);
  // The tile in the copy of the world the place is given in, else in any copy.
  const found =
    tiles.find((tile) => holds(tile, x - tile.wrap)) ?? tiles.find((tile) => holds(tile, x - Math.floor(x)));
  if (!found) return null;
  const { z, x: column, y: row } = found.canonical;
  const deeper = Math.max(0, z - options.maxzoom);
  return { z: z - deeper, x: Math.floor(column / 2 ** deeper), y: Math.floor(row / 2 ** deeper) };
}

/** How far outside its tile a place may be found by rounding and still be read on it, in tiles. */
const EDGE = 1e-9;

/** The red, green, blue and alpha of the pixel at `lngLat` on the tiles of `tilesTemplate` (the URL template of the
 * map's source), read on `tile`: the tile the map draws there (`tileUnder`). Null outside `bounds` and the map's
 * latitudes, without a tile or on one that does not hold the place, and where there is no tile (204); `UNREAD` where
 * the tile failed or its pixels cannot be read exactly; never an error. */
async function pixelAt(
  bounds: [number, number, number, number] | undefined,
  tilesTemplate: string,
  lngLat: { lng: number; lat: number },
  tile: TileAddress | null,
  deps: Partial<TileValueDeps>
): Promise<Uint8ClampedArray | null | typeof UNREAD> {
  if (!tile) return null;
  // The map's copies of the world east and west of the first one.
  const lng = ((((lngLat.lng + 180) % 360) + 360) % 360) - 180;
  const { lat } = lngLat;
  if (!Number.isFinite(lng) || !(Math.abs(lat) < MAX_LATITUDE)) return null;
  if (bounds) {
    const [west, south, east, north] = bounds;
    if (lng < west || lng > east || lat < south || lat > north) return null;
  }
  // The place on the tile, from its top left corner, a tile wide.
  const n = 2 ** tile.z;
  const { x, y } = mercator(lng, lat);
  const tx = x * n - tile.x;
  const ty = y * n - tile.y;
  if (!(tx > -EDGE && tx < 1 + EDGE && ty > -EDGE && ty < 1 + EDGE)) return null;
  const url = tilesTemplate
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
  const decoded = await tileAt(url, {
    fetchTile: deps.fetchTile ?? defaults.fetchTile,
    decode: deps.decode ?? defaults.decode,
  });
  if (!decoded || decoded === UNREAD) return decoded;
  // The pixel on the tile's own picture: 512 px tiles as the map loads them, or any other width.
  const px = Math.min(Math.max(0, Math.floor(tx * decoded.width)), decoded.width - 1);
  const py = Math.min(Math.max(0, Math.floor(ty * decoded.height)), decoded.height - 1);
  const i = (py * decoded.width + px) * 4;
  return decoded.rgba.subarray(i, i + 4);
}

/** The value of the cell at `lngLat` on the value tiles of `tilesTemplate` (the URL template the map's source uses,
 * `valueTilesUrl`), read on `tile`: the tile the map draws there (`tileUnder`). Null for no data (code 0), outside the
 * file and the map's latitudes, without a tile or on one that does not hold the place, and where the tile is missing,
 * failed or its pixels cannot be read exactly; never an error. */
export async function tileValueAt(
  values: RasterValues,
  tilesTemplate: string,
  lngLat: { lng: number; lat: number },
  tile: TileAddress | null,
  deps: Partial<TileValueDeps> = {}
): Promise<number | null> {
  const pixel = await pixelAt(values.bounds, tilesTemplate, lngLat, tile, deps);
  if (!pixel || pixel === UNREAD) return null;
  const q = pixel[0] * 65536 + pixel[1] * 256 + pixel[2];
  if (q === 0) return null;
  return -values.encoding.baseShift + q * values.encoding.blueFactor;
}

/** A raster source as the map holds it (MapLibre's RasterTileSource, zooms filled in): its tiles' URL template, their
 * size, its zooms and the bounds it asks tiles in. */
export interface MapRasterSource {
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  bounds?: [number, number, number, number];
}

/** The options MapLibre picks a raster source's tiles with: its own size and zooms, and the rounded zoom of every
 * raster source. */
export function sourceTileOptions(source: MapRasterSource): TileOptions {
  return { tileSize: source.tileSize, minzoom: source.minzoom, maxzoom: source.maxzoom, roundZoom: true };
}

/** The red, green, blue and alpha of the pixel the map paints at `lngLat` on a raster source's colored tiles (an image,
 * colors the raster service paints), read on `tile`, the tile the map draws there (`tileUnder` with
 * `sourceTileOptions`): read as a value tile is, from the browser's cache under the source's URL. An opaque pixel comes
 * through a canvas exactly; a partly transparent one may not (a canvas keeps its colors premultiplied by alpha). Null
 * where nothing is painted: alpha 0 (no data, outside the file), no tile, outside the source or its tile; undefined
 * where the pixel could not be read (a tile that failed to load, or whose pixels this browser cannot read exactly). */
export async function tilePixelAt(
  source: MapRasterSource,
  lngLat: { lng: number; lat: number },
  tile: TileAddress | null,
  deps: Partial<TileValueDeps> = {}
): Promise<[number, number, number, number] | null | undefined> {
  const pixel = await pixelAt(source.bounds, source.tiles[0], lngLat, tile, deps);
  if (pixel === UNREAD) return undefined;
  return pixel && pixel[3] > 0 ? [pixel[0], pixel[1], pixel[2], pixel[3]] : null;
}

/** A coloring whose classes or categories may carry the style's names for them. The coloring geoapi gets
 * (`rasterColorSpec`, `rasterToken`) has none: a caller names them on a copy. */
type Named<S> = S extends { classes: Array<infer C> }
  ? Omit<S, "classes"> & { classes: Array<C & { name?: string }> }
  : S;
export type NamedRasterColorSpec = Named<RasterColorSpec>;

/** The class or category a value is drawn in, as the raster service colors it (goatlib.raster.color `colorize`):
 * classes are [from, to) and the first that holds the value wins, the first and last reaching as far as `outside` lets
 * them (`classReach`; `range`, the band's minimum and maximum, where the coloring has no domain); a category holds the
 * values that round to it. "other" for a value in no category that the other color draws; null for a value drawn in no
 * class (in none, in a hidden one, beyond the classes with values outside left out, or the style's no data) and for
 * colorings without classes (ramps, stops, images). */
export function rasterClassAt(
  spec: NamedRasterColorSpec,
  value: number,
  range?: readonly number[] | null
): { name?: string; color: string } | "other" | null {
  if (!Number.isFinite(value) || (spec.kind !== "classes" && spec.kind !== "categories")) return null;
  // The style's no data, with the service's tolerance.
  if (spec.noData.some((x) => Math.abs(value - x) <= 1e-6 * Math.max(1, Math.abs(x)))) return null;
  let found: (typeof spec.classes)[number] | undefined;
  if (spec.kind === "classes") {
    const reach = classReach(spec, range);
    found = spec.classes.find((_, i) => {
      const { from, to, closed } = reach[i];
      return (
        (from === undefined || value >= from) && (to === undefined || (closed ? value <= to : value < to))
      );
    });
  } else found = spec.classes.find((k) => k.value === Math.round(value));
  if (!found) return spec.kind === "categories" && spec.other !== null ? "other" : null;
  if (found.color === null) return null;
  return typeof found.name === "string" ? { name: found.name, color: found.color } : { color: found.color };
}
