export type MapLoc = {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

type LocInput = {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
};

const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));

const normalizeBearing = (bearing: number): number => ((bearing % 360) + 360) % 360;

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

const parseNumber = (token: string): number => (NUMBER_PATTERN.test(token) ? Number(token) : NaN);

export function serializeLoc(loc: LocInput): string {
  const parts = [`${round(loc.latitude, 5)}`, `${round(loc.longitude, 5)}`, `${round(loc.zoom, 2)}z`];
  const bearing = normalizeBearing(round(normalizeBearing(loc.bearing ?? 0), 1));
  if (bearing !== 0) {
    parts.push(`${bearing}b`);
  }
  const pitch = round(loc.pitch ?? 0, 1);
  if (pitch !== 0) {
    parts.push(`${pitch}p`);
  }
  return parts.join(",");
}

export function parseLoc(raw: string | null | undefined): MapLoc | null {
  if (!raw) return null;
  const tokens = raw.split(",");
  if (tokens.length < 3 || tokens.length > 5) return null;
  const latitude = parseNumber(tokens[0]);
  const longitude = parseNumber(tokens[1]);
  const zoomToken = tokens[2].endsWith("z") ? tokens[2].slice(0, -1) : tokens[2];
  const zoom = parseNumber(zoomToken);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 24) return null;
  let bearing: number | undefined;
  let pitch: number | undefined;
  for (const token of tokens.slice(3)) {
    const value = parseNumber(token.slice(0, -1));
    if (!Number.isFinite(value)) return null;
    const suffix = token.slice(-1);
    if (suffix === "b") {
      if (bearing !== undefined) return null;
      bearing = normalizeBearing(value);
    } else if (suffix === "p") {
      if (pitch !== undefined) return null;
      if (value < 0 || value > 60) return null;
      pitch = value;
    } else {
      return null;
    }
  }
  return { latitude, longitude, zoom, bearing: bearing ?? 0, pitch: pitch ?? 0 };
}

export function getLocFromUrl(): MapLoc | null {
  if (typeof window === "undefined") return null;
  return parseLoc(new URLSearchParams(window.location.search).get("loc"));
}

export function writeLocToUrl(loc: LocInput): void {
  if (typeof window === "undefined") return;
  if (
    !Number.isFinite(loc.latitude) ||
    !Number.isFinite(loc.longitude) ||
    !Number.isFinite(loc.zoom) ||
    !Number.isFinite(loc.bearing ?? 0) ||
    !Number.isFinite(loc.pitch ?? 0)
  ) {
    return;
  }
  const url = new URL(window.location.href);
  const serialized = serializeLoc(loc);
  url.searchParams.set("loc", serialized);
  // Keep the loc value Felt-style readable (commas, not %2C) without touching
  // the encoding of any other param.
  url.search = url.searchParams.toString().replace(encodeURIComponent(serialized), serialized);
  window.history.replaceState(window.history.state, "", url.toString());
}

type MapCameraSource = {
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  getBearing: () => number;
  getPitch: () => number;
};

export function writeMapLocToUrl(map: MapCameraSource): void {
  writeLocToUrl({
    latitude: map.getCenter().lat,
    longitude: map.getCenter().lng,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  });
}

/** A public viewer's choice of named styles, by project layer id (`styles=<layer>:<style>,…`): view
 * state that travels with the link, never written to the project. */
export function getStylesFromUrl(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = new URLSearchParams(window.location.search).get("styles");
  const choices: Record<string, string> = {};
  for (const pair of raw?.split(",") ?? []) {
    const [layer, style] = pair.split(":");
    if (/^\d+$/.test(layer ?? "") && style) choices[layer] = style;
  }
  return choices;
}

export function writeStylesToUrl(choices: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const value = Object.entries(choices)
    .map(([layer, style]) => `${layer}:${style}`)
    .join(",");
  if (value) url.searchParams.set("styles", value);
  else url.searchParams.delete("styles");
  // Readable like loc: commas and colons stay as they are.
  url.search = url.searchParams.toString().replace(/%2C/g, ",").replace(/%3A/g, ":");
  window.history.replaceState(window.history.state, "", url.toString());
}
