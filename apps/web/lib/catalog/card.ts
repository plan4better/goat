import { type CatalogKind } from "@/lib/catalog/kind";
import { type CatalogPeriod, datasetPeriod, itemPeriod } from "@/lib/catalog/period";
import type { CatalogCollection, CatalogItem } from "@/lib/validations/catalog";

/** What a result card needs, independent of what it was built from. */
export type CatalogCardModel = {
  /** Where the card navigates: a collection id for a dataset, an item id for a layer. */
  href: string;
  title: string;
  description?: string;
  kind: CatalogKind;
  /** Layers in this dataset. 1 for a layer, and for a single-layer dataset. */
  memberCount: number;
  /** Set only for a dataset with more than one layer, to list them inline. */
  bundleId?: string;
  thumbnailHref?: string;
  publisher?: string;
  license?: string;
  languageCode?: string;
  /** When the data is from, where the source says. */
  period?: CatalogPeriod;
  /** What shape the data is — `point`, `line` or `polygon`. */
  geometryType?: string;
};

/** A publicly dereferenceable thumbnail, or `undefined`. */
const thumbnailHref = (assets: CatalogItem["assets"] | undefined) => {
  const href = assets?.thumbnail?.href;
  if (!href) return undefined;
  return /^https?:\/\//i.test(href) ? href : undefined;
};

/** A dataset card, from the Collection that *is* the dataset. */
export const datasetCard = (collection: CatalogCollection): CatalogCardModel => {
  const memberCount = collection["goat:member_count"] ?? 1;
  const layerType = collection["goat:layerType"];
  return {
    href: `/catalog/${encodeURIComponent(collection.id)}`,
    title: collection.title || collection.id,
    description: collection.description ?? undefined,
    // A dataset of several layers is a bundle whatever its layers are; otherwise
    // its single layer's type is the dataset's type.
    kind:
      memberCount > 1
        ? "bundle"
        : layerType === "raster" || layerType === "wms" || layerType === "wmts" || layerType === "table"
          ? layerType
          : layerType === "feature"
            ? "vector"
            : "unknown",
    memberCount,
    bundleId: memberCount > 1 ? collection.id : undefined,
    thumbnailHref: thumbnailHref(collection.assets as CatalogItem["assets"]),
    publisher: collection["goat:publisher"] ?? undefined,
    license: collection.license ?? undefined,
    languageCode: (collection.language as { code?: string } | undefined)?.code,
    period: datasetPeriod(collection),
    geometryType: (collection["goat:geometryType"] as string | null) ?? undefined,
  };
};

/** A layer card, from an Item — used for the members listed inside a bundle. */
export const layerCard = (item: CatalogItem): CatalogCardModel => {
  const props = item.properties;
  return {
    href: `/catalog/${encodeURIComponent(item.id)}`,
    title: props.title,
    description: props.description ?? undefined,
    kind: props["goat:geometryType"]
      ? "vector"
      : typeof props["table:row_count"] === "number"
        ? "table"
        : "unknown",
    // A layer is one layer. It never carries its siblings' count into a card.
    memberCount: 1,
    thumbnailHref: thumbnailHref(item.assets),
    publisher: props["goat:publisher"] ?? undefined,
    license: props.license ?? undefined,
    languageCode: props.language?.code ?? undefined,
    period: itemPeriod(item),
    geometryType: props["goat:geometryType"] ?? undefined,
  };
};
