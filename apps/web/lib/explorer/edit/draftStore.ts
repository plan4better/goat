/**
 * What the map draws of the edit being made, beside the panel that words it:
 * the paths a stop being moved would take (2.2). Set by the draft's hook
 * (useDraftEdit), read by the map's editing layers; outside Redux, as the
 * paths are geometry. Each new path is dotted in its line's colour; the
 * path it replaces is drawn in its stead, faint where it is drawn anew.
 * While that shows, the network's layers fade every other line and leave
 * the replaced paths out (`previewedStore`, set by the editing layers, which
 * know when it shows).
 */
import type { FeatureCollection, LineString } from "geojson";

/** A new path, or the part of the old one it keeps or replaces. */
export type DraftPathKind = "new" | "kept" | "replaced";

export type DraftPaths = FeatureCollection<LineString, { kind: DraftPathKind; color: string }>;

const NO_PATHS: DraftPaths = { type: "FeatureCollection", features: [] };
const NONE: string[] = [];

let paths: DraftPaths = NO_PATHS;
/** The shape ids of the paths drawn anew in place. */
let replaces: string[] = NONE;
const listeners = new Set<() => void>();

export const draftPathsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): DraftPaths {
    return paths;
  },
  replaces(): string[] {
    return replaces;
  },
  set(next: DraftPaths | null, replacing: string[] = NONE): void {
    paths = next ?? NO_PATHS;
    replaces = next && replacing.length ? replacing : NONE;
    listeners.forEach((l) => l());
  },
};

/** While the preview shows: the shape ids it draws in the network's stead. */
export type Previewed = { replaces: string[] } | null;

let previewed: Previewed = null;
const previewedListeners = new Set<() => void>();

export const previewedStore = {
  subscribe(listener: () => void): () => void {
    previewedListeners.add(listener);
    return () => previewedListeners.delete(listener);
  },
  getSnapshot(): Previewed {
    return previewed;
  },
  set(next: string[] | null): void {
    const was = previewed?.replaces;
    if (next === null ? !previewed : was && next.length === was.length && next.every((x, k) => x === was[k]))
      return;
    previewed = next && { replaces: next };
    previewedListeners.forEach((l) => l());
  },
};
