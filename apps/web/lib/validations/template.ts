import * as z from "zod";

import { contentCreatorSchema, contentRole } from "@/lib/validations/content";

/** The three kinds shown on a template card (T1) — derived server-side from
 * `payload_kind`, not chosen by the author. */
export const templateKind = z.enum(["workflow", "dashboard", "layout"]);

/** What a template's frozen payload actually is (T1/T2): a workflow or
 * layout config snapshot, or a hidden frozen project copy. */
export const templatePayloadKind = z.enum(["workflow", "layout", "project"]);

/** The GOAT catalog shelf state (T4). v1 only ever moves between `none` and
 * `published`; `proposed`/`declined` are reserved for the later submission flow. */
export const templateCatalogStatus = z.enum(["none", "proposed", "published", "declined"]);

/** A declared input slot on a saved template (T5) — mirrors
 * `core.schemas.template.TemplateInput`. */
export const templateInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  mode: z.enum(["ship", "ask"]),
  layer_id: z.string().uuid().nullable(),
  layer_type: z.enum(["feature", "table", "raster"]).nullable(),
  geometry_type: z.string().nullable(),
  from_catalog: z.boolean().default(false),
});

/** Where a template is saved from, or re-snapshotted from on refresh (T8) —
 * mirrors `core.schemas.template.TemplateSource`. */
export const templateSourceSchema = z.object({
  kind: z.enum(["workflow", "layout", "project"]),
  project_id: z.string().uuid(),
  workflow_id: z.string().uuid().nullable().optional(),
  layout_id: z.string().uuid().nullable().optional(),
});

/** One row of a template preview's `datasets_needing_share` (T6) — a shipped
 * dataset the destination space's audience cannot read yet. */
export const datasetShareLineSchema = z.object({
  layer_id: z.string().uuid(),
  name: z.string(),
  from_catalog: z.boolean(),
  current_audience: z.enum(["personal", "team", "organization"]),
});

/** Response of `POST /template/preview`: what saving a source into a folder
 * would detect, without writing anything. `.passthrough()` so a field added
 * on the backend later (it is under active development) does not break
 * parsing here. */
export const templatePreviewSchema = z
  .object({
    detected_inputs: z.array(templateInputSchema),
    kinds: z.array(z.string()),
    datasets_needing_share: z.array(datasetShareLineSchema).default([]),
  })
  .passthrough();

/** Body of `POST /template` — mirrors `TemplateCreate`. */
export const templateCreateSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  categories: z.array(z.string()).default([]),
  folder_id: z.string().uuid(),
  source: templateSourceSchema,
  inputs: z.array(templateInputSchema).default([]),
  share_datasets: z.array(z.string().uuid()).default([]),
  thumbnail_url: z.string().nullable().optional(),
  /** For a layout payload: the page it prints on, read off the config by the
   * client and stored verbatim. */
  page_size: z.string().nullable().optional(),
  page_orientation: z.enum(["portrait", "landscape"]).nullable().optional(),
});

/** Body of `PATCH /template/{id}`: metadata, plus the folder a Move puts the
 * template in — that folder has to be one in the template's own space, since
 * leaving the space is a transfer, not a move. */
export const templateUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  categories: z.array(z.string()).optional(),
  thumbnail_url: z.string().nullable().optional(),
  folder_id: z.string().uuid().optional(),
  /** Re-labelled with the config: a refresh re-freezes a layout, which can
   * change the page it prints on. */
  page_size: z.string().nullable().optional(),
  page_orientation: z.enum(["portrait", "landscape"]).nullable().optional(),
});

/** One node of a workflow preview descriptor: where it sits on the canvas,
 * how big it is there, what it is called and which node type it is. */
export const templatePreviewNodeSchema = z.object({
  label: z.string().default(""),
  type: z.string().default(""),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  /** Which of the node type's icons the canvas shows: a dataset's geometry
   * (`point`/`line`/`polygon`/`table`), a tool's process id, `export_dataset`
   * for an export, `if` for a branch. Null for an annotation, which shows
   * none, and absent on a descriptor built before the field existed. */
  icon: z.string().nullable().optional(),
  /** The colour the node is painted in, for the one node type that carries
   * one: an annotation's own `data.backgroundColor`, as `#rgb`/`#rrggbb`.
   * Null for every other type, for an annotation with no colour of its own,
   * and on a descriptor built before the field existed — the drawing then
   * paints the note in the colour the canvas defaults to. */
  color: z.string().nullable().optional(),
  /** An annotation's own note markup, sanitised to the drawing's allow-list
   * (`sanitizeNoteHtml`). Only the client builds it — from the config the
   * author owns, for the pre-save preview and the PNG — so it is optional
   * and a descriptor without it draws an untexted note card. */
  html: z.string().nullable().optional(),
});

/** The camera a layout's map frame is frozen at — the centre and the zoom the
 * element's own `config.viewState` carries. */
export const templatePreviewViewStateSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  zoom: z.number(),
});

/** What a layout element is styled with, as the layout stores it on the
 * element's own `style` — the enabled halves of `elementStyleSchema` in
 * `lib/validations/reportLayout.ts`, reduced to what a drawing paints. A
 * field is carried only where the element actually asks for it: a layout
 * frames and fills nothing by default. */
export const templatePreviewElementStyleSchema = z.object({
  /** The frame the element draws, `width` in page millimetres. Absent where
   * it draws none. */
  border: z.object({ color: z.string(), width: z.number() }).nullable().optional(),
  /** The ground the element is filled with. Absent where it has none. */
  background: z.object({ color: z.string(), opacity: z.number() }).nullable().optional(),
  /** The inset the element keeps its content in, in page millimetres. */
  padding: z.number().nullable().optional(),
  /** How opaque the element is as a whole. Absent where it is opaque. */
  opacity: z.number().nullable().optional(),
});

/** One element of a layout preview descriptor, in page units.
 *
 * Beyond the box, an element carries the little of its own content a drawing
 * can show: the three payload fields below. Only the client builds them —
 * from the config the author owns — so each is optional, and a descriptor
 * without them draws the placeholder glyph the element type reads as. */
export const templatePreviewElementSchema = z.object({
  type: z.string().default(""),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** A map frame's frozen camera, which a drawing fetches a static basemap
   * frame for. Absent on every other element type, and on a map frame that
   * names no camera. */
  viewState: templatePreviewViewStateSchema.nullable().optional(),
  /** A text block's own markup, sanitised to the drawing's allow-list
   * (`sanitizeNoteHtml`) — so a title is drawn as its real words. */
  html: z.string().nullable().optional(),
  /** The size that markup's first sized run declares, in the layout canvas's
   * own pixels: the base a drawing sets the text at, scaled into its frame. */
  fontSize: z.number().nullable().optional(),
  /** A legend's own title, as plain text. */
  title: z.string().nullable().optional(),
  /** What the element is framed and filled with. Absent where it asks for
   * neither, which is what a layout element does by default. */
  style: templatePreviewElementStyleSchema.nullable().optional(),
});

/** The structure of a payload, as the client builds it from a config it can
 * see (`descriptorFromWorkflowConfig` / `descriptorFromLayoutConfig`):
 * enough to draw the payload, never any of its data. Purely local — nothing
 * stores or answers it. It is what the save dialog's live preview draws and
 * what the PNG writers are handed. */
export const templatePreviewDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    nodes: z.array(templatePreviewNodeSchema).default([]),
    /** Index pairs into `nodes`. */
    edges: z.array(z.tuple([z.number(), z.number()])).default([]),
  }),
  z.object({
    kind: z.literal("layout"),
    orientation: z.enum(["portrait", "landscape"]).default("portrait"),
    page: z.object({ width: z.number(), height: z.number() }),
    elements: z.array(templatePreviewElementSchema).default([]),
  }),
  z.object({
    kind: z.literal("project"),
    layers: z.number().int().default(0),
  }),
]);

/** `GET /template/{id}` only: where the template was saved from, with the
 * names the edit dialog links and whether a refresh from there can work —
 * mirrors `core.schemas.template.TemplateSourceInfo`. */
export const templateSourceInfoSchema = z.object({
  kind: templatePayloadKind,
  project_id: z.string().uuid().nullable(),
  project_name: z.string().nullable(),
  workflow_id: z.string().uuid().nullable().optional(),
  workflow_name: z.string().nullable().optional(),
  layout_id: z.string().uuid().nullable().optional(),
  layout_name: z.string().nullable().optional(),
  available: z.boolean(),
});

/** Response shape for the template API's read routes — mirrors `TemplateRead`. */
export const templateReadSchema = z.object({
  /** Filled by `POST /template/{id}/refresh` when re-snapshotting now ships
   * datasets the template's space audience cannot read yet; empty otherwise. */
  datasets_needing_share: z.array(datasetShareLineSchema).default([]),
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  categories: z.array(z.string()).default([]),
  thumbnail_url: z.string().nullable(),
  /** The page a layout template prints on, as its author saved it — the two
   * values a card labels it with without reading the frozen config. Null for
   * a workflow or project payload, and on a template saved before the
   * fields existed. */
  page_size: z.string().nullable().optional(),
  page_orientation: z.enum(["portrait", "landscape"]).nullable().optional(),
  space_id: z.string().uuid(),
  folder_id: z.string().uuid(),
  created_by: contentCreatorSchema.nullable().optional(),
  payload_kind: templatePayloadKind,
  kinds: z.array(templateKind),
  inputs: z.array(templateInputSchema).default([]),
  ships_sample_data: z.boolean().default(false),
  catalog_status: templateCatalogStatus,
  source_ref: z.record(z.unknown()).default({}),
  source: templateSourceInfoSchema.nullable().optional(),
  my_role: contentRole,
  created_at: z.string(),
  updated_at: z.string(),
  /** Only populated on `?include_config=true` for an owner/editor caller. */
  config: z.record(z.unknown()).nullable().optional(),
});

/** Response of `GET /template`: one page of the caller's readable templates. */
export const templatePageSchema = z.object({
  items: z.array(templateReadSchema),
  total: z.number().int(),
});

/** One row of `GET /template/categories`: a category in use on the caller's
 * readable templates, and how many of them carry it. Grouped
 * case-insensitively server-side, so `name` is one spelling of it. */
export const templateCategoryFacetSchema = z.object({
  name: z.string(),
  count: z.number().int(),
});

/** Body of `POST /template/{id}/use` (T7) — mirrors `TemplateUseRequest`. */
export const templateUseRequestSchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  target_folder_id: z.string().uuid().nullable().optional(),
  name: z.string().nullable().optional(),
  bindings: z.record(z.string().uuid()).default({}),
});

/** Response of `POST /template/{id}/use`: what got created, what got linked,
 * and which inputs still need the caller's attention. */
export const templateUseResultSchema = z.object({
  project_id: z.string().uuid(),
  workflow_id: z.string().uuid().nullable().optional(),
  layout_id: z.string().uuid().nullable().optional(),
  added_layer_project_ids: z.array(z.number().int()).default([]),
  unresolved_inputs: z.array(templateInputSchema).default([]),
});

/** Body of `POST /template/{id}/grant` — mirrors `TemplateGrantCreate`. */
export const templateGrantCreateSchema = z.object({
  grantee_type: z.enum(["user", "team", "organization"]),
  grantee_id: z.string().uuid(),
  role: z.enum(["template-viewer", "template-editor"]),
});

/** One row of `GET /template/{id}/grant` — mirrors `TemplateGrantRead`. */
export const templateGrantReadSchema = z.object({
  id: z.string().uuid(),
  grantee_type: z.enum(["user", "team", "organization"]),
  grantee_id: z.string().uuid(),
  grantee_name: z.string(),
  role: z.enum(["template-viewer", "template-editor"]),
  granted_by: z.string().uuid().nullable(),
  created_at: z.string(),
});

export const templateGrantsResponseSchema = z.object({
  grants: z.array(templateGrantReadSchema),
});

/** The template browser's source segments (T7/T9) — `all` unions every
 * scope the caller has. */
export type TemplateSourceFilter = "all" | "goat" | "mine" | "team" | "org";

export type TemplateKind = z.infer<typeof templateKind>;
export type TemplatePayloadKind = z.infer<typeof templatePayloadKind>;
export type TemplateCatalogStatus = z.infer<typeof templateCatalogStatus>;
export type TemplateInput = z.infer<typeof templateInputSchema>;
export type TemplateSource = z.infer<typeof templateSourceSchema>;
export type TemplateSourceInfo = z.infer<typeof templateSourceInfoSchema>;
export type DatasetShareLine = z.infer<typeof datasetShareLineSchema>;
export type TemplatePreview = z.infer<typeof templatePreviewSchema>;
export type TemplatePreviewNode = z.infer<typeof templatePreviewNodeSchema>;
export type TemplatePreviewElement = z.infer<typeof templatePreviewElementSchema>;
export type TemplatePreviewViewState = z.infer<typeof templatePreviewViewStateSchema>;
export type TemplatePreviewElementStyle = z.infer<typeof templatePreviewElementStyleSchema>;
export type TemplatePreviewDescriptor = z.infer<typeof templatePreviewDescriptorSchema>;
/** The workflow branch of the descriptor on its own — what the geometry and
 * the snapshot renderer take. */
export type TemplateWorkflowPreview = Extract<TemplatePreviewDescriptor, { kind: "workflow" }>;
export type TemplateLayoutPreview = Extract<TemplatePreviewDescriptor, { kind: "layout" }>;
/** The input shape, not the parsed/defaulted one — a caller building a save
 * request should not have to spell out `categories`/`inputs`/`share_datasets`
 * when they mean the backend's own `[]` default for each. */
export type TemplateCreate = z.input<typeof templateCreateSchema>;
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;
export type TemplateRead = z.infer<typeof templateReadSchema>;
export type TemplatePage = z.infer<typeof templatePageSchema>;
export type TemplateCategoryFacet = z.infer<typeof templateCategoryFacetSchema>;
/** Input shape — `bindings` defaults to `{}` and should stay optional for a
 * caller with nothing to bind. */
export type TemplateUseRequest = z.input<typeof templateUseRequestSchema>;
export type TemplateUseResult = z.infer<typeof templateUseResultSchema>;
export type TemplateGrantCreate = z.infer<typeof templateGrantCreateSchema>;
export type TemplateGrantRead = z.infer<typeof templateGrantReadSchema>;
export type TemplateGrantsResponse = z.infer<typeof templateGrantsResponseSchema>;
