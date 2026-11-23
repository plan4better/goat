import type { RequestParameters } from "maplibre-gl";

import { GEOAPI_BASE_URL } from "@/lib/constants";

/**
 * The data of a catalog item that is not a layer yet, as the catalog page draws it.
 *
 * geoapi reads an item's published tiles and its raster from the catalog's private storage under the collection id
 * `catalog:<item id>`, with the routes a layer has, and answers them to signed-in users only (its
 * `catalog_read_allowed`). So the detail map asks for them only with a sign-in, and sends it with every request.
 */

/** geoapi's collection id of a catalog item. */
export const catalogCollectionId = (itemId: string): string => `catalog:${itemId}`;

let token: string | null = null;

/** The sign-in the detail map's preview requests carry; null when signed out. */
export const setCatalogPreviewToken = (next: string | null): void => {
  token = next;
};

/**
 * The request of a catalog item's preview with the sign-in on it; undefined for any other address, and while no
 * sign-in is set. Part of every map's `transformRequest` (`mapRequest`): only the catalog's detail map asks for these
 * addresses. A WMS or WMTS item is drawn by its provider's server, which gets no token.
 */
export function catalogPreviewRequest(
  url: string,
  base: string | undefined = GEOAPI_BASE_URL
): RequestParameters | undefined {
  if (!token || !base || !url.startsWith(`${base}/collections/${catalogCollectionId("")}`)) return undefined;
  return { url, headers: { Authorization: `Bearer ${token}` } };
}
