"use client";

// The style panel's React bindings. The store, the layer's data and the map zoom travel in separate contexts, so a
// zoom change does not render every row; a row reads its value with useStyleValue and renders only when that value
// changes.
import type { Map as MaplibreMap } from "maplibre-gl";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";

import type { RasterError } from "@/lib/api/rasters";
import type { FieldType, Geometry } from "@/lib/style/compile/types";
import { scopedView } from "@/lib/style/editor/classify";
import type { EditorStore, Path, Scope } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type RasterInfo, type ValueSample, sampleOf } from "@/lib/style/raster/metadata";
import type { ServiceStyle } from "@/lib/utils/externalService";
import type { UploadedAsset } from "@/lib/validations/assets";

/** A field of the layer as the panel shows it; `label` is the dataset's display name. */
export interface FieldInfo {
  name: string;
  type: FieldType;
  label: string;
}

/** A field's short profile: the range of a number field, the first values of a text field and how many there are. */
export interface FieldProfile {
  min?: number;
  max?: number;
  values?: string[];
  count?: number;
}

/** Field profiles loaded on demand: `get` reads what has arrived, `load` asks once per field, `subscribe` tells when a
 * profile arrives. Its identity stays while profiles arrive, so an answer renders only the rows that read it. */
export interface ProfileSource {
  get: (field: string) => FieldProfile | undefined;
  load: (field: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export const EMPTY_PROFILES: ProfileSource = {
  get: () => undefined,
  load: () => undefined,
  subscribe: () => () => undefined,
};

/** A style the service offers (WMS `Style`, WMTS `Style`), from its capabilities. */
export type { ServiceStyle } from "@/lib/utils/externalService";

/** What the panel knows about the layer's data. Histograms and value lists come from their hooks with `layerId`. */
export interface StyleData {
  layerId: string;
  /** The layer's name: the legend title when the style gives none. */
  layerName?: string;
  geometry?: Geometry;
  fields: FieldInfo[];
  fieldTypes: Record<string, FieldType>;
  /** The field's profile once loaded; asking starts the request (once per field). Rows that must follow an answer
   * read it with useFieldProfile. */
  profile: (field: string) => FieldProfile | undefined;
  profiles: ProfileSource;
  /** A raster file: its dataset and, once the raster service answered, its bands, no data, color table and band
   * statistics, or why it could not read the file. */
  raster?: { dataset: string; info?: RasterInfo; error?: RasterError };
  /** A map service: how many of its layers this layer draws, the styles it offers, its legend image. */
  service?: {
    kind: "wms" | "wmts" | "xyz";
    url: string;
    layers: number;
    layerNames: string[];
    styles: ServiceStyle[];
    legendUrl?: string;
  };
  /** The first feature's properties, for previews. */
  sample?: Record<string, unknown>;
  featureCount?: number;
  uploads: UploadedAsset[];
}

export const EMPTY_DATA: StyleData = {
  layerId: "",
  fields: [],
  fieldTypes: {},
  profile: () => undefined,
  profiles: EMPTY_PROFILES,
  uploads: [],
};

const StoreContext = createContext<EditorStore | null>(null);
const DataContext = createContext<StyleData>(EMPTY_DATA);
const ZoomContext = createContext<number>(0);
const MapContext = createContext<MaplibreMap | null>(null);

export function StyleEditorProvider({
  store,
  data,
  mapZoom,
  map = null,
  children,
}: {
  store: EditorStore;
  data: StyleData;
  mapZoom: number;
  /** The map the layer is drawn on: raster editors read cell values in its view. */
  map?: MaplibreMap | null;
  children: ReactNode;
}) {
  return (
    <StoreContext.Provider value={store}>
      <DataContext.Provider value={data}>
        <MapContext.Provider value={map}>
          <ZoomContext.Provider value={mapZoom}>{children}</ZoomContext.Provider>
        </MapContext.Provider>
      </DataContext.Provider>
    </StoreContext.Provider>
  );
}

export const useEditorMap = (): MaplibreMap | null => useContext(MapContext);

/** A band's values from the raster service's statistics (its 2nd to 98th percentile and distinct values); null
 * before the info arrived or for a band without values. */
export function useRasterSample(): (band: number) => Promise<ValueSample | null> {
  const info = useStyleData().raster?.info;
  return useCallback(async (band: number) => sampleOf(info, band), [info]);
}

export function useEditor(): EditorStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useEditor needs a StyleEditorProvider");
  return store;
}

/** A value derived from the document; the component renders again only when it changes (compared with Object.is:
 * derive a string or a number, not a new object). */
export function useStyleSelector<T extends string | number | boolean | undefined>(
  select: (doc: LayerStyle) => T
): T {
  const store = useEditor();
  const read = () => select(store.document);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The value at `path`; the component renders again only when it changes. */
export function useStyleValue<T = unknown>(path: Path): T {
  const store = useEditor();
  const read = () => store.get(path) as T;
  return useSyncExternalStore(store.subscribe, read, read);
}

export const useStyleData = (): StyleData => useContext(DataContext);

export const useMapZoom = (): number => useContext(ZoomContext);

/** The map zoom while the map zooms, for marks that follow the map: rendered within the map's own zoom event, so a mark
 * paints in the same frame as the map; the panel's zoom (which changes when the map stops) before the map moves or
 * without a map. */
export function useLiveMapZoom(): number {
  const map = useEditorMap();
  const settled = useMapZoom();
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    if (!map) return;
    const onZoom = () => flushSync(() => setLive(map.getZoom()));
    map.on("zoom", onZoom);
    return () => void map.off("zoom", onZoom);
  }, [map]);
  return live ?? settled;
}

/** Moves the map to a zoom: smoothly for a press, at once while a pointer is dragged; undefined without a map. */
export function useZoomTo(): ((zoom: number, animate: boolean) => void) | undefined {
  const map = useEditorMap();
  return useMemo(
    () =>
      map
        ? (zoom: number, animate: boolean) => (animate ? map.easeTo({ zoom }) : map.jumpTo({ zoom }))
        : undefined,
    [map]
  );
}

/** A field's profile, rendering again when it arrives; `load: false` only reads one that is already there. */
export function useFieldProfile(field: string | undefined, { load = true } = {}): FieldProfile | undefined {
  const { profiles } = useStyleData();
  useEffect(() => {
    if (field && load) profiles.load(field);
  }, [profiles, field, load]);
  const read = () => (field ? profiles.get(field) : undefined);
  return useSyncExternalStore(profiles.subscribe, read, read);
}

/** The class the panel edits on its own, or null for all features. */
export function useScope(): Scope | null {
  const store = useEditor();
  const read = () => store.scope;
  return useSyncExternalStore(store.subscribe, read, read);
}

export interface Scoped {
  /** The value as drawn: in class scope, the class's own value or the base's. */
  value: unknown;
  /** Where an edit goes: the class record in scope, else the path itself. */
  writePath: Path;
  /** In scope: the class sets this value itself. */
  overridden: boolean;
  scoped: boolean;
}

/** A symbol path seen through the class scope. */
export function useScoped(path: Path): Scoped {
  const store = useEditor();
  const scope = useScope();
  const base = useStyleValue(path);
  const view = scope ? scopedView(store.document, scope) : null;
  const writePath = view ? view.writePath(path) : path;
  // The class's own value: a row renders again when the record changes.
  useStyleValue(writePath);
  // Only the symbol varies per class; layer keys (opacity, zooms, order) stay the layer's.
  if (!view || !path.startsWith("symbol."))
    return { value: base, writePath: path, overridden: false, scoped: false };
  return { value: view.read(path), writePath, overridden: view.overridden(path), scoped: true };
}
