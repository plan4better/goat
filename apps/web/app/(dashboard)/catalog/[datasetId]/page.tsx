"use client";

import { use } from "react";

import { useCatalogResolve } from "@/lib/api/catalog";

import { useCatalogRecordAssistantSurface } from "@/hooks/assistant/useCatalogAssistantSurface";

import CatalogDetailView from "@/components/dashboard/catalog/CatalogDetailView";

/**
 * Catalog entry detail. Data comes from the catalog STAC API only — never core,
 * because a catalog entry is not a GOAT layer until a project adds it
 * (promote-on-use). A promoted layer opens in the Content preview dialog.
 *
 * One `/stac/resolve/{id}` call settles what the id is: a card in grouped mode
 * carries a collection (a bundle), an ungrouped card carries an item.
 */
export default function CatalogDetailPage(props: { params: Promise<{ datasetId: string }> }) {
  // `params` is a Promise since Next 16 and must be unwrapped, as every other
  // dynamic route here does.
  const { datasetId } = use(props.params);
  useCatalogRecordAssistantSurface(datasetId);
  const { collection, members, item, parent, isLoading, isError } = useCatalogResolve(datasetId);

  return (
    <CatalogDetailView
      entryId={datasetId}
      collection={collection}
      members={members}
      item={item}
      parent={parent}
      isLoading={isLoading}
      isError={!!isError}
    />
  );
}
