import { cogProtocol } from "@geomatico/maplibre-cog-protocol";
import { addProtocol, getVersion, setWorkerUrl } from "maplibre-gl";

// Setup shared by every map. A component that renders a react-map-gl <Map>
// spreads MAPLIBRE_MAP_OPTIONS into it, and importing this module runs the
// setup before the first map is created.

// MapLibre's worker is an ES module located through a URL MapLibre builds at
// runtime, which no bundler follows. next.config.js copies it into
// public/vendor/maplibre when a dev server or a build starts. The version
// in the query keeps a browser from running a cached worker of an older
// MapLibre after an upgrade. The path must stay outside /map*, which the auth
// middleware protects by prefix: public dashboards and the print renderer load
// the worker without a session.
setWorkerUrl(`/vendor/maplibre/maplibre-gl-worker.mjs?v=${getVersion()}`);

// The Add Layer preview of a COG address that is no layer yet reads the file as a cog:// URL; raster layers are drawn
// by geoapi's raster service, which opens only addresses a layer stores.
addProtocol("cog", cogProtocol);

/**
 * Options every map passes. `zoomLevelsToOverscale: undefined` keeps vector
 * tiles overscaled past their maxzoom, as before MapLibre 6; its default
 * slices them instead, which moves labels and changes what a click hits.
 */
export const MAPLIBRE_MAP_OPTIONS = {
  zoomLevelsToOverscale: undefined,
} as const;
