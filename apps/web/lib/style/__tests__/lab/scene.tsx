// A lab scene: one GOAT Style drawn by the app's compiler and renderer on a real MapLibre map, with the app's legend
// beside it. One made-up feature per legend entry sits at a known pixel on a white ground without a basemap, so the
// checks can look at what is drawn there (a case with its own source, a raster's tiles, draws those instead); every
// error the page reports is kept.
import { ThemeProvider } from "@mui/material/styles";
import i18next from "i18next";
import { Map as MaplibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { render } from "vitest-browser-react";

// The app's text font (app/layout.tsx), from the repo's own files: the legend draws the same on every machine.
import "@p4b/ui/assets/fonts/mulish/font.css";
import { createAppTheme } from "@p4b/ui/theme/ThemeProvider";

import en from "@/i18n/locales/en/common.json";

import { compileLayer } from "@/lib/style/compile";
import type { CompileInput, CompiledLayer, FieldType, Geometry } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  type Legend,
  type LegendEntry,
  type Swatch,
  buildLegend,
  itemKey,
  listedRules,
} from "@/lib/style/legend";
import { applyCompiled } from "@/lib/style/render/apply";
import { MAPLIBRE_MAP_OPTIONS } from "@/lib/utils/map/maplibre";

import { StyleLegend } from "@/components/map/legend/StyleLegend";

import { sampleFor } from "../legend/samples";

/** Glyphs from the local fixtures the lab config serves. */
export const LAB_GLYPHS = "/lab-glyphs/{fontstack}/{range}.pbf";

const MAP = { width: 640, height: 480 };
/** The family the app sets on its page, which the legend's text inherits. */
export const LAB_FONT = "Mulish";
const LEGEND_WIDTH = 240;
/** Between the centers of two samples: far enough apart that no marker or label of one hides another's. */
const CELL = 96;
/** A line sample's length and a polygon sample's side, in pixels. */
export const SAMPLE_SIZE = 60;
/** How far from its pixel a group's points lie: well inside any merge distance. */
const GROUP_SPREAD = 8;
const SETTLE_TIMEOUT_MS = 10_000;

export interface LabCase {
  id: string;
  style: JsonObject;
  geometry: Geometry;
  zoom: number;
  fields: Record<string, FieldType>;
  /** Points placed in groups in place of one feature per legend entry (clusters, a heatmap). */
  groups?: LabGroup[];
  /** The data the style is compiled over in place of the scene's made-up features (a raster's tiles): the scene then
   * places no features. */
  source?: CompileInput["source"];
}

/** A feature made up for a legend entry, drawn at `pixel` with the GeoJSON id `featureId`. */
export interface PlacedSample {
  section: string;
  entry: LegendEntry;
  swatch: Swatch;
  pixel: [number, number];
  featureId: number;
}

export interface Scene {
  map: MaplibreMap;
  /** The map and the legend beside it. */
  root: HTMLElement;
  legend: Legend | null;
  placed: PlacedSample[];
  /** Map errors, console errors, failed requests and requests to another host, a scene that did not settle. */
  errors: string[];
  /** Every image the map asked for while drawing (missing style images). */
  requestedImages: string[];
  /** The style the scene draws. */
  style: JsonObject;
  /** What the scene compiled, and what that gave (null when compiling threw): a test compiles a changed style over the
   * same input and applies it over this. */
  input: CompileInput | null;
  compiled: CompiledLayer | null;
}

/** Points placed together at a pixel, one entry of properties per point (clusters). */
export interface LabGroup {
  at: [number, number];
  points: Array<Record<string, unknown>>;
}

const THEME = createAppTheme({ mode: "light", locale: "en" });

const WORDS = i18next.createInstance();
void WORDS.use(initReactI18next).init({
  lng: "en",
  ns: ["common"],
  defaultNS: "common",
  resources: { en: { common: en } },
  initImmediate: false,
  react: { useSuspense: false },
});

const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

const message = (value: unknown): string =>
  value instanceof Error ? value.message : typeof value === "string" ? value : String(value);

// console.error goes to every open scene's errors, and on to the console.
const consoleSinks = new Set<string[]>();
let consoleError: typeof console.error | undefined;

function listenToConsole(errors: string[]): void {
  if (!consoleSinks.size) {
    const original = console.error;
    consoleError = original;
    console.error = (...args: unknown[]) => {
      const text = args.map(message).join(" ");
      for (const sink of consoleSinks) sink.push(`console: ${text}`);
      original.apply(console, args);
    };
  }
  consoleSinks.add(errors);
}

function stopListeningToConsole(errors: string[]): void {
  consoleSinks.delete(errors);
  if (!consoleSinks.size && consoleError) {
    console.error = consoleError;
    consoleError = undefined;
  }
}

/** The properties of the feature an entry stands for: a classification's entry from `sampleFor`, the base look and
 * the features no rule matches without properties, a rule's entry from its `=` condition; null where none can be
 * made up (clusters, H3 cells, rules with other conditions). */
function propertiesFor(c: LabCase, section: string, entry: LegendEntry): Record<string, unknown> | null {
  if (section === "base" || entry.extra === "rest") return {};
  if (section === "rules") {
    // The rules the legend lists, keyed by their place among those.
    const rule = listedRules(c.style).find((r, i) => itemKey(r, i) === entry.id);
    const when = isObject(rule?.when) ? rule.when : {};
    const args = Array.isArray(when.args) ? when.args : [];
    if (when.op !== "=" || !isObject(args[0]) || typeof args[0].property !== "string") return null;
    return { [args[0].property]: args[1] };
  }
  const own = list(c.style.classify).find(
    (k) => (typeof k.id === "string" ? k.id : String(k.field)) === section
  );
  return own ? sampleFor(own, entry, c.fields[own.field as string]) : null;
}

/** The center of the `index`th cell of a grid over the map, row by row; none past its last cell. */
function cell(index: number): [number, number] | null {
  const cols = Math.floor(MAP.width / CELL);
  const rows = Math.floor(MAP.height / CELL);
  if (index >= cols * rows) return null;
  const left = (MAP.width - cols * CELL) / 2 + CELL / 2;
  const top = (MAP.height - rows * CELL) / 2 + CELL / 2;
  return [left + CELL * (index % cols), top + CELL * Math.floor(index / cols)];
}

/** A sample's geometry around a pixel: the point itself, a horizontal line through it, a square around it. */
function shapeAt(map: MaplibreMap, geometry: Geometry, [x, y]: [number, number]): GeoJSON.Geometry {
  const at = (px: number, py: number): [number, number] =>
    map.unproject([px, py]).toArray() as [number, number];
  const half = SAMPLE_SIZE / 2;
  if (geometry === "point") return { type: "Point", coordinates: at(x, y) };
  if (geometry === "line") return { type: "LineString", coordinates: [at(x - half, y), at(x + half, y)] };
  // Counterclockwise on the map: top left, bottom left, bottom right, top right.
  const ring = [
    at(x - half, y - half),
    at(x - half, y + half),
    at(x + half, y + half),
    at(x + half, y - half),
  ];
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

/** One feature per entry with a sample, placed on the grid; or the groups' features (points, or lines and squares
 * of the case's geometry), each group around its pixel. */
function features(
  c: LabCase,
  map: MaplibreMap,
  legend: Legend | null,
  groups: LabGroup[] | undefined,
  errors: string[]
): { collection: GeoJSON.FeatureCollection; placed: PlacedSample[] } {
  const out: GeoJSON.Feature[] = [];
  const placed: PlacedSample[] = [];
  const add = (geometry: GeoJSON.Geometry, properties: Record<string, unknown>): number => {
    const id = out.length + 1;
    out.push({ type: "Feature", id, geometry, properties });
    return id;
  };
  if (groups) {
    for (const group of groups) {
      const n = group.points.length;
      group.points.forEach((properties, k) => {
        // A sunflower spiral: every point at its own spot, all of them close to the group's pixel.
        const r = GROUP_SPREAD * Math.sqrt(k / n);
        const angle = k * 2.399963;
        const pixel: [number, number] = [
          group.at[0] + r * Math.cos(angle),
          group.at[1] + r * Math.sin(angle),
        ];
        add(shapeAt(map, c.geometry, pixel), properties);
      });
    }
    return { collection: { type: "FeatureCollection", features: out }, placed };
  }
  for (const section of legend?.sections ?? []) {
    if (section.kind !== "entries") continue;
    for (const entry of section.entries) {
      const properties = propertiesFor(c, section.id, entry);
      if (!properties) continue;
      const pixel = cell(placed.length);
      if (!pixel) {
        errors.push(`scene: no room on the map for ${section.id}/${entry.id}`);
        continue;
      }
      const featureId = add(shapeAt(map, c.geometry, pixel), properties);
      placed.push({ section: section.id, entry, swatch: entry.swatch, pixel, featureId });
    }
  }
  return { collection: { type: "FeatureCollection", features: out }, placed };
}

/** The next time the map is idle: after a frame drawn with every tile and image loaded. */
function idle(map: MaplibreMap): Promise<unknown> {
  const done = map.once("idle");
  map.triggerRepaint();
  return done;
}

/** The legend's library icons that do not load. The legend draws them as a CSS mask, whose loading no event
 * reports: each URL is loaded once more as a picture, which the browser answers from the same file. */
export async function markerIconFailures(root: HTMLElement): Promise<string[]> {
  const urls = new Set(
    [...root.querySelectorAll("[data-marker-icon]")].map((el) => el.getAttribute("data-marker-icon") ?? "")
  );
  const failed = await Promise.all(
    [...urls].map(
      (url) =>
        new Promise<string | null>((done) => {
          const picture = new Image();
          picture.onload = () => done(null);
          picture.onerror = () => done(`legend icon failed to load: ${url}`);
          picture.src = url;
        })
    )
  );
  return failed.filter((text): text is string => text !== null);
}

/** The legend's pictures that finished loading without anything to show: a failed request, or an answer the browser
 * cannot decode (which the request observer does not see when its status is 200). Worded as the scene's error
 * listener words a picture that fails. */
export function brokenPictures(root: HTMLElement): string[] {
  return [...root.querySelectorAll("img")]
    .filter((img) => img.complete && img.naturalWidth === 0)
    .map((img) => `img failed to load: ${img.src}`);
}

/** The weights of the lab's font the legend may draw in. */
const LAB_FONT_WEIGHTS = [300, 400, 500, 600, 700];

/** Loads every weight of the lab's font, so no text is drawn in a stand-in font: a font the page does not declare, or
 * a face whose file does not load, is an error. */
async function fontFailures(): Promise<string[]> {
  const failed = await Promise.all(
    LAB_FONT_WEIGHTS.map((weight) =>
      document.fonts.load(`${weight} 16px ${LAB_FONT}`).then(
        (faces) => (faces.length ? null : `font ${LAB_FONT} ${weight} is not on the page`),
        (error: unknown) => `font ${LAB_FONT} ${weight} failed to load: ${message(error)}`
      )
    )
  );
  return failed.filter((text): text is string => text !== null);
}

/** Waits until the map is idle, every image it asked for is added or failed, the legend's pictures and icons loaded
 * (an icon that fails is an error), and the page's fonts are loaded and ready. */
async function settle(
  map: MaplibreMap,
  root: HTMLElement,
  pending: Set<Promise<void>>,
  errors: string[]
): Promise<void> {
  await idle(map);
  while (pending.size) {
    await Promise.all([...pending]);
    await idle(map);
  }
  await Promise.all(
    [...root.querySelectorAll("img")].map((img) =>
      img.complete
        ? undefined
        : new Promise((done) => {
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          })
    )
  );
  // A picture that failed before the scene listened for it is reported here, once.
  errors.push(...brokenPictures(root).filter((text) => !errors.includes(text)));
  errors.push(...(await markerIconFailures(root)));
  errors.push(...(await fontFailures()));
  await document.fonts.ready;
}

const cleanups = new WeakMap<Scene, () => void>();

/** The legends of the scenes closed so far, taken off the page one after the other: React finishes that before the
 * next scene draws its own, or the two overlap and the next one renders nothing. */
let unmounting: Promise<void> = Promise.resolve();
/** Legends that failed to come off the page: errors of the next scene drawn. */
const unmountFailures: string[] = [];

/** Takes a closed scene's legend off the page after the ones closed before it; a failure is recorded, not thrown.
 * Exported for its test. */
export function queueUnmount(unmount: () => Promise<void>): void {
  unmounting = unmounting.then(unmount).catch((error: unknown) => {
    unmountFailures.push(`scene: the last scene's legend did not come off the page: ${message(error)}`);
  });
}

function SceneView({ legend, name }: { legend: Legend | null; name: string }) {
  return (
    <div
      data-lab-scene=""
      style={{
        display: "flex",
        alignItems: "flex-start",
        width: MAP.width + LEGEND_WIDTH,
        background: "#ffffff",
        fontFamily: LAB_FONT,
      }}>
      <div data-lab-map="" style={{ width: MAP.width, height: MAP.height, flex: "none" }} />
      <div data-lab-legend="" style={{ width: LEGEND_WIDTH, flex: "none" }}>
        {legend && (
          <ThemeProvider theme={THEME}>
            <I18nextProvider i18n={WORDS}>
              <StyleLegend legend={legend} layerName={name} />
            </I18nextProvider>
          </ThemeProvider>
        )}
      </div>
    </div>
  );
}

/** Draws a case and its legend and resolves once everything is drawn. `groups` (or the case's own) place their points
 * in place of the per-entry samples (clusters, a heatmap); a case's own `source` (a raster's tiles) is drawn in place
 * of any made-up features. `placed` then lists none. A case with both a source and groups is an error. */
export async function renderScene(c: LabCase, opts: { groups?: LabGroup[] } = {}): Promise<Scene> {
  await unmounting;
  const errors: string[] = unmountFailures.splice(0);
  const requestedImages: string[] = [];
  const started = performance.now();
  // What closes the scene, undone in reverse order; also when drawing it throws.
  const teardown: Array<() => void> = [];
  const close = () => {
    while (teardown.length) teardown.pop()!();
  };
  listenToConsole(errors);
  teardown.push(() => stopListeningToConsole(errors));

  // Requests the page makes from now on: one to another host, or one the lab's server fails, is an error.
  const recordRequests = (entries: PerformanceEntryList) => {
    for (const entry of entries) {
      if (entry.startTime < started) continue;
      const url = new URL(entry.name, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? 0;
      if (url.origin !== location.origin) errors.push(`request to another host: ${entry.name}`);
      else if (status >= 400) errors.push(`request failed (${status}): ${entry.name}`);
      // A same-origin entry always carries its HTTP status: none means the request ended without an answer (a
      // network error, a closed connection).
      else if (status === 0) errors.push(`request got no response: ${entry.name}`);
    }
  };
  const requests = new PerformanceObserver((found) => recordRequests(found.getEntries()));
  requests.observe({ type: "resource" });
  teardown.push(() => requests.disconnect());

  try {
    const legend = buildLegend(c.style, { geometry: c.geometry, zoom: c.zoom });
    const screen = await render(<SceneView legend={legend} name={c.id} />);
    teardown.push(() => queueUnmount(() => screen.unmount()));
    const root = screen.container.querySelector<HTMLElement>("[data-lab-scene]")!;
    // A picture in the legend that does not load.
    const onElementError = (event: Event) => {
      const target = event.target as { src?: string; tagName?: string } | null;
      errors.push(`${target?.tagName?.toLowerCase() ?? "element"} failed to load: ${target?.src ?? ""}`);
    };
    root.addEventListener("error", onElementError, true);
    teardown.push(() => root.removeEventListener("error", onElementError, true));

    const map = new MaplibreMap({
      ...MAPLIBRE_MAP_OPTIONS,
      container: root.querySelector<HTMLElement>("[data-lab-map]")!,
      center: [0, 0],
      zoom: c.zoom,
      attributionControl: false,
      fadeDuration: 0,
      // Keeps the frame in the drawing buffer after compositing, so its pixels can be read back.
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: {
        version: 8,
        glyphs: LAB_GLYPHS,
        sources: {},
        layers: [{ id: "ground", type: "background", paint: { "background-color": "#ffffff" } }],
      },
    });
    teardown.push(() => map.remove());
    map.on("error", (event) => errors.push(`map: ${message(event.error)}`));

    // The renderer installs one resolver for the images the map is missing; each image it is asked for is recorded,
    // and the scene waits for it.
    const pending = new Set<Promise<void>>();
    const request = (id: string) => {
      if (!requestedImages.includes(id)) requestedImages.push(id);
    };
    const setResolver = map.setMissingStyleImageResolver.bind(map);
    map.setMissingStyleImageResolver = (resolver) =>
      setResolver(
        resolver &&
          ((id: string) => {
            request(id);
            const done: Promise<void> = Promise.resolve()
              .then(() => resolver(id))
              .catch((error: unknown) => {
                errors.push(`image ${id}: ${message(error)}`);
              })
              .finally(() => pending.delete(done));
            pending.add(done);
            return done;
          })
      );
    map.on("styleimagemissing", (event) => request(event.id));

    const scene: Scene = {
      map,
      root,
      legend,
      placed: [],
      errors,
      requestedImages,
      style: c.style,
      input: null,
      compiled: null,
    };
    cleanups.set(scene, close);

    await map.once("load");
    let source = c.source;
    if (source && (opts.groups ?? c.groups))
      errors.push("scene: a case with its own source places no groups of points");
    if (!source) {
      const { collection, placed } = features(c, map, legend, opts.groups ?? c.groups, errors);
      scene.placed = placed;
      source = { type: "points", id: c.id, data: collection };
    }
    try {
      scene.input = {
        id: c.id,
        style: c.style as unknown as LayerStyle,
        geometry: c.geometry,
        fields: c.fields,
        source,
      };
      scene.compiled = compileLayer(scene.input);
      applyCompiled(map, null, scene.compiled);
    } catch (error) {
      errors.push(`scene: ${message(error)}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((done) => {
      timer = setTimeout(() => done("timeout"), SETTLE_TIMEOUT_MS);
    });
    if ((await Promise.race([settle(map, root, pending, errors), timeout])) === "timeout")
      errors.push(`scene: not settled after ${SETTLE_TIMEOUT_MS / 1000} s`);
    clearTimeout(timer);
    recordRequests(requests.takeRecords());
    return scene;
  } catch (error) {
    close();
    throw error;
  }
}

/** Takes the scene off the page and stops recording its errors. */
export function closeScene(scene: Scene): void {
  cleanups.get(scene)?.();
  cleanups.delete(scene);
}

/** Closes a test's scenes, the last drawn first, and returns every error they recorded, also those after the drawing:
 * MapLibre reports a style change it rejects or a worker that fails as an error event, not as a throw. */
export function closeScenes(scenes: Scene[]): string[] {
  const errors = scenes.flatMap((s) => s.errors);
  while (scenes.length) closeScene(scenes.pop()!);
  return errors;
}
