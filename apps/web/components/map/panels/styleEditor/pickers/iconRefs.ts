// Icon references of GOAT Style (spec 1) and today's Marker objects the icon gallery works with: library icons are
// `goat:<name>`, emoji `emoji:<code>`, uploads `asset:<id>`; URLs never go into a style.
import { useEffect, useState } from "react";

import { ASSETS_URL } from "@/lib/constants";
import { defaultResolveIcon } from "@/lib/style/compile/images";
import type { UploadedAsset } from "@/lib/validations/assets";
import type { Marker } from "@/lib/validations/layer";

import { useStyleData } from "@/components/map/panels/styleEditor/context";

/** The CSS background that shows an icon reference, or undefined when it does not resolve. */
export function iconBackground(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  const image = defaultResolveIcon(ref);
  return image ? `url("${image.url}") center / contain no-repeat` : undefined;
}

/** A library icon's shape: its viewBox and path data. */
export interface LibrarySymbol {
  viewBox: string;
  paths: readonly string[];
  evenodd?: boolean;
}

let symbols: Promise<ReadonlyMap<string, LibrarySymbol> | null> | null = null;
/** The library icons once their file has loaded (null when it did not), undefined before. */
let symbolsLoaded: ReadonlyMap<string, LibrarySymbol> | null | undefined;

/** The library icons from one file (`symbols.json`, written by scripts/generate-style-sources.mjs), loaded once when
 * first asked; null when it does not load. */
export function loadSymbols(): Promise<ReadonlyMap<string, LibrarySymbol> | null> {
  symbols ??= fetch(`${ASSETS_URL}/icons/maki/symbols.json`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data: { icons?: Record<string, LibrarySymbol> } | null) =>
      data?.icons ? new Map(Object.entries(data.icons)) : null
    )
    .catch(() => null)
    .then((found) => (symbolsLoaded = found));
  return symbols;
}

/** The library icons: undefined while they load, null when they did not; at once when they have loaded. */
export function useSymbols(): ReadonlyMap<string, LibrarySymbol> | null | undefined {
  const [loaded, setLoaded] = useState(() => symbolsLoaded);
  useEffect(() => {
    if (loaded !== undefined) return;
    let live = true;
    void loadSymbols().then((found) => live && setLoaded(found));
    return () => {
      live = false;
    };
  }, [loaded]);
  return loaded;
}

type EmojiCatalogue = typeof import("@/lib/style/generated/emoji");

let emoji: Promise<EmojiCatalogue> | null = null;
let emojiLoaded: EmojiCatalogue | null = null;

/** The emoji catalogue (a chunk of its own), loaded once, when first asked: by an emoji's name in the editor, or the
 * icon picker. */
export function loadEmoji(): Promise<EmojiCatalogue> {
  emoji ??= import("@/lib/style/generated/emoji").then((module) => (emojiLoaded = module));
  return emoji;
}

/** The emoji catalogue once loaded, else null: the emoji tab draws at once when it is. */
export const loadedEmoji = (): EmojiCatalogue | null => emojiLoaded;

let emojiNames: Promise<ReadonlyMap<string, string>> | null = null;

/** The emoji names by code, toned codes under their emoji's name; the catalogue loads once, when first asked. */
function loadEmojiNames(): Promise<ReadonlyMap<string, string>> {
  emojiNames ??= loadEmoji().then(({ EMOJI }) => {
    const names = new Map<string, string>();
    for (const e of EMOJI) {
      const name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
      names.set(e.code, name);
      e.tones?.forEach((code) => names.set(code, name));
    }
    return names;
  });
  return emojiNames;
}

/** The emoji names once loaded, while `needed` (an emoji is shown); null until then. */
export function useEmojiNames(needed: boolean): ReadonlyMap<string, string> | null {
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    if (!needed || names) return;
    let live = true;
    void loadEmojiNames().then((loaded) => live && setNames(loaded));
    return () => {
      live = false;
    };
  }, [needed, names]);
  return names;
}

/** The name of an icon reference: an upload's name, an emoji's name (from `emoji`, "Emoji" until it loads), or the
 * library name in words ("goat:star-solid" is "Star solid"). */
export function iconLabel(
  ref: string,
  uploads: UploadedAsset[],
  emoji?: ReadonlyMap<string, string> | null
): string {
  if (ref.startsWith("asset:")) return fromIconRef(ref, uploads)?.name ?? ref.slice("asset:".length);
  if (ref.startsWith("emoji:")) return emoji?.get(ref.slice("emoji:".length)) ?? "Emoji";
  const words = ref.replace(/^goat:/, "").replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Names icon references in `value` (one reference, or values by zoom): uploads by their names, emoji once their
 * names load. */
export function useIconLabel(value: unknown): (ref: string) => string {
  const { uploads } = useStyleData();
  const emoji = useEmojiNames(JSON.stringify(value ?? null).includes('"emoji:'));
  return (ref) => iconLabel(ref, uploads, emoji);
}

export const toIconRef = (marker: Marker): string =>
  marker.source === "custom" && marker.id ? `asset:${marker.id}` : `goat:${marker.name}`;

export function fromIconRef(ref: string, uploads: UploadedAsset[]): Marker | null {
  if (ref.startsWith("asset:")) {
    const asset = uploads.find((upload) => upload.id === ref.slice("asset:".length));
    return asset
      ? { id: asset.id, name: asset.display_name || asset.file_name, url: asset.url, source: "custom" }
      : null;
  }
  const library = ref.startsWith("goat:") ? defaultResolveIcon(ref) : null;
  return library ? { name: ref.slice("goat:".length), url: library.url, source: "library" } : null;
}
