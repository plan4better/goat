import * as z from "zod";

import { DEFAULT_WKT_EXTENT } from "@/lib/constants";
import { basicLayout } from "@/lib/constants/dashboard-builder-template-layouts";
import {
  contentMetadataSchema,
  getContentQueryParamsSchema,
  orderByEnum,
  statisticOperationEnum,
} from "@/lib/validations/common";
import { layerSchema } from "@/lib/validations/layer";
import { responseSchema } from "@/lib/validations/response";
import { publicUserSchema } from "@/lib/validations/user";
import { interactionRuleSchema } from "@/lib/validations/interaction";
import { configSchemas, popupPlacements, popupSizes, popupTypes } from "@/lib/validations/widget";

export const projectRoleEnum = z.enum(["project-owner", "project-viewer", "project-editor"]);

export const projectRoles = {
  OWNER: "project-owner",
  VIEWER: "project-viewer",
  EDITOR: "project-editor",
} as const;

export const projectShareRoleEnum = z.enum(["project-viewer", "project-editor"]);

export const shareProjectWithTeamOrOrganizationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  avatar: z.string().optional(),
  role: projectShareRoleEnum,
});

export const shareProjectSchema = z.object({
  teams: z.array(shareProjectWithTeamOrOrganizationSchema).optional(),
  organizations: z.array(shareProjectWithTeamOrOrganizationSchema).optional(),
  // `name` here is already the resolved display name the backend builds for a
  // user grantee (firstname + lastname, falling back to email) — the same
  // shape a team/organization entry carries.
  users: z
    .array(
      z.object({ id: z.string(), name: z.string().optional(), role: projectShareRoleEnum })
    )
    .optional(),
});

export const builderWidgetSchema = z.object({
  id: z.string(),
  type: z.literal("widget"),
  config: configSchemas.optional(),
});

export const builderPanelConfigSchema = z.object({
  options: z
    .object({
      style: z.enum(["default", "rounded", "floated"]).optional().default("default"),
      collapsible: z.boolean().optional().default(false),
      collapsed_default: z.boolean().optional().default(false),
      collapsed_label: z.string().optional().default(""),
    })
    .optional()
    .default({}),
  appearance: z
    .object({
      opacity: z.number().min(0).max(1).optional().default(1),
      backgroundColor: z.string().optional(),
      backgroundBlur: z.number().min(0).max(20).optional().default(0),
      shadow: z.number().min(0).max(10).optional().default(0),
    })
    .optional()
    .default({}),
  position: z
    .object({
      alignItems: z.enum(["start", "center", "end"]).default("start"),
      spacing: z.number().min(0).max(15).optional().default(0),
      padding: z.number().min(0).max(2).optional().default(0),
    })
    .optional()
    .default({ alignItems: "start" }),
  size: z
    .object({
      width: z.number().min(200).max(800).optional().default(300),
      height: z.number().min(150).max(600).optional().default(300),
    })
    .optional()
    .default({}),
});

export const builderPanelSchema = z.object({
  id: z.string(),
  type: z.literal("panel").optional().default("panel"),
  position: z.enum(["top", "bottom", "left", "right"]),
  config: builderPanelConfigSchema.optional().default({}),
  widgets: z.array(builderWidgetSchema).optional().default([]),
});

export const dashboardLanguageEnum = z.enum(["auto", "en", "de"]);

export const DEFAULT_FAVICON_URL = "/assets/svg/goat-logo.svg";

export const CORNER_KEYS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type CornerKey = (typeof CORNER_KEYS)[number];

export const CONTROL_KEYS = [
  "location",
  "measure",
  "zoom_controls",
  "basemap",
  "fullscreen",
  "find_my_location",
  "project_info",
] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

// Strip unknown control keys (e.g. "scalebar" from before it became a boolean toggle)
// so old stored data doesn't cause a hard parse failure.
const safeControlArray = z.preprocess(
  (val) => (Array.isArray(val) ? val.filter((v) => (CONTROL_KEYS as readonly string[]).includes(v)) : []),
  z.array(z.enum(CONTROL_KEYS)).default([])
);

const controlPositionsSchema = z
  .object({
    "top-left": safeControlArray,
    "top-right": safeControlArray,
    "bottom-left": safeControlArray,
    "bottom-right": safeControlArray,
  })
  .default({
    "top-left": ["location", "measure"],
    "bottom-right": ["zoom_controls", "basemap", "fullscreen"],
  });

export type ControlPositions = z.infer<typeof controlPositionsSchema>;

export const DEFAULT_CONTROL_POSITIONS: ControlPositions = {
  "top-left": ["location", "measure"],
  "top-right": [],
  "bottom-left": [],
  "bottom-right": ["zoom_controls", "basemap", "fullscreen"],
};

export const builderConfigSchema = z.object({
  settings: z
    .object({
      control_positions: controlPositionsSchema,
      allowed_basemaps: z.array(z.string()).nullable().default(null),
      toolbar: z.boolean().default(true),
      scalebar: z.boolean().default(true),
      project_info_content: z.string().default(""),
      project_info_popup_type: popupTypes.optional().default("dialog"),
      project_info_popup_placement: popupPlacements.optional().default("auto"),
      project_info_popup_size: popupSizes.optional().default("md"),
      // Branding
      language: dashboardLanguageEnum.default("auto"),
      font_family: z.string().default("Mulish, sans-serif"),
      font_url: z.string().optional(),
      primary_color: z.string().optional(),
      icon_color: z.string().optional(),
      font_color: z.string().optional(),
      favicon_url: z.string().default(DEFAULT_FAVICON_URL),
      // Home-screen/PWA icon. Optional; when absent the GOAT logo is used.
      // Deliberately independent from favicon_url (favicons are often too
      // small to make good app icons).
      app_icon_url: z.string().optional(),
      // Social sharing — when unset, public pages fall back to GOAT defaults
      // (see lib/metadata.ts and app/map/public/[projectId]/layout.tsx).
      og_image_url: z.string().optional(),
      meta_description: z.string().max(300).optional(),
      // Dashboard-owned map camera settings. Namespaced for future growth
      // (initial_state, sync_with_project, …); only zoom limits for now.
      map_view: z
        .object({
          min_zoom: z.number().min(0).max(24).nullable().default(null),
          max_zoom: z.number().min(0).max(24).nullable().default(null),
        })
        .default({}),
      // Unified search (places + layer features). Layers list is the
      // public-dashboard search scope; the editor searches visible layers
      // automatically and ignores this.
      search: z
        .object({
          places: z.boolean().default(true),
          /** Optional custom input placeholder; falls back to the default copy. */
          placeholder: z.string().max(100).optional(),
          layers: z
            .array(
              z.object({
                layer_project_id: z.number(),
                columns: z.array(z.string()).min(1).max(3),
                label_column: z.string().optional(),
              })
            )
            .default([]),
        })
        .default({}),
    })
    .default({}),
  interface: z.preprocess(
    (val) => (Array.isArray(val) && val.length === 0 ? undefined : val),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    z.array(builderPanelSchema).default(basicLayout.interface as any)
  ),
  interactions: z.array(interactionRuleSchema).default([]),
});

const baseCustomBasemapSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).nullable().optional(),
  thumbnail_url: z.string().url().max(2048).nullable().optional(),
  attribution: z.string().max(500).nullable().optional(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export const basemapLayerSettingSchema = z.object({
  visible: z.boolean().default(true),
  relation: z.enum(["above", "below"]).default("below"),
  // "all" = relative to all project layers; otherwise a project layer id (number) as a string
  target: z.string().default("all"),
});
export type BasemapLayerSetting = z.infer<typeof basemapLayerSettingSchema>;

// keyed by basemap layer id; sparse — only overridden layers are stored
export const basemapLayerConfigSchema = z.record(basemapLayerSettingSchema);
export type BasemapLayerConfig = z.infer<typeof basemapLayerConfigSchema>;

export const customBasemapSchema = z.discriminatedUnion("type", [
  baseCustomBasemapSchema.extend({
    type: z.literal("vector"),
    url: z.string().url(),
    layer_config: basemapLayerConfigSchema.optional(),
  }),
  baseCustomBasemapSchema.extend({
    type: z.literal("raster"),
    url: z
      .string()
      .max(2048)
      .refine((s) => s.startsWith("http://") || s.startsWith("https://"), {
        message: "URL must start with http:// or https://",
      })
      .refine(
        (s) => s.includes("{z}") && s.includes("{x}") && s.includes("{y}"),
        { message: "URL must contain {z}, {x}, and {y} placeholders" }
      ),
  }),
  baseCustomBasemapSchema.extend({
    type: z.literal("solid"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
  }),
]);

export type CustomBasemap = z.infer<typeof customBasemapSchema>;

export const projectSchema = contentMetadataSchema.extend({
  folder_id: z.string(),
  id: z.string(),
  max_extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().nullable(),
  builder_config: builderConfigSchema.default({
    settings: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interface: basicLayout.interface as any,
  }),
  basemap: z.string().nullable().default("streets"),
  custom_basemaps: z.array(customBasemapSchema).default([]),
  updated_at: z.string().optional(),
  created_at: z.string().optional(),
  shared_with: shareProjectSchema.optional(),
  owned_by: publicUserSchema.optional(),
  my_role: z.string().nullish(),
  // The space that owns this project (Content Spaces). `space_name` is null
  // for a personal space — its owner's name is not exposed here.
  space_id: z.string().uuid().optional().nullable(),
  space_kind: z.enum(["personal", "team", "organization"]).optional().nullable(),
  space_name: z.string().optional().nullable(),
  // Count of this project's linked live layers that live in a personal
  // space; null when the project is itself in a personal space.
  personally_owned_layer_count: z.number().optional().nullable(),
  // Restricted (D9): its own flag, and whether a restricted folder above it
  // closes it instead. Sent by the single-project read.
  restricted: z.boolean().optional(),
  restricted_inherited: z.boolean().optional(),
});

// order: int = Field(0, description="Visual sorting order")
// layer_project_group_id: int | None = Field(None, description="Parent group ID")
export const projectLayerSchema = layerSchema.extend({
  /** The dataset's own last change — `updated_at` also moves when this
   * project restyles the layer, because the tile source keys on it. */
  dataset_updated_at: z.string().optional(),
  id: z.number(),
  // See layerSchema: absent for a catalog layer.
  folder_id: z.string().nullish(),
  query: z
    .object({
      metadata: z.object({}).passthrough().optional(),
      cql: z
        .object({
          op: z.string().optional(),
          args: z.array(z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .nullable()
    .optional(),
  layer_id: z.string().uuid(),
  order: z.number().optional(),
  layer_project_group_id: z.number().nullable().optional(),
  charts: z.object({}).optional(),
  // D7: true when the current user has no access of their own to the
  // underlying dataset. The backend then whitelists the row to id/layer_id/
  // name/type/feature_layer_type/feature_layer_geometry_type/order/
  // layer_project_group_id, with `properties: {}` and every other
  // style/metadata field null — nothing here may be dereferenced for a
  // locked row.
  locked: z.boolean().default(false),
});

export const projectLayerGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  properties: z.record(z.any()).nullable().optional(),
  order: z.number().optional(),
  project_id: z.string().uuid(),
  parent_id: z.number().nullable().optional(),
  // Set when this group holds a bundle's layers; its membership is locked.
  bundle_id: z.string().uuid().nullable().optional(),
  children: z.array(z.union([z.lazy(() => projectLayerGroupSchema), projectLayerSchema])).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const projectPublicSchemaConfig = z.object({
  project: projectSchema,
  layers: z.array(layerSchema),
  layer_groups: z.array(projectLayerGroupSchema).optional().default([]),
});

export const projectPublicAnalyticsSchema = z.object({
  provider: z.string(),
  config: z.record(z.unknown()),
});

export const projectPublicSchema = z.object({
  created_at: z.string(),
  updated_at: z.string(),
  project_id: z.string(),
  config: projectPublicSchemaConfig,
  custom_domain_id: z.string().uuid().nullable().optional(),
  analytics_id: z.string().uuid().nullable().optional(),
  tracking_require_consent: z.boolean().optional(),
  analytics: projectPublicAnalyticsSchema.nullable().optional(),
});

export const projectLayerTreeNodeSchema = z.object({
  id: z.number(),
  // Differentiates between a Group folder and a Layer link
  type: z.enum(["group", "layer"]),
  name: z.string(),
  parent_id: z.number().nullable().optional(),
  order: z.number(),
  extent: z.string().default(DEFAULT_WKT_EXTENT),
  // Set on group nodes backed by a bundle (locked membership).
  bundle_id: z.string().uuid().nullable().optional(),
  // Layer Specifics (Nullable for groups)
  layer_id: z.string().uuid().nullable().optional(),
  layer_type: z.string().nullable().optional(),
  geometry_type: z.string().nullable().optional(),
  // Dictionary / JSON properties
  properties: z.record(z.any()).nullable().optional(),
  other_properties: z.record(z.any()).nullable().optional(),
  query: z.record(z.any()).nullable().optional(),
  user_id: z.string().optional(),
  is_catalog: z.boolean().optional(),
  // See projectLayerSchema: a locked node carries no style/data to draw.
  locked: z.boolean().optional(),
});

export const projectLayerTreeUpdateItemSchema = z.object({
  id: z.number(),
  type: z.enum(["group", "layer"]),
  order: z.number(),
  parent_id: z.number().nullable().optional(),
  properties: z.record(z.any()).nullable().optional(),
});

export const projectLayerTreeUpdateSchema = z.object({
  items: z.array(projectLayerTreeUpdateItemSchema),
});

export const projectViewStateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  zoom: z.number().min(0).max(24),
  min_zoom: z.number().min(0).max(24),
  max_zoom: z.number().min(0).max(24),
  bearing: z.number().min(0).max(360),
  pitch: z.number().min(0).max(60),
});

export const postProjectSchema = z.object({
  folder_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  thumbnail_url: z.string().optional(),
  max_extent: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  initial_view_state: projectViewStateSchema.optional(),
});

const getProjectsQueryParamsSchema = getContentQueryParamsSchema.extend({});

export const projectResponseSchema = responseSchema(projectSchema);
export const projectLayersResponseSchema = responseSchema(projectLayerSchema);

// Stats for project layer
export const aggregationStatsQueryParams = z
  .object({
    operation_type: statisticOperationEnum,
    operation_value: z.string().optional(),
    group_by_column_name: z.string().optional(),
    size: z.number().default(10),
    query: z.string().optional(),
    order: orderByEnum.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.operation_type !== statisticOperationEnum.Values.count && !val.operation_value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "operation_value is required unless operation_type is 'count'",
        path: ["operation_value"],
      });
    }
  })
  .transform((data) => {
    if (data.operation_type === statisticOperationEnum.Enum.count) {
      delete data.operation_value;
    }
    Object.keys(data).forEach((key) => {
      if (data[key] === undefined) {
        delete data[key];
      }
    });
    return data;
  });

export const aggregationStatsResponseSchema = z.object({
  items: z.array(
    z.object({
      grouped_value: z.string().nullable(),
      operation_value: z.union([z.number(), z.string()]),
    })
  ),
  total_items: z.number(),
  total_count: z.number(),
});

export const histogramStatsQueryParams = z.object({
  column_name: z.string(),
  num_bins: z.number().default(10),
  method: z
    .enum([
      "equal_interval",
      "quantile",
      "standard_deviation",
      "heads_and_tails",
      "custom_breaks",
    ])
    .optional()
    .default("equal_interval"),
  custom_breaks: z.array(z.number()).optional(),
  query: z.string().optional(),
  order: orderByEnum.optional(),
});

export const histogramStatsResponseSchema = z.object({
  bins: z.array(
    z.object({
      range: z.tuple([z.number(), z.number()]),
      count: z.number(),
    })
  ),
  missing_count: z.number(),
  total_rows: z.number(),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectLayer = z.infer<typeof projectLayerSchema>;
export type ProjectLayerGroup = z.infer<typeof projectLayerGroupSchema>;
export type ProjectLayerTreeNode = z.infer<typeof projectLayerTreeNodeSchema>;
export type ProjectLayerTreeUpdate = z.infer<typeof projectLayerTreeUpdateSchema>;

export type ProjectPaginated = z.infer<typeof projectResponseSchema>;
export type PostProject = z.infer<typeof postProjectSchema>;
export type ProjectViewState = z.infer<typeof projectViewStateSchema>;
export type ProjectLayersPaginated = z.infer<typeof projectLayersResponseSchema>;
export type GetProjectsQueryParams = z.infer<typeof getProjectsQueryParamsSchema>;
export type ProjectSharedWith = z.infer<typeof shareProjectSchema>;
export type ProjectPublic = z.infer<typeof projectPublicSchema>;
export type BuilderConfigSchema = z.infer<typeof builderConfigSchema>;
export type BuilderPanelSchema = z.infer<typeof builderPanelSchema>;
export type BuilderWidgetSchema = z.infer<typeof builderWidgetSchema>;
export type SearchSettings = z.infer<typeof builderConfigSchema>["settings"]["search"];
export type AggregationStatsQueryParams = z.infer<typeof aggregationStatsQueryParams>;
export type AggregationStatsResponse = z.infer<typeof aggregationStatsResponseSchema>;
export type HistogramStatsQueryParams = z.infer<typeof histogramStatsQueryParams>;
export type HistogramStatsResponse = z.infer<typeof histogramStatsResponseSchema>;
