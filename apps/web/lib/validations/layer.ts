import { v4 } from "uuid";
import * as z from "zod";

import { DEFAULT_WKT_EXTENT } from "@/lib/constants";
import { formatNumberTypes } from "@/lib/validations/common";
import {
  contentMetadataSchema,
  dataType,
  featureDataExchangeType,
  featureLayerGeometryType,
  featureLayerType,
  layerType,
  paginatedSchema,
} from "@/lib/validations/common";
import { responseSchema } from "@/lib/validations/response";
import { publicUserSchema } from "@/lib/validations/user";

export const layerRoleEnums = z.enum(["layer-owner", "layer-viewer", "layer-editor"]);

export const layerRoles = {
  OWNER: "layer-owner",
  VIEWER: "layer-viewer",
  EDITOR: "layer-editor",
} as const;

export const layerShareRoleEnum = z.enum(["layer-viewer", "layer-editor"]);

export const shareLayerWithTeamOrOrganizationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  avatar: z.string().optional(),
  role: layerShareRoleEnum,
});

export const shareLayerSchema = z.object({
  teams: z.array(shareLayerWithTeamOrOrganizationSchema).optional(),
  organizations: z.array(shareLayerWithTeamOrOrganizationSchema).optional(),
  users: z.array(z.object({ id: z.string(), role: layerShareRoleEnum })).optional(),
});

const HexColor = z.string();
const ColorMap = z.array(z.tuple([z.union([z.array(z.string()), z.null()]), HexColor]));

export const classBreaks = z.enum([
  "quantile",
  "standard_deviation",
  "equal_interval",
  "heads_and_tails",
  "ordinal",
  "custom_breaks",
]);

const layerFieldType = z.object({
  $ref: z.string().optional(),
  name: z.string(),
  type: z.string(),
  format: z.string().optional(),
  // D2: computed-field metadata exposed by the queryables endpoint
  kind: z.string().optional(),
  is_computed: z.boolean().optional(),
  is_locked: z.boolean().optional(),
  // The layer belongs to a bundle and this column came with it: it may be
  // reformatted, but not renamed or deleted. Decided by the server.
  is_protected: z.boolean().optional(),
  allowed_values: z.array(z.union([z.string(), z.number()])).optional(),
  allow_other: z.boolean().optional(),
  default_value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  display_config: z.record(z.string(), z.unknown()).optional(),
  // Serial/uuid: the server assigns the value on create and never lets a write
  // change it, so editors show it read-only. `start` is a serial's first number.
  is_generated: z.boolean().optional(),
  start: z.number().optional(),
});

export const layerClassBreaks = z.object({
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  breaks: z.array(z.number()),
});

const ColorLegends = z.record(z.string());
const sanitizeColorRangeInput = (input: unknown): unknown => {
  if (!input || typeof input !== "object") {
    return input;
  }

  const colorRangeInput = { ...(input as Record<string, unknown>) };
  const rawColorMap = colorRangeInput.color_map;

  if (Array.isArray(rawColorMap)) {
    colorRangeInput.color_map = rawColorMap.filter((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return false;
      }

      const color = entry[1];
      return typeof color === "string" && color.length > 0;
    });
  }

  return colorRangeInput;
};

const colorRangeSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  colors: z.array(HexColor),
  reversed: z.boolean().optional(),
  color_map: ColorMap.optional(),
  color_legends: ColorLegends.optional(),
});

export const colorRange = z.preprocess(sanitizeColorRangeInput, colorRangeSchema);

export const marker = z.object({
  id: z.string().optional(),
  name: z.string(),
  url: z.string(),
  category: z.string().optional(),
  source: z.enum(["library", "custom"]).optional().default("library"),
});

// Composable number formatting — mirrors the `display_config` shape used by
// FieldEditor for layer schema fields, so the popup editor can speak the
// same vocabulary. Added alongside the legacy `format` preset enum (which
// the original interaction popup still uses); the popup-v2 renderer prefers
// `format_config` when present and falls back to `format`.
export const attributeFormatConfig = z.object({
  decimals: z.union([z.literal("auto"), z.number().int().min(0).max(10)]).optional(),
  thousands_separator: z.boolean().optional(),
  abbreviate: z.boolean().optional(),
  always_show_sign: z.boolean().optional(),
});

export const attributeSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(["string", "number", "boolean"]),
  format: formatNumberTypes.optional(),
  format_config: attributeFormatConfig.optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

// Popup v2 — new customizable popup schema. Lives alongside `interaction`
// for back-compat; renderer prefers `popup` when present.
export const popupTextBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("text"),
  html: z.string().default(""),
});

export const popupFieldListBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("fieldList"),
  layout: z.enum(["table", "list"]).default("table"),
  attributes: z.array(attributeSchema).default([]),
  collapse_after: z.number().int().min(1).max(50).nullable().default(null),
});

export const popupImageBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("image"),
  source: z.enum(["field", "static"]).default("field"),
  field: z.string().optional(),
  url: z.string().optional(),
  sizing: z.enum(["fit", "fixed", "aspect"]).default("fixed"),
  height: z.number().min(40).max(400).default(140),
  aspect: z.enum(["16/9", "4/3", "3/2", "1/1", "2/3"]).default("16/9"),
});

export const popupButtonBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("button"),
  label: z.string().default("Open"),
  url_template: z.string().default(""),
  style: z.enum(["link", "outlined", "filled"]).default("link"),
  color: z.string().optional(),
});

export const popupBadgeBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("badge"),
  field: z.string().min(1),
  // "single" → one color for every value (read from `color`).
  // "per_value" → colors derived from `palette` (value → hex).
  mode: z.enum(["single", "per_value"]).default("single"),
  color: z.string().optional(),
  palette: z.record(z.string()).default({}),
  labels: z.record(z.string()).optional(),
  full_width: z.boolean().default(false),
});

export const popupDividerBlock = z.object({
  id: z
    .string()
    .uuid()
    .default(() => v4()),
  type: z.literal("divider"),
  thickness: z.number().int().min(1).max(8).default(1),
  color: z.string().optional(),
});

export const popupBlock = z.discriminatedUnion("type", [
  popupTextBlock,
  popupFieldListBlock,
  popupImageBlock,
  popupButtonBlock,
  popupBadgeBlock,
  popupDividerBlock,
]);

export const popupAnchor = z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]);

export const popupLayout = z.enum(["popup", "pinned", "modal", "left_sidebar", "right_sidebar"]);

export const popupHeader = z.enum(["standard", "compact", "none"]);

export const popupProperties = z.object({
  enabled: z.boolean().default(true),
  // "click_and_hover" opens the popup on hover (transient) AND on click
  // (pinned). Once a popup is active on any layer, triggers from OTHER
  // layers are suppressed by the runtime until the popup closes.
  trigger: z.enum(["click", "hover", "click_and_hover"]).default("click"),
  mode: z.enum(["simple", "html"]).default("simple"),
  blocks: z.array(popupBlock).default([]),
  html: z.string().default(""),
  // Unified, mode-agnostic appearance ("Desktop layout").
  layout: popupLayout.default("popup"),
  anchor: popupAnchor.optional(), // only meaningful when layout === "pinned"
  width: z.number().int().positive().optional(), // px; undefined = auto
  max_height: z.number().int().positive().optional(), // px; undefined = auto
  header: popupHeader.default("standard"),
  highlight_active_feature: z.boolean().default(true),
  // DEPRECATED — kept optional so legacy stored popups survive parsing
  // and can be mapped forward by normalizePopup(). Never written by new code.
  position: z.enum(["in_place", "fixed"]).optional(),
  show_layer_header: z.boolean().optional(),
});

export type PopupBlock = z.infer<typeof popupBlock>;
export type PopupTextBlock = z.infer<typeof popupTextBlock>;
export type PopupFieldListBlock = z.infer<typeof popupFieldListBlock>;
export type AttributeFormatConfig = z.infer<typeof attributeFormatConfig>;
export type Attribute = z.infer<typeof attributeSchema>;
export type PopupImageBlock = z.infer<typeof popupImageBlock>;
export type PopupButtonBlock = z.infer<typeof popupButtonBlock>;
export type PopupBadgeBlock = z.infer<typeof popupBadgeBlock>;
export type PopupDividerBlock = z.infer<typeof popupDividerBlock>;
export type PopupProperties = z.infer<typeof popupProperties>;
export type PopupLayout = z.infer<typeof popupLayout>;
export type PopupHeader = z.infer<typeof popupHeader>;
export type PopupAnchor = z.infer<typeof popupAnchor>;

/**
 * What the metadata FORM edits — flat, because a form is a flat set of inputs.
 * It is packed into `dataset_metadata` on submit and unpacked on seed, the
 * same way a bundle's is.
 */
export const layerMetadataSchema = contentMetadataSchema;

/** What a stored layer carries: the document, not the loose fields. */
export const layerStoredMetadataSchema = contentMetadataSchema.extend({
  public_read: z.boolean().optional().default(false),
});

export const tableConfigSchema = z.object({
  // Columns pinned to the left of the data table, in pin order
  frozen_columns: z.array(z.string()).optional(),
  // Column widths in px — required for stable sticky offsets across reloads
  column_widths: z.record(z.string(), z.number()).optional(),
});

export const otherPropertiesSchmea = z
  .object({
    url: z.string().optional(),
    layers: z.array(z.string()).optional(),
    srs: z.string().optional(),
    width: z.number().optional(), // width of the image (only for external imagery)
    height: z.number().optional(), // height of the image (only for external imagery)
    legend_urls: z.array(z.string()).optional(),
    version: z.string().optional(),
    dpi: z.number().optional(),
    tile_size: z.number().optional(),
    // Per-project-layer data table preferences
    table_config: tableConfigSchema.optional(),
  })
  /**
   * Not a closed shape: `other_properties` is a free-form blob, and a promoted
   * catalog layer carries `catalog_item` and `catalog_materialize` in it. A
   * plain `z.object` STRIPS what it does not declare, so parsing a project
   * layer through this schema quietly turned a catalog layer into an ordinary
   * one — and everything keyed off that (the read-only marker, hiding "Set as
   * default") went with it. The server made the same mistake with a closed
   * Pydantic model and was fixed the same way.
   */
  .passthrough();

export const layerSchema = layerStoredMetadataSchema.extend({
  id: z.string(),
  extent: z.string().default(DEFAULT_WKT_EXTENT),
  // Both absent for a catalog layer: it belongs to the provider that published
  // it, so it has no owner and lives in no one's folder. The API omits them
  // rather than sending null (response_model_exclude_none).
  folder_id: z.string().nullish(),
  user_id: z.string().uuid().nullish(),
  type: layerType,
  size: z.number().optional(),
  other_properties: otherPropertiesSchmea.optional(),
  url: z.string().optional(),
  feature_layer_type: featureLayerType.optional(),
  feature_layer_geometry_type: featureLayerGeometryType.optional(),
  tool_type: z.string().optional(),
  job_id: z.string().optional(),
  data_type: dataType.optional(),
  shared_with: shareLayerSchema.optional(),
  owned_by: publicUserSchema.optional(),
  updated_at: z.string(),
  created_at: z.string(),
});

export const postDatasetSchema = layerSchema.partial();

export const getLayerUniqueValuesQueryParamsSchema = paginatedSchema.extend({
  query: z.string().optional(),
});

export const createLayerBaseSchema = layerStoredMetadataSchema.extend({
  folder_id: z.string().uuid(),
});

export const externalDatasetFeatureUrlSchema = z.object({
  data_type: dataType,
  other_properties: otherPropertiesSchmea,
});

export const createLayerFromDatasetSchema = createLayerBaseSchema.extend({
  s3_key: z.string().optional(),
  dataset_id: z.string().optional(),
  project_id: z.string().uuid().optional(),
  data_type: dataType.optional(),
  other_properties: otherPropertiesSchmea.optional(),
  has_header: z.boolean().optional(),
  sheet_name: z.string().optional(),
});

export const createRasterLayerSchema = createLayerBaseSchema.extend({
  type: z.literal("raster"),
  url: z.string().url(),
  data_type: dataType,
  extent: z.string().optional(),
  other_properties: otherPropertiesSchmea,
});

export const layerQueryables = z.object({
  title: z.string(),
  properties: z.record(layerFieldType),
  type: z.string(),
  $schema: z.string(),
  $id: z.string(),
});

export const uniqueValuesSchema = z.object({
  value: z.string(),
  count: z.number(),
});
export const uniqueValuesResponseSchema = responseSchema(uniqueValuesSchema);

export const datasetDownloadRequestSchema = z.object({
  id: z.string().uuid(),
  file_type: featureDataExchangeType.optional(),
  file_name: z.string().optional(),
  crs: z.string().optional(),
  query: z.string().optional(),
});

export const datasetCollectionItems = z.object({
  description: z.string().optional(),
  features: z.array(
    z.object({
      geometry: z
        .object({
          coordinates: z.array(z.number()),
          type: z.string(),
        })
        .optional(),
      id: z.number(),
      properties: z.object({}),
      type: z.string(),
    })
  ),
  id: z.string().optional(),
  links: z.array(
    z.object({
      href: z.string(),
      rel: z.string(),
      type: z.string(),
      title: z.string(),
    })
  ),
  numberMatched: z.number(),
  numberReturned: z.number(),
  title: z.string(),
  type: z.string(),
});

export const datasetCollectionItemsQueryParams = z.object({
  "geom-column": z.string().optional(),
  "datetime-column": z.string().optional(),
  limit: z.number().min(0).max(10000).optional().default(10),
  offset: z.number().min(0).optional(),
  "bbox-only": z.boolean().optional(),
  simplify: z.boolean().optional(),
  ids: z.string().optional(),
  bbox: z.string().optional(),
  datetime: z.string().optional(),
  properties: z.string().optional(),
  filter: z.string().optional(),
  sortby: z.string().optional(),
  f: z.string().optional(),
});

export const getDatasetSchema = z.object({
  folder_id: z.string().uuid().optional(),
  search: z.string().optional(),
  type: layerType.array().optional(),
  feature_layer_type: featureLayerType.optional(),
  public_read: z.boolean().optional(),
  spatial_search: z.string().optional(),
});

export type DatasetCollectionItems = z.infer<typeof datasetCollectionItems>;
export type GetCollectionItemsQueryParams = z.infer<typeof datasetCollectionItemsQueryParams>;
export type GetDatasetSchema = z.infer<typeof getDatasetSchema>;

export type DatasetDownloadRequest = z.infer<typeof datasetDownloadRequestSchema>;

export const layerResponseSchema = responseSchema(layerSchema);
export const layerTypesArray = Object.values(layerType.Values);
export const featureLayerTypesArray = Object.values(featureLayerType.Values);

export type ColorRange = z.infer<typeof colorRange>;
export type ColorMap = z.infer<typeof ColorMap>;
export type Layer = z.infer<typeof layerSchema>;
export type PostDataset = z.infer<typeof postDatasetSchema>;
export type LayerPaginated = z.infer<typeof layerResponseSchema>;
export type LayerUniqueValues = z.infer<typeof uniqueValuesSchema>;
export type LayerUniqueValuesPaginated = z.infer<typeof uniqueValuesResponseSchema>;
export type Marker = z.infer<typeof marker>;
export type LayerType = z.infer<typeof layerType>;
export type LayerQueryables = z.infer<typeof layerQueryables>;
export type ClassBreaks = z.infer<typeof classBreaks>;
export type LayerClassBreaks = z.infer<typeof layerClassBreaks>;
export type LayerFieldType = z.infer<typeof layerFieldType>;
export type LayerMetadata = z.infer<typeof layerMetadataSchema>;
export type FeatureLayerType = z.infer<typeof featureLayerType>;
export type GetLayerUniqueValuesQueryParams = z.infer<typeof getLayerUniqueValuesQueryParamsSchema>;
export type ExternalDatasetFeatureUrl = z.infer<typeof externalDatasetFeatureUrlSchema>;
export type CreateLayerFromDataset = z.infer<typeof createLayerFromDatasetSchema>;
export type CreateRasterLayer = z.infer<typeof createRasterLayerSchema>;
export type LayerSharedWith = z.infer<typeof shareLayerSchema>;

// --- Field definitions ---

export const fieldKindSchema = z.enum([
  "string",
  "number",
  "area",
  "perimeter",
  "length",
  "datetime",
  "boolean",
  "formula",
  "serial",
  "uuid",
]);
export type FieldKind = z.infer<typeof fieldKindSchema>;

/**
 * Kinds whose values the server generates on every create — a running number
 * (`serial`, stored as an integer) and a random identifier (`uuid`, stored as
 * text). Never typed in by a user and never changed once assigned.
 */
export const GENERATED_KINDS: ReadonlySet<string> = new Set(["serial", "uuid"]);

export const isGeneratedKind = (kind: string | undefined): boolean => !!kind && GENERATED_KINDS.has(kind);

/** The kind used to FORMAT a field's values: formula fields format as their
 * inferred result kind (number/string/boolean/datetime); a serial number is a
 * number and a UUID a string wherever values are shown, filtered or styled. */
export const resolveDisplayKind = (field: { kind?: string; output_kind?: string }): string | undefined => {
  if (field.kind === "formula") return field.output_kind ?? "string";
  if (field.kind === "serial") return "number";
  if (field.kind === "uuid") return "string";
  return field.kind;
};

const numericFormatSchema = z.object({
  decimals: z.union([z.literal("auto"), z.number().int().min(0).max(10)]).default("auto"),
  thousands_separator: z.boolean().default(false),
  abbreviate: z.boolean().default(false),
  always_show_sign: z.boolean().default(false),
});

export const stringDisplayConfigSchema = z.object({}).strict();
export const numberDisplayConfigSchema = numericFormatSchema.strict();
export const areaDisplayConfigSchema = numericFormatSchema
  .extend({
    unit: z.enum(["auto", "mm²", "cm²", "m²", "ha", "km²"]).default("auto"),
  })
  .strict();
export const lengthLikeUnitSchema = z.enum(["auto", "mm", "cm", "m", "km"]);
export const perimeterDisplayConfigSchema = numericFormatSchema
  .extend({
    unit: lengthLikeUnitSchema.default("auto"),
  })
  .strict();
export const lengthDisplayConfigSchema = numericFormatSchema
  .extend({
    unit: lengthLikeUnitSchema.default("auto"),
  })
  .strict();
export const datetimeDisplayConfigSchema = z
  .object({
    tz: z.string().default("UTC"),
    format: z.string().nullish(),
  })
  .strict();

export const displayConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string"), config: stringDisplayConfigSchema }),
  z.object({ kind: z.literal("number"), config: numberDisplayConfigSchema }),
  z.object({ kind: z.literal("area"), config: areaDisplayConfigSchema }),
  z.object({ kind: z.literal("perimeter"), config: perimeterDisplayConfigSchema }),
  z.object({ kind: z.literal("length"), config: lengthDisplayConfigSchema }),
  z.object({ kind: z.literal("datetime"), config: datetimeDisplayConfigSchema }),
]);

export const fieldDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Field name is required").max(255, "Field name too long"),
  kind: fieldKindSchema,
  is_computed: z.boolean().default(false),
  // Only ever set for a bundle member's own columns, so optional rather than
  // defaulted: nothing constructing a field for an ordinary layer has to say so.
  is_protected: z.boolean().optional(),
  display_config: z.record(z.string(), z.unknown()).default({}),
  // A fixed vocabulary for the column: editors offer these instead of a free
  // text box, and a write outside the list is refused unless allow_other.
  allowed_values: z.array(z.union([z.string(), z.number()])).optional(),
  allow_other: z.boolean().optional(),
  // Formula fields only: the SQL expression and its inferred result kind
  formula: z.string().optional(),
  output_kind: z.string().optional(),
  // Serial fields only: the first number handed out (default 1)
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const RESERVED_FIELD_NAMES = ["id", "geometry", "geom", "__duckdb_row_id"];

export const createEmptyLayerSchema = z.object({
  name: z.string().min(1, "Layer name is required"),
  geometryType: z.enum(["point", "line", "polygon"]).nullable(),
  fields: z
    .array(fieldDefinitionSchema)
    .refine(
      (fields) => {
        const names = fields.map((f) => f.name.toLowerCase());
        return new Set(names).size === names.length;
      },
      { message: "Field names must be unique" }
    )
    .refine((fields) => fields.every((f) => !RESERVED_FIELD_NAMES.includes(f.name.toLowerCase())), {
      message: "Field name conflicts with a reserved system column",
    }),
});

export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export type CreateEmptyLayerInput = z.infer<typeof createEmptyLayerSchema>;

// Map of geometry types to allowed kinds for the Add-Field dropdown
export const ALLOWED_KINDS_BY_GEOM_TYPE: Record<string, FieldKind[]> = {
  point: ["string", "number", "datetime", "boolean", "serial", "uuid", "formula"],
  multipoint: ["string", "number", "datetime", "boolean", "serial", "uuid", "formula"],
  line: ["string", "number", "length", "datetime", "boolean", "serial", "uuid", "formula"],
  multiline: ["string", "number", "length", "datetime", "boolean", "serial", "uuid", "formula"],
  polygon: ["string", "number", "area", "perimeter", "datetime", "boolean", "serial", "uuid", "formula"],
  multipolygon: ["string", "number", "area", "perimeter", "datetime", "boolean", "serial", "uuid", "formula"],
};

/**
 * Kinds a *new* layer can be created with.
 *
 * The rest — computed kinds and formula — need `field_config` written against an
 * existing layer for their values to be produced at all, so they belong to Edit
 * fields rather than to creation. `layer_create` accepts exactly this set. The
 * generated kinds belong here: the new layer is empty, and the server fills
 * them on every feature created in it.
 */
const CREATABLE_KINDS = ["string", "number", "datetime", "boolean", "serial", "uuid"] as const;
export type CreatableFieldKind = (typeof CREATABLE_KINDS)[number];

export const isCreatableKind = (kind: FieldKind): kind is CreatableFieldKind =>
  (CREATABLE_KINDS as readonly string[]).includes(kind);

// Kinds whose VALUES are computed by the backend (read-only in editors).
// Formula belongs here: its values are derived, only its expression is edited.
export const COMPUTED_KINDS: ReadonlySet<FieldKind> = new Set(["area", "perimeter", "length", "formula"]);
