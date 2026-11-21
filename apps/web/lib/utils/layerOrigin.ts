/**
 * Where a layer's data comes from, as the Metadata tab and the dataset detail tell it: the catalog, a raster file someone
 * added by its address, a map service, or a WFS whose features were copied into GOAT. Every other layer (an upload, a
 * drawn layer, a table, a tool's output, a raster GOAT stores) has nothing to say here.
 *
 * Only an address someone typed is ever shown. A layer's `url` is that address for a remote raster file or a map
 * service, and a WFS copy keeps the service's address in `other_properties.url`; GOAT's own copies have none (a catalog
 * raster is read by its layer id from storage, its `url` empty), and only an http(s) address counts, so a storage path
 * can never reach a view.
 */
import { isCatalogLayer } from "@/lib/utils/catalog-layer";

export type MapServiceKind = "wms" | "wmts" | "xyz";

export type LayerOrigin =
  | { kind: "catalog" }
  | { kind: "remote_file"; format: string; url: string }
  | { kind: "map_service"; service: MapServiceKind; url: string }
  | { kind: "wfs_copy"; url: string };

/** An origin with an address to show: all but the catalog's. */
export type AddressedOrigin = Exclude<LayerOrigin, { kind: "catalog" }>;

type WithoutUrl<T> = T extends unknown ? Omit<T, "url"> : never;

/** What a Source row says, without the address: what the content feed knows of a layer. */
export type LayerSource = WithoutUrl<LayerOrigin>;

interface OriginLayer {
  type?: string | null;
  data_type?: string | null;
  url?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  other_properties?: Record<string, any> | null;
}

const SERVICES: readonly MapServiceKind[] = ["wms", "wmts", "xyz"];

const isWebAddress = (url: unknown): url is string =>
  typeof url === "string" && /^https?:\/\/[^/?#]/i.test(url);

/**
 * The one rule, over what is known of a layer: its format, whether it is drawn from an address, and whether a WFS copy
 * names the service it came from.
 */
function sourceOf(
  dataType: string | null | undefined,
  linked: boolean,
  copied: boolean
): LayerSource | undefined {
  if (dataType === "wfs") return copied ? { kind: "wfs_copy" } : undefined;
  if (!linked) return undefined;
  if (dataType === "cog") return { kind: "remote_file", format: dataType };
  const service = SERVICES.find((kind) => kind === dataType);
  return service ? { kind: "map_service", service } : undefined;
}

/** Where the layer's data comes from; undefined when there is nothing to say. */
export function layerOrigin(layer: OriginLayer): LayerOrigin | undefined {
  if (isCatalogLayer(layer)) return { kind: "catalog" };
  const copiedFrom = [layer.other_properties?.url, layer.url].find(isWebAddress);
  const linkedAt = layer.type === "raster" && isWebAddress(layer.url) ? layer.url : undefined;
  const source = sourceOf(layer.data_type, !!linkedAt, !!copiedFrom);
  if (source?.kind === "wfs_copy") return copiedFrom ? { ...source, url: copiedFrom } : undefined;
  if (source?.kind === "remote_file" || source?.kind === "map_service")
    return linkedAt ? { ...source, url: linkedAt } : undefined;
  return undefined;
}

/**
 * The same rule over the three facts the content feed sends for a layer: its format, whether it is linked (it has a
 * stored address), and the host it is drawn or was copied from. Core names a host only for an http(s) address, so
 * asking for one is the layer rule's http(s) check: a stored storage path (`s3://...`) arrives without a host and says
 * nothing. The feed sends the host alone, so there is no address.
 */
export function feedSource(item: {
  data_type?: string | null;
  is_linked?: boolean | null;
  source_host?: string | null;
}): LayerSource | undefined {
  const webHost = !!item.source_host;
  return sourceOf(item.data_type, !!item.is_linked && webHost, webHost);
}

/** Whether the origin has an address to show. */
export const hasAddress = (origin: LayerOrigin | undefined): origin is AddressedOrigin =>
  !!origin && origin.kind !== "catalog";

/** What the Source row says, the same in every view: "Remote file (COG)", "Map service (WMS)", "Copied from WFS". */
export function sourceLabel(
  source: LayerOrigin | LayerSource,
  t: (key: string, values?: Record<string, string>) => string
): string {
  switch (source.kind) {
    case "catalog":
      return t("catalog");
    case "remote_file":
      return t("metadata.source_remote_file", { kind: source.format.toUpperCase() });
    case "map_service":
      return t("metadata.source_map_service", { kind: source.service.toUpperCase() });
    case "wfs_copy":
      return t("metadata.source_wfs_copy");
  }
}

/** The address without its query string and fragment. Cut as text, not parsed: a template's placeholders stay. */
export const withoutQuery = (address: string): string => address.split(/[?#]/)[0];

/**
 * The address as this person sees it: an editor the whole of it, anyone else without its query string, fragment and
 * a user and password before the host, where a key or a signature may sit (core's `address_shown` does the same).
 */
export function addressShownTo(url: string, whole: boolean): string {
  if (whole) return url;
  const base = withoutQuery(url);
  const authority = /^(https?:\/\/)([^/]*)/i.exec(base);
  if (!authority) return base;
  const [prefix, scheme, hostPart] = authority;
  return `${scheme}${hostPart.slice(hostPart.lastIndexOf("@") + 1)}${base.slice(prefix.length)}`;
}

/**
 * Control, invisible, blank and direction characters, and line breaks: decoded, they could hide, reverse or split part
 * of a name. Written out, as the build target allows no `\p{...}`: C0 and C1 controls, the soft hyphen, the combining
 * grapheme joiner, the Arabic letter mark, the Hangul fillers, the Mongolian vowel separator, the spaces U+2000 to
 * U+200A, zero-width and direction marks, line and paragraph separators, embeddings and overrides, the narrow
 * no-break and the medium mathematical spaces, invisible operators and isolates, the ideographic space, variation
 * selectors, the byte order mark, interlinear annotation marks, and (as surrogate pairs) tag characters and
 * supplementary variation selectors.
 */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]/;

/**
 * The address as it reads: percent-encoded characters decoded (`My%20File.tif` reads `My File.tif`), except those that
 * change its shape (`/`, `?`, `&`, ...), which `decodeURI` keeps. For showing only; the encoded form stays when it does
 * not decode, or when decoding would bring in invisible or control characters.
 */
export function readableAddress(address: string): string {
  try {
    const decoded = decodeURI(address);
    return UNSAFE.test(decoded) ? address : decoded;
  } catch {
    return address;
  }
}

/** The address without its http(s) scheme, as it is shown. */
export const withoutScheme = (address: string): string => address.replace(/^https?:\/\//i, "");

/**
 * The shown address (without its scheme) shortened to what tells where it points: the host in full, "…" for the
 * folders between, the last path segment in full (the file name, a map service's last template part), and what follows
 * it (an editor's query). A host alone, or a host and one file, stays whole.
 */
export function shortAddress(address: string): string {
  const cut = address.search(/[?#]/);
  const path = cut < 0 ? address : address.slice(0, cut);
  const slash = path.indexOf("/");
  if (slash < 0) return address;
  // An address that ends in a slash keeps it after its last folder.
  const folder = path.endsWith("/") ? "/" : "";
  const segments = path.slice(slash + 1, path.length - folder.length).split("/");
  if (segments.length < 2) return address;
  return `${path.slice(0, slash)}/…/${segments[segments.length - 1]}${folder}${cut < 0 ? "" : address.slice(cut)}`;
}
