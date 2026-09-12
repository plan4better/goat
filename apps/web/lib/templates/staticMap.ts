import { MAPTILER_KEY } from "@/lib/constants";
import type { TemplatePreviewViewState } from "@/lib/validations/template";

/**
 * A basemap frame for a layout's map element, as a `data:` URI.
 *
 * A template's frozen config carries no data layer bindings, so a map frame
 * in a thumbnail can only ever show the basemap — which is what this
 * fetches: one still image from MapTiler's static-maps endpoint, at the
 * element's own camera and pixel aspect.
 *
 * It comes back inlined rather than as a url because the stored PNG is
 * rasterised by loading the SVG through an `<img>`, which resolves nothing
 * external: an `<image href="https://…">` in that SVG draws nothing at all.
 */

/** How long a frame is waited for. A thumbnail is generated while its author
 * waits on a dialog, so a slow endpoint falls back to the placeholder map
 * rather than holding the save. */
export const STATIC_MAP_TIMEOUT = 4000;

/** The frame MapTiler is asked for, in the request's own pixels — `@2x`
 * doubles what comes back, so 1024 is a 2048px image, the endpoint's
 * ceiling. The floor is the smallest frame worth a request. */
export const STATIC_MAP_MAX_SIZE = 1024;
export const STATIC_MAP_MIN_SIZE = 16;

const round5 = (value: number): number => Math.round(value * 100000) / 100000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const clampSize = (value: number): number =>
  Math.min(Math.max(Math.round(value), STATIC_MAP_MIN_SIZE), STATIC_MAP_MAX_SIZE);

/** The style a thumbnail's map frame is drawn in.
 *
 * Pinned rather than read out of `BASEMAPS`, because none of the app's own
 * vector basemaps can serve this: they are OpenFreeMap styles, and
 * OpenFreeMap has no static-image endpoint. MapTiler stays the imagery
 * provider, so the key is configured anyway and this is one request per
 * distinct thumbnail camera.
 *
 * It is deliberately not the app's default (`light`): a pale style is meant
 * to sit under data overlays, and a template's map frame carries no overlay
 * at all, which left the frame looking like blank paper. This one still reads
 * as a map at thumbnail size. */
const STATIC_MAP_STYLE = "streets-v2";

/**
 * The MapTiler static-maps url for one camera at one pixel size, or null
 * where there is no frame to ask for: no key configured, or a box with no
 * area.
 *
 * The url is also the cache key — it carries the style, the centre, the zoom
 * and the size, which is everything the frame depends on.
 */
export const staticMapUrl = (
  view: TemplatePreviewViewState,
  size: { width: number; height: number }
): string | null => {
  if (!MAPTILER_KEY) return null;
  if (!(size.width > 0) || !(size.height > 0)) return null;
  const longitude = round5(view.longitude);
  const latitude = round5(view.latitude);
  const zoom = round2(view.zoom);
  const width = clampSize(size.width);
  const height = clampSize(size.height);
  // `attribution=0` suppresses the watermark MapTiler draws into the frame.
  // It is off only because a template thumbnail is a small derived preview
  // of the layout, where the watermark would be illegible: MapTiler's and
  // OpenStreetMap's terms still require the attribution to appear on the
  // surface that displays the map, and where that goes is a licensing
  // decision the product owner made rather than a technical default.
  return `https://api.maptiler.com/maps/${STATIC_MAP_STYLE}/static/${longitude},${latitude},${zoom}/${width}x${height}@2x.png?key=${MAPTILER_KEY}&attribution=0`;
};

/** The frames fetched in this session, keyed by their own url — so a card
 * band and the dialog's own preview of the same layout, and a second draw of
 * one template, cost one request between them. The pending promise is what
 * is kept, so two draws at once share the one request. */
const frames = new Map<string, Promise<string | null>>();

/** Forgets every fetched frame. */
export const clearStaticMapCache = (): void => {
  frames.clear();
};

/** The bytes as a `data:` URI. `FileReader` is what encodes them: it is the
 * one path to base64 every browser has, and it reads the blob's own media
 * type into the URI. Null where it could not read them. */
const dataUri = (blob: Blob): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

/** One request, abandoned after `STATIC_MAP_TIMEOUT`. Every failure — an
 * error status, a network refusal, the timeout, an empty body — comes back
 * as null, and the drawing keeps its placeholder map. */
const fetchFrame = async (url: string): Promise<string | null> => {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), STATIC_MAP_TIMEOUT);
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? await dataUri(blob) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The basemap frame for one camera at one pixel size, inlined as a `data:`
 * URI — or null where there is none to be had. Cached per url for the
 * session, failures included: a frame that could not be fetched once is not
 * asked for again while the page lives.
 */
export const loadStaticMapImage = (
  view: TemplatePreviewViewState,
  size: { width: number; height: number }
): Promise<string | null> => {
  const url = staticMapUrl(view, size);
  if (!url) return Promise.resolve(null);
  const pending = frames.get(url);
  if (pending) return pending;
  const request = fetchFrame(url);
  frames.set(url, request);
  return request;
};
