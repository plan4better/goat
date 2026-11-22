import useSWR from "swr";

import { getAccessToken } from "@/lib/api/fetcher";
import { setCatalogPreviewToken } from "@/lib/catalog/preview";
import { AUTH_DISABLED } from "@/lib/constants";

/** How often the sign-in is read again: the token is replaced before it expires (`getAccessToken`). */
const TOKEN_REFRESH_MS = 60_000;

/**
 * Whether the data of catalog items may be asked for: geoapi answers it to signed-in users only, so a visitor of the
 * public catalog page gets the footprint and the sample, and no request that would be refused. Keeps the sign-in the
 * detail map's requests carry (`catalogPreviewRequest`, in every map's `mapRequest`) current while it is mounted.
 */
export const useCatalogPreviewAccess = (): boolean => {
  const { data: token } = useSWR(AUTH_DISABLED ? null : "catalog-preview-token", getAccessToken, {
    refreshInterval: TOKEN_REFRESH_MS,
  });
  // Set while rendering, not in an effect: the map layers rendered with this answer ask for tiles at once.
  if (token !== undefined) setCatalogPreviewToken(token);
  return AUTH_DISABLED || !!token;
};
