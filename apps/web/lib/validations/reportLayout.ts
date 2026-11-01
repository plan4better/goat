import * as z from "zod";

import { CUSTOM_PAGE_MAX_MM, CUSTOM_PAGE_MIN_MM } from "@/lib/print/units";

// Page configuration
export const pageConfigSchema = z.object({
  size: z.enum(["A4", "A3", "A2", "A1", "Letter", "Legal", "Tabloid", "Custom"]).default("A4"),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  margins: z
    .object({
      top: z.number().default(10),
      right: z.number().default(10),
      bottom: z.number().default(10),
      left: z.number().default(10),
    })
    .default({ top: 10, right: 10, bottom: 10, left: 10 }),
  // A Custom page's own sides in millimetres; unused for a named size.
  width: z.number().min(CUSTOM_PAGE_MIN_MM).max(CUSTOM_PAGE_MAX_MM).optional(),
  height: z.number().min(CUSTOM_PAGE_MIN_MM).max(CUSTOM_PAGE_MAX_MM).optional(),
  snapToGuides: z.boolean().default(false), // Enable/disable snapping to guides
  showRulers: z.boolean().default(false), // Show rulers on canvas
  dpi: z.number().optional(),
  export_format: z.enum(["pdf", "png", "jpeg"]).optional(),
});

// Layout grid configuration
export const layoutGridConfigSchema = z
  .object({
    type: z.enum(["grid", "freeform"]).default("grid"),
    columns: z.number().default(12),
    rows: z.number().default(12),
    gap: z.number().default(5),
  })
  .default({
    type: "grid",
    columns: 12,
    rows: 12,
    gap: 5,
  });

// Element position
export const elementPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  z_index: z.number().default(0),
});

// Border style configuration
export const borderStyleSchema = z.object({
  enabled: z.boolean().default(false),
  color: z.string().default("#000000"),
  width: z.number().min(0.1).max(5).default(0.5), // Width in mm (0.1 to 5mm)
});

// Background style configuration
export const backgroundStyleSchema = z.object({
  enabled: z.boolean().default(false),
  color: z.string().default("#ffffff"),
  opacity: z.number().min(0).max(1).default(1),
});

// Element style
export const elementStyleSchema = z
  .object({
    border: borderStyleSchema.optional(),
    background: backgroundStyleSchema.optional(),
    padding: z.number().default(0),
    opacity: z.number().min(0).max(1).default(1),
  })
  .optional();

// Print element types - includes builder chart types (histogram_chart, categories_chart, pie_chart)
export const reportElementTypes = z.enum([
  "map",
  "chart", // Legacy - for backwards compatibility
  "histogram_chart",
  "categories_chart",
  "pie_chart",
  "text",
  "image",
  "legend",
  "scalebar",
  "north_arrow",
  "table",
  "divider",
  "qr_code",
  "metadata",
]);

// =============================================================================
// ATLAS: Per-Map Element Control Settings
// =============================================================================

/**
 * Atlas control settings for map elements.
 * Defines how a specific map element responds to atlas iteration.
 * Similar to QGIS "Controlled by Atlas" settings on map items.
 */
export const mapAtlasControlSchema = z
  .object({
    /** Whether this map follows the atlas feature */
    enabled: z.boolean().default(false),
    /** How the map fits to the atlas feature */
    mode: z.enum(["best_fit", "fixed_scale", "predefined_scales"]).default("best_fit"),
    /** Margin around the feature as percentage (0-100) */
    margin_percent: z.number().min(0).max(100).default(10),
    /** Fixed scale denominator, e.g., 5000 for 1:5000 (used when mode="fixed_scale") */
    fixed_scale: z.number().nullable().optional(),
    /** Array of scale denominators to choose from (used when mode="predefined_scales") */
    predefined_scales: z.array(z.number()).nullable().optional(),
  })
  .default({ enabled: false });

/**
 * Atlas highlight settings for overview/context maps.
 * Allows static maps to highlight the current atlas feature.
 */
export const mapAtlasHighlightSchema = z
  .object({
    /** Whether to highlight the current atlas feature on this map */
    enabled: z.boolean().default(false),
    /** Highlight style */
    style: z
      .object({
        stroke_color: z.string().default("#ff0000"),
        stroke_width: z.number().default(2),
        fill_color: z.string().default("#ff0000"),
        fill_opacity: z.number().min(0).max(1).default(0.2),
      })
      .default({}),
  })
  .optional();

/**
 * Map element specific configuration.
 * Includes atlas control settings per map.
 */
export const mapElementConfigSchema = z.object({
  /** Layer project IDs to display */
  layers: z.array(z.number()).default([]),
  /** Basemap identifier */
  basemap: z.string().optional(),
  /** Show map labels */
  show_labels: z.boolean().default(true),

  /** Atlas control - how this map responds to atlas iteration */
  atlas_control: mapAtlasControlSchema,
  /** Atlas highlight - for overview maps showing current feature */
  atlas_highlight: mapAtlasHighlightSchema,

  /**
   * Static viewport snapshot.
   * Used when atlas_control.enabled = false, or for non-atlas reports.
   */
  snapshot: z
    .object({
      center: z.tuple([z.number(), z.number()]),
      zoom: z.number(),
      bearing: z.number().default(0),
      pitch: z.number().default(0),
    })
    .optional(),
});

// =============================================================================
// ATLAS: Global Configuration (Coverage & Page Settings)
// =============================================================================

/**
 * Grid-based atlas coverage.
 * Divides a bounding box into a grid of pages.
 */
export const atlasGridCoverageSchema = z.object({
  type: z.literal("grid"),
  /** Bounding box [west, south, east, north] */
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Number of rows (optional, auto-calculated if not provided) */
  rows: z.number().min(1).max(50).optional(),
  /** Number of columns (optional, auto-calculated if not provided) */
  columns: z.number().min(1).max(50).optional(),
  /** Overlap between adjacent pages as percentage */
  overlap_percent: z.number().min(0).max(50).default(10),
});

/**
 * Feature-based atlas coverage.
 * Creates one page per feature in a coverage layer.
 * Similar to QGIS Atlas with coverage layer.
 */
export const atlasFeatureCoverageSchema = z.object({
  type: z.literal("feature"),
  /** The layer_project_id of the coverage layer */
  layer_project_id: z.number(),
  /** Attribute name to sort pages by */
  sort_by: z.string().optional(),
  /** Sort order */
  sort_order: z.enum(["asc", "desc"]).default("asc"),
  /** Only render the current feature on the coverage layer (filter others out) */
  filter_to_current_feature: z.boolean().optional(),
  /** Hide the coverage layer entirely from the map */
  hidden_coverage_layer: z.boolean().optional(),
});

/**
 * Atlas coverage - defines what drives the page iteration.
 * Can be grid-based (systematic coverage) or feature-based (one page per feature).
 */
export const atlasCoverageSchema = z.discriminatedUnion("type", [
  atlasGridCoverageSchema,
  atlasFeatureCoverageSchema,
]);

/**
 * Atlas page label configuration.
 * Defines how pages are labeled/numbered.
 */
export const atlasPageLabelSchema = z
  .object({
    /** Whether to show page labels */
    enabled: z.boolean().default(true),
    /**
     * Label template with placeholders:
     * - {page_number}: Current page number (1-based)
     * - {total_pages}: Total number of pages
     * - {feature.ATTR_NAME}: Feature attribute value (feature coverage only)
     */
    template: z.string().default("Page {page_number} of {total_pages}"),
  })
  .optional();

/**
 * Global atlas configuration.
 * Defines the iteration source (coverage) and page-level settings.
 * Individual map elements define their own atlas_control settings.
 */
export const atlasConfigSchema = z
  .object({
    /** Whether atlas/series mode is enabled */
    enabled: z.boolean().default(false),
    /** Coverage configuration - what drives the iteration */
    coverage: atlasCoverageSchema.optional(),
    /** Page labeling configuration */
    page_label: atlasPageLabelSchema,
    /**
     * Output filename template for atlas exports (PNG/JPEG).
     * Supports placeholders:
     * - {{@page_number}}: Current page number (1-based)
     * - {{@total_pages}}: Total number of pages
     * - {{@layout_name}}: Layout name
     * - {{@feature.ATTR_NAME}}: Feature attribute value
     * Use "/" to create folder structure inside the ZIP.
     * Duplicates get auto-suffixed (_2, _3, etc.)
     */
    file_name_template: z.string().optional(),
  })
  .optional();

// =============================================================================
// Report Element Schema
// =============================================================================

// Report element schema
export const reportElementSchema = z.object({
  id: z.string().uuid(),
  type: reportElementTypes,
  position: elementPositionSchema,
  /** Generic config - type depends on element type */
  config: z.record(z.any()),
  style: elementStyleSchema,
  /** Map-specific config (only used when type="map") */
  map_config: mapElementConfigSchema.optional(),
});

// Theme configuration
export const themeConfigSchema = z
  .object({
    colors: z.object({
      primary: z.string(),
      secondary: z.string(),
      text: z.string(),
      background: z.string(),
    }),
    fonts: z.object({
      heading: z.string(),
      body: z.string(),
    }),
  })
  .optional();

// Report layout config (stored in JSONB)
export const reportLayoutConfigSchema = z.object({
  page: pageConfigSchema,
  layout: layoutGridConfigSchema,
  elements: z.array(reportElementSchema).default([]),
  theme: themeConfigSchema,
  atlas: atlasConfigSchema,
});

/** A layout with nothing on it yet: an A4 portrait page on the default grid,
 * no elements, no atlas — what "Blank layout" creates. */
export const createEmptyReportLayoutConfig = (): ReportLayoutConfig =>
  reportLayoutConfigSchema.parse({ page: {}, layout: {}, elements: [], atlas: {} });

// Full report layout schema (from API)
export const reportLayoutSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  is_default: z.boolean().default(false),
  is_predefined: z.boolean().default(false),
  config: reportLayoutConfigSchema,
  thumbnail_url: z.string().nullable().optional(),
  /** Counts the stored layout's changes; a save sends it back as
   * `base_revision`. Absent from a template's layout. */
  revision: z.number().int().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

// Schema for creating a report layout
export const reportLayoutCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  is_default: z.boolean().optional().default(false),
  config: reportLayoutConfigSchema,
});

// Schema for updating a report layout
export const reportLayoutUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  is_default: z.boolean().optional(),
  config: reportLayoutConfigSchema.optional(),
  /** The revision the change was made on: core refuses the save (409) when
   * the stored layout has moved on since. */
  base_revision: z.number().int().nullable().optional(),
});

// Infer TypeScript types
export type PageConfig = z.infer<typeof pageConfigSchema>;
export type LayoutGridConfig = z.infer<typeof layoutGridConfigSchema>;
export type ElementPosition = z.infer<typeof elementPositionSchema>;
export type ElementStyle = z.infer<typeof elementStyleSchema>;
export type ReportElementType = z.infer<typeof reportElementTypes>;
export type ReportElement = z.infer<typeof reportElementSchema>;
export type ThemeConfig = z.infer<typeof themeConfigSchema>;
export type AtlasConfig = z.infer<typeof atlasConfigSchema>;
export type AtlasCoverage = z.infer<typeof atlasCoverageSchema>;
export type AtlasGridCoverage = z.infer<typeof atlasGridCoverageSchema>;
export type AtlasFeatureCoverage = z.infer<typeof atlasFeatureCoverageSchema>;
export type AtlasPageLabel = z.infer<typeof atlasPageLabelSchema>;
export type MapAtlasControl = z.infer<typeof mapAtlasControlSchema>;
export type MapAtlasHighlight = z.infer<typeof mapAtlasHighlightSchema>;
export type MapElementConfig = z.infer<typeof mapElementConfigSchema>;
export type ReportLayoutConfig = z.infer<typeof reportLayoutConfigSchema>;
export type ReportLayout = z.infer<typeof reportLayoutSchema>;
export type ReportLayoutCreate = z.infer<typeof reportLayoutCreateSchema>;
export type ReportLayoutUpdate = z.infer<typeof reportLayoutUpdateSchema>;
