/** The subdomains `{s}` stands for when the address lists none, as Leaflet and most tile services have them. */
export const DEFAULT_SUBDOMAINS = ["a", "b", "c"];

/**
 * `{switch:a,b,c}`: the subdomains an address lists itself (JOSM's and iD's form), as host labels. Anything else in
 * the braces is no placeholder: it stays in the address, which then fails as a URL.
 */
const SUBDOMAIN_LIST = /\{switch:([A-Za-z0-9-]+(?:,[A-Za-z0-9-]+)*)\}/;

/** A subdomain placeholder that is the host's whole first label, with a label after it, as in
 * `{s}.tile.openstreetmap.org`. */
const LEADING_LABEL = new RegExp(`(?<=//)(?:\\{s\\}|${SUBDOMAIN_LIST.source})\\.(?=[A-Za-z0-9])`);

/**
 * The tile addresses the map draws an XYZ template from, which is stored as it was typed:
 * one address per subdomain (`{s}` is a, b or c, `{switch:1,2,3}` names its own) and, for
 * `{-y}`, rows counted from the south (TMS), which MapLibre reads from `{y}` with
 * `scheme: "tms"`.
 */
export const xyzTiles = (template: string): { tiles: string[]; scheme?: "tms" } => {
  const tms = template.includes("{-y}");
  const url = tms ? template.replaceAll("{-y}", "{y}") : template;
  const list = url.match(SUBDOMAIN_LIST);
  const subdomains = list ? list[1].split(",") : url.includes("{s}") ? DEFAULT_SUBDOMAINS : [];
  const placeholder = list ? list[0] : "{s}";
  const tiles = subdomains.length ? subdomains.map((entry) => url.replaceAll(placeholder, entry)) : [url];
  return tms ? { tiles, scheme: "tms" } : { tiles };
};

const isHttpUrl = (address: string) => {
  try {
    const { protocol } = new URL(address);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Whether every address the template stands for is an http(s) URL. Each is checked: a list in
 * the host reads as a port in the template itself, and one in the scheme would change it.
 */
export const xyzAddressesValid = (template: string): boolean => xyzTiles(template).tiles.every(isHttpUrl);

/**
 * The template's host: less a placeholder that is its whole first label (`{s}.tile.openstreetmap.org`
 * is tile.openstreetmap.org), else the host of its first address (`tiles{switch:0,1}.example.org` is
 * tiles0.example.org).
 */
export const xyzHost = (template: string): string =>
  new URL(xyzTiles(template.replace(LEADING_LABEL, "")).tiles[0]).hostname;
