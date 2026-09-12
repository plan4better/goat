/**
 * Types of the catalog STAC API (apps/catalog, `/stac`).
 *
 * Plain TypeScript, deliberately not zod. The app's other 23 validation files
 * are zod, but they are used as a type-authoring tool — 236 `z.infer` against
 * 28 `.parse()` calls, almost all of which validate *requests*. A zod mirror of
 * these responses would be parsed nowhere, so it would only duplicate the
 * server's own models at runtime cost.
 *
 * What is worth writing down is `properties`. The service publishes a complete
 * OpenAPI document (`/api/openapi.json`) describing every envelope below, but
 * it types `properties` as an open object *by design*: the mirror passes each
 * published column straight through, so a column the harvester adds tomorrow is
 * served without an API change. Generated types would therefore give
 * `Record<string, unknown>` for exactly the fields a card reads — so this file
 * pins the properties the UI depends on, and stays out of the way otherwise.
 *
 * Coverage against the live catalog (10,793 items) is uneven, which is why so
 * little is non-optional: `title` and `goat:layerType` are on every item,
 * `description` on 0.2%, `keywords` on 1.7%, `themes` on 2%, `datetime` null on
 * 52%. A card that assumes any of the rest will look broken.
 */

/** GOAT layer vocabulary. `bundle` means the item stands in for several layers. */
export type CatalogLayerType = "feature" | "table" | "raster" | "bundle";

export type CatalogGeometryType = "point" | "line" | "polygon";

/** A column of a vector or table dataset (STAC `table:columns`). */
export type CatalogColumn = {
  name: string;
  type?: string | null;
  description?: string | null;
};

/**
 * A STAC `themes` entry: a vocabulary and the concepts an item is tagged with.
 *
 * This is where a dataset's category lives in a served document. The mirror
 * also keeps a flat `category` column, but that is internal — it backs the
 * `category_count` facet and is not published in `properties`, so a card must
 * read the concept from here.
 */
export type CatalogTheme = {
  scheme?: string | null;
  concepts?: { id: string }[] | null;
};

export type CatalogAsset = {
  href: string;
  type?: string | null;
  title?: string | null;
  roles?: string[] | null;
};

export type CatalogLink = {
  rel: string;
  href: string;
  type?: string | null;
  title?: string | null;
};

/**
 * `properties` of a served item. Open-ended by design — index for anything not
 * listed, and expect most of the optional fields to be missing.
 */
export type CatalogItemProperties = {
  title: string;
  "goat:layerType": CatalogLayerType;
  description?: string | null;
  /**
   * When the data is from. Per STAC an item states either an instant here or a
   * range in `start_datetime`/`end_datetime` — and when it states a range,
   * `datetime` is explicitly null, so reading only this field shows no date at
   * all for a dataset that has one. `itemPeriod` resolves the three cases.
   */
  datetime?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  created?: string | null;
  updated?: string | null;
  license?: string | null;
  keywords?: string[] | null;
  version?: string | null;
  "goat:geometryType"?: CatalogGeometryType | null;
  "goat:geographical_code"?: string | null;
  /** Publisher name, denormalised from the parent collection's `providers`. */
  "goat:publisher"?: string | null;
  /**
   * How many layers share this item's dataset. `1` means the card *is* a
   * layer; more means it represents a bundle (see `grouped=true`). Never show a
   * geometry type on a bundle card — it belongs to the representative member,
   * and 569 of 1,207 bundles mix geometry types.
   */
  "goat:member_count"?: number | null;
  "processing:lineage"?: string | null;
  "table:row_count"?: number | null;
  "table:columns"?: CatalogColumn[] | null;
  themes?: CatalogTheme[] | null;
  language?: { code?: string | null } | null;
  source_name?: string | null;
  [key: string]: unknown;
};

export type CatalogItem = {
  type: "Feature";
  id: string;
  collection?: string | null;
  geometry?: GeoJSON.Geometry | null;
  bbox?: number[] | null;
  properties: CatalogItemProperties;
  assets: Record<string, CatalogAsset>;
  links: CatalogLink[];
};

export type CatalogItemCollection = {
  type: "FeatureCollection";
  features: CatalogItem[];
  links: CatalogLink[];
  numberMatched?: number | null;
  numberReturned?: number | null;
};

export type CatalogCollection = {
  type: "Collection";
  id: string;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  /** The notice an attribution licence obliges a user to reproduce. */
  attribution?: string | null;
  keywords?: string[] | null;
  providers?: {
    name: string;
    roles?: string[] | null;
    url?: string | null;
    /** Free text; the harvester puts the contact address here. */
    description?: string | null;
  }[] | null;
  links: CatalogLink[];
  themes?: CatalogTheme[] | null;
  /** Harvest clock, not the dataset's own date (harvester contract C11). */
  updated?: string | null;
  /**
   * The dataset's own footprint in space and time. `temporal.interval` is a list
   * whose FIRST entry is the whole extent (later ones may describe sub-periods),
   * and either bound may be null for an open-ended dataset.
   */
  extent?: {
    spatial?: { bbox?: number[][] | null } | null;
    temporal?: { interval?: (string | null)[][] | null } | null;
  } | null;
  "goat:member_count"?: number | null;
  "goat:publisher"?: string | null;
  "goat:geographical_code"?: string | null;
  "goat:layerType"?: CatalogLayerType | null;
  [key: string]: unknown;
};

/**
 * What `/stac/resolve/{id}` answers: "what is this id?".
 *
 * The detail route is reached with whatever id a card carried, which is an item
 * id for a single dataset and a collection id for a bundle. Rather than probing
 * two endpoints and treating a 404 as a type test, this resolves either in one
 * call: `kind` says which, and the other side arrives with it — a bundle brings
 * its members, an item brings its parent collection for the breadcrumb.
 */
export type CatalogResolved =
  | {
      kind: "collection";
      collection: CatalogCollection;
      items: CatalogItem[];
      "goat:member_count"?: number | null;
    }
  | {
      kind: "item";
      item: CatalogItem;
      collection_id?: string | null;
      collection?: CatalogCollection | null;
    };

/** What `/stac/collections` (Collection Search) answers: a page of datasets. */
export type CatalogCollections = {
  collections: CatalogCollection[];
  links: CatalogLink[];
  numberMatched?: number | null;
  numberReturned?: number | null;
};

export type CatalogAggregationBucket = {
  key: string | null;
  data_type: string;
  frequency: number;
};

/**
 * One aggregation from `/stac/aggregations` (discovery) or `/stac/aggregate`.
 *
 * `goat:filter_param` is what makes the filter sidebar derivable rather than
 * hardcoded: a facet is *named* `category_count` but is narrowed with
 * `?themes=`, so stripping `_count` off the name would build a parameter the
 * API ignores.
 */
export type CatalogAggregation = {
  name: string;
  data_type: string;
  value?: number | null;
  buckets?: CatalogAggregationBucket[] | null;
  "goat:filter_param"?: string | null;
};

export type CatalogAggregations = { aggregations: CatalogAggregation[] };

/** A NUTS region, for the spatial filter's typeahead. */
export type CatalogNutsRegion = {
  nuts_id: string;
  nuts_name: string;
  level: number;
  country?: string | null;
  /** `[w, s, e, n]` — enough to frame the region without fetching its geometry. */
  bbox?: number[] | null;
};

/** A bounded sample of an item's features, for the preview map. */
export type CatalogPreview = {
  type: "FeatureCollection";
  /** A dataset with no geometry — most of the catalog is attribute tables — samples
   * its rows instead, as Features with a `null` geometry. */
  features: GeoJSON.Feature<GeoJSON.Geometry | null>[];
  bbox?: number[] | null;
  "goat:item_bbox"?: number[] | null;
  "goat:total"?: number | null;
  "goat:truncated"?: boolean | null;
};
