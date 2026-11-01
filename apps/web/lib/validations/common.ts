import * as z from "zod";

export const orderByEnum = z.enum(["ascendent", "descendent"]);

export const paginatedSchema = z.object({
  order_by: z.string().optional(),
  order: orderByEnum.optional(),
  page: z.number().int().positive().optional(),
  size: z.number().int().positive().optional(),
  team_id: z.string().uuid().optional(),
  organization_id: z.string().uuid().optional(),
});

export const getContentQueryParamsSchema = paginatedSchema.extend({
  folder_id: z.string().uuid().optional(),
  search: z.string().optional(),
  authorization: z.string().optional(),
});

/** The server's limit for a content name (`ContentBaseAttributes.name`, `LayerProjectLink.name`). */
export const MAX_CONTENT_NAME_LENGTH = 255;

export const contentMetadataSchema = z.object({
  name: z.string().min(1).max(MAX_CONTENT_NAME_LENGTH),
  description: z.string().optional(),
  tags: z.array(z.string()).optional().nullable(),
  thumbnail_url: z.string().optional(),
});

export const layerType = z.enum(["feature", "raster", "table"]);

export const featureLayerType = z.enum(["standard", "tool", "street_network"]);

export const tableDataExchangeType = z.enum(["csv", "xlsx"]);
export const featureDataExchangeType = z.enum(["csv", "xlsx", "geojson", "gpkg", "kml", "shp", "parquet"]);

export const featureDataExchangeCRS = z.string().regex(/^\d{4,5}$/);

export const featureLayerGeometryType = z.enum(["point", "line", "polygon"]);

export const vectorDataType = z.enum(["mvt", "wfs"]);
export const imageryDataType = z.enum(["xyz", "wms", "wmts", "cog"]);
export const dataType = z.union([vectorDataType, imageryDataType]);
export const sortTypes = z.enum(["asc", "desc"]);
export const statisticOperationEnum = z.enum(["count", "sum", "mean", "median", "min", "max", "expression"]);

export const formatNumberTypes = z.enum([
  "none", // 1000
  "decimal_max", // All decimals (up to 3)
  "integer", // 1000 (no commas)
  "grouping", // 1,000
  "grouping_2d", // 12,345.67
  "signed_2d", // +12,345.67
  "compact", // 1k
  "compact_1d", // 12.3k
  "decimal_2", // 1.23
  "decimal_3", // 1.234
  "currency_usd", // $12,345.67
  "currency_eur", // €12,345.67
  "percent", // 1%
  "percent_1d", // 1.0%
  "percent_2d", // 1.00%
]);

export type FormatNumberTypes = z.infer<typeof formatNumberTypes>;

export type SortType = z.infer<typeof sortTypes>;
export type StatisticOperation = z.infer<typeof statisticOperationEnum>;
export type LayerType = z.infer<typeof layerType>;
export type FeatureLayerGeometryType = z.infer<typeof featureLayerGeometryType>;
export type TableDataExchangeType = z.infer<typeof tableDataExchangeType>;
export type FeatureDataExchangeType = z.infer<typeof featureDataExchangeType>;
export type PaginatedQueryParams = z.infer<typeof paginatedSchema>;
export type GetContentQueryParams = z.infer<typeof getContentQueryParamsSchema>;
export type DataType = z.infer<typeof dataType>;
