import type { MapRef } from "react-map-gl/maplibre";


// Track which image name→url is already loaded (and in-flight) per map, so that
// repeated loadImage() calls — panel re-renders, layer toggles, duplicate
// map-load handlers — don't refetch and re-decode an icon that's already on the
// map. Keyed by the underlying maplibre Map (survives MapRef identity changes,
// GC'd with the map). Presence is gated by hasImage() so a basemap style swap
// (which wipes all images) still triggers a reload; a changed url also reloads.
const loadedImageUrls = new WeakMap<object, Map<string, string>>();
const inFlightImageLoads = new WeakMap<object, Map<string, { url: string; done: Promise<void> }>>();

function trackFor<V>(store: WeakMap<object, Map<string, V>>, key: object): Map<string, V> {
  let m = store.get(key);
  if (!m) {
    m = new Map();
    store.set(key, m);
  }
  return m;
}

/**
 * Load image from url and adds or updates the map with the image
 * @param map MapRef
 * @param url string
 * @param marker_name string
 * @param width number
 * @param height number
 * @param sdf boolean
 * @returns a promise that settles once the image is on the map or failed to load
 */
export const loadImage = (
  map: MapRef | null | undefined,
  url: string,
  marker_name: string,
  sdf?: boolean,
  targetWidth = 200, // default
  targetHeight = 200, // default
  /** Draw at this pixel ratio instead of the screen's (GOAT Style images are drawn at 4 for sharp scaling). */
  imagePixelRatio?: number
): Promise<void> => {
  if (!map) return Promise.resolve();

  // Idempotency guard: skip if this exact image (name→url) is already on the map
  // or currently loading. A style-swap wipe (hasImage false) or a url change
  // both fall through and reload.
  const glMap = (typeof map.getMap === "function" ? map.getMap() : map) as object;
  const loaded = trackFor(loadedImageUrls, glMap);
  const inFlight = trackFor(inFlightImageLoads, glMap);
  let present = false;
  try {
    present = !!map.hasImage(marker_name);
  } catch {
    present = false;
  }
  if (present && loaded.get(marker_name) === url) return Promise.resolve();
  const pending = inFlight.get(marker_name);
  if (pending?.url === url) return pending.done;

  const addOrUpdateImage = (
    image:
      | HTMLImageElement
      | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }
      | ImageData
      | ImageBitmap,
    pixelRatio?: number
  ) => {
    // Check if map exists and is ready (style loaded)
    if (!map) return;
    try {
      // The map might not be ready yet or could have been unmounted
      // hasImage/removeImage/addImage require the style to be loaded
      if (map.hasImage(marker_name)) {
        map.removeImage(marker_name);
      }
      map.addImage(marker_name, image, { sdf: sdf ?? true, pixelRatio: pixelRatio ?? 1 });
      loaded.set(marker_name, url);
    } catch (error) {
      // Map may have been unmounted or style not loaded yet - ignore silently
      console.debug(`Failed to add/update map image "${marker_name}":`, error);
    }
  };

  const rasterizeToCanvas = (img: HTMLImageElement, targetW: number, targetH: number) => {
    // Cap at 2 to prevent print contexts (DPI 300+ → devicePixelRatio 3.125+) from inflating icons
    const pixelRatio = imagePixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = targetW * pixelRatio;
    canvas.height = targetH * pixelRatio;

    const context = canvas.getContext("2d");
    if (context) {
      context.scale(pixelRatio, pixelRatio);
      context.imageSmoothingEnabled = true;
      context.drawImage(img, 0, 0, targetW, targetH);

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      addOrUpdateImage(
        {
          width: canvas.width,
          height: canvas.height,
          data: new Uint8Array(imageData.data.buffer),
        },
        pixelRatio
      );
    }
  };

  // Create an Image object for all formats the browser supports
  const done = new Promise<void>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        rasterizeToCanvas(img, targetWidth, targetHeight);
      } finally {
        resolve();
      }
    };
    img.onerror = (err) => {
      console.error(`Failed to load image: ${url}`, err);
      resolve();
    };
    img.src = url;
  }).finally(() => {
    if (inFlight.get(marker_name)?.done === done) inFlight.delete(marker_name);
  });
  inFlight.set(marker_name, { url, done });
  return done;
};
