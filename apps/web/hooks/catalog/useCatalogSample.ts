import { useCatalogPreview } from "@/lib/api/catalog";
import { catalogKindOf, catalogServiceTiles } from "@/lib/catalog/kind";
import type { CatalogItem } from "@/lib/validations/catalog";

import { useCatalogPreviewAccess } from "@/hooks/catalog/useCatalogPreviewAccess";

/**
 * The sample of a catalog item's rows, for the detail map and the Data tab. It is the dataset's own data, which the
 * catalog answers to signed-in users only, so it is asked for only with a sign-in; and never for a raster or a map
 * service, which have no rows. One request per item: every caller shares the SWR key.
 */
export const useCatalogSample = (item: CatalogItem) => {
  const signedIn = useCatalogPreviewAccess();
  const hasRows = !catalogServiceTiles(item) && catalogKindOf(item, true) !== "raster";
  return useCatalogPreview(item.id, signedIn && hasRows);
};
