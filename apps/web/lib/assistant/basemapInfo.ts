import type { BasemapInfo } from "@/lib/assistant/types";
import { isImageryBasemap } from "@/lib/scene/auto";
import { basemapTone } from "@/lib/style/tone";

import type { Basemap } from "@/types/map/common";

/** The most basemaps the page context lists (the server refuses more). */
export const MAX_BASEMAPS = 30;
const MAX_ID = 64;
const MAX_NAME = 80;

// The server counts characters as code points; a UTF-16 slice could split one.
const length = (text: string) => Array.from(text).length;
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("");

/**
 * A basemap for the page context: its id, its name cut to 80 characters, whether it is imagery, and its tone, the one
 * the layers' automatic colors take (`basemapTone`).
 */
export function basemapInfo(basemap: Basemap): BasemapInfo {
  const imagery = isImageryBasemap(basemap);
  const name = basemap.source === "builtin" ? basemap.title : basemap.name;
  return {
    id: basemap.value,
    name: cut(name.trim(), MAX_NAME),
    tone: basemapTone(basemap),
    imagery,
  };
}

/** Whether the server accepts the entry: an id of at most 64 characters and a name that is not empty. */
export const acceptedBasemap = (info: BasemapInfo): boolean =>
  info.id.length > 0 && length(info.id) <= MAX_ID && info.name.length > 0 && length(info.name) <= MAX_NAME;

/** The basemaps the project offers, built-in first, then its own; entries the server would refuse are left out. */
export function offeredBasemaps(builtIn: Basemap[], custom: Basemap[]): BasemapInfo[] {
  return [...builtIn, ...custom]
    .map((basemap) => basemapInfo(basemap))
    .filter(acceptedBasemap)
    .slice(0, MAX_BASEMAPS);
}
