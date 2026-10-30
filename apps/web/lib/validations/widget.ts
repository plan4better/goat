import * as z from "zod";

import { DEFAULT_WIDGET_COLOR } from "@/lib/constants/ui";
import { DEFAULT_COLOR_RANGE } from "@/lib/constants/color";
import { formatNumberTypes, sortTypes, statisticOperationEnum } from "@/lib/validations/common";
import { colorRange } from "@/lib/validations/layer";

export { formatNumberTypes };
export type { FormatNumberTypes } from "@/lib/validations/common";

export const informationTypes = z.enum(["layers", "bookmarks", "comments"]);
export const dataTypes = z.enum(["filter", "table", "numbers", "feature_list", "rich_text"]);
export const chartTypes = z.enum(["histogram_chart", "categories_chart", "pie_chart"]);
export const elementTypes = z.enum(["text", "divider", "image", "tabs", "links"]);
export const widgetTypes = z.enum([
  ...informationTypes.options,
  ...dataTypes.options,
  ...chartTypes.options,
  ...elementTypes.options,
]);

// Popup display configuration shared by InfoChip, Links, ProjectInfo.
// Title-info popups are now embedded inline as info chips inside the rich
// text title, so no separate widget-level option is needed.
export const popupTypes = z.enum(["tooltip", "popover", "dialog"]);
export const popupPlacements = z.enum(["top", "bottom", "left", "right", "auto"]);
export const popupSizes = z.enum(["sm", "md", "lg"]);
export type PopupType = z.infer<typeof popupTypes>;
export type PopupPlacement = z.infer<typeof popupPlacements>;
export type PopupSize = z.infer<typeof popupSizes>;

export const widgetTypesWithoutConfig = [elementTypes.Values.text, elementTypes.Values.divider];


// How chart widgets respond to cross-filter selections
export const selectionResponseTypes = z.enum(["filter", "highlight"]);
export type SelectionResponseType = z.infer<typeof selectionResponseTypes>;
export const valueColorScaleTypes = z.enum([
  "quantile",
  "equal_interval",
  "standard_deviation",
  "heads_and_tails",
]);
export const histogramBinningMethodTypes = z.enum([
  "equal_interval",
  "quantile",
  "standard_deviation",
  "heads_and_tails",
  "custom_breaks",
]);
export const categoriesStyleSourceTypes = z.enum(["statistics", "group_by"]);

const sanitizeWidgetColorRangeInput = (input: unknown): unknown => {
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

const widgetColorRange = z.preprocess(sanitizeWidgetColorRangeInput, colorRange);

const chartConfigSetupBaseSchema = z.object({
  title: z.string().optional().default("Chart"),
  layer_project_id: z.number().optional(),
});

// Information configuration schemas
const informationConfigSetupBaseSchema = z.object({
  title: z.string().optional().default("Information"),
});
const informationConfigOptionsBaseSchema = z.object({
  description: z.string().optional(),
});

export const informationConfigSchema = z.object({
  type: informationTypes,
  setup: informationConfigSetupBaseSchema.optional(),
  options: informationConfigOptionsBaseSchema.optional().default({}),
});

export const layersLayoutStyleTypes = z.enum(["tree", "tabs"]);
export const layersToggleStyleTypes = z.enum(["eye", "checkbox", "switch"]);
export const layersTogglePositionTypes = z.enum(["left", "right"]);
export const layersMoreOptionsStyleTypes = z.enum(["compact", "direct_actions"]);
export const layersOutOfZoomBehaviorTypes = z.enum(["hide", "dim"]);
export const groupSwitcherLayoutTypes = z.enum(["chips", "slider", "dropdown"]);
/**
 * A layer group shown one layer at a time instead of as a list, e.g. one layer
 * per monitoring year. Picking a layer turns it on and its group siblings off.
 */
export const groupSwitcherSchema = z.object({
  layout: groupSwitcherLayoutTypes,
  show_play: z.boolean().optional().default(false),
});

export const informationLayersConfigSchema = informationConfigSchema.extend({
  type: z.literal("layers"),
  setup: informationConfigSetupBaseSchema
    .extend({
      group_info: z.record(z.string(), z.string()).optional(),
      // Per group id; a group without an entry is a plain list
      group_switchers: z.record(z.string(), groupSwitcherSchema).optional(),
    })
    .default({}),
  options: informationConfigOptionsBaseSchema
    .extend({
      show_search: z.boolean().optional().default(false),
      open_legend_by_default: z.boolean().optional().default(false),
      out_of_zoom_behavior: layersOutOfZoomBehaviorTypes.optional().default("hide"),
      layout_style: layersLayoutStyleTypes.optional().default("tree"),
      toggle_style: layersToggleStyleTypes.optional().default("eye"),
      toggle_position: layersTogglePositionTypes.optional().default("right"),
      more_options_style: layersMoreOptionsStyleTypes.optional().default("compact"),
      show_all_toggle: z.boolean().optional().default(true),
      show_group_name: z.boolean().optional().default(true),
      show_group_icons: z.boolean().optional().default(false),
      hide_legend_heading: z.boolean().optional().default(false),
      show_style_action: z.boolean().optional().default(true),
      show_view_data_action: z.boolean().optional().default(true),
      show_properties_action: z.boolean().optional().default(true),
      show_zoom_to_action: z.boolean().optional().default(true),
      excluded_layers: z.array(z.number()).optional().default([]),
      legend_hidden_layers: z.array(z.number()).optional().default([]),
      legend_simple_layers: z.array(z.number()).optional().default([]),
      downloadable_layers: z.array(z.number()).optional().default([]),
    })
    .passthrough()
    .default({}),
});

// Data configuration schemas
const dataConfigSetupBaseSchema = z.object({
  title: z.string().optional().default("Data"),
});
const dataConfigOptionsBaseSchema = z.object({
  description: z.string().optional(),
});

export const dataConfigSchema = z.object({
  type: dataTypes,
  setup: dataConfigSetupBaseSchema.optional(),
  options: dataConfigOptionsBaseSchema.optional().default({}),
});

export const numbersDataConfigSchema = dataConfigSchema.extend({
  type: z.literal("numbers"),
  setup: chartConfigSetupBaseSchema
    .extend({
      operation_type: statisticOperationEnum.optional(),
      operation_value: z.string().optional(),
      icon: z.string().optional(),
    })
    .default({}),
  options: dataConfigOptionsBaseSchema
    .extend({
      filter_by_viewport: z.boolean().optional().default(true),
      cross_filter: z.boolean().optional().default(true),
      format: formatNumberTypes.optional().default("none"),
      description: z.string().optional(),
    })
    .default({}),
});

export const richTextVariableSchema = z.object({
  id: z.string(),
  name: z.preprocess(
    (val) => (typeof val === "string" && val.length === 0 ? `var_${Date.now() % 1000}` : val),
    z.string().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  ),
  layer_project_id: z.number().optional(),
  operation_type: statisticOperationEnum.optional(),
  operation_value: z.string().optional(),
  format: formatNumberTypes.optional().default("none"),
});

export const richTextDataConfigSchema = z.object({
  type: z.literal("rich_text"),
  setup: z
    .object({
      title: z.string().optional().default("Rich Text"),
      text: z.string().optional().default(""),
      variables: z.array(richTextVariableSchema).optional().default([]),
    })
    .default({}),
  options: z
    .object({
      description: z.string().optional(),
      filter_by_viewport: z.boolean().optional().default(false),
      cross_filter: z.boolean().optional().default(true),
      hide_when_no_filter: z.boolean().optional().default(false),
      no_filter_text: z.string().optional().default(""),
    })
    .default({}),
});

export const tableModeTypes = z.enum(["records", "grouped"]);
export const tableQueryModeTypes = z.enum(["builder", "sql"]);
export const tableGroupedDisplayModes = z.enum(["flat", "collapsible"]);

const tableMetricSchema = z.object({
  operation_type: statisticOperationEnum,
  operation_value: z.string().optional(),
  label: z.string().optional(),
});

export const tableDataConfigSchema = dataConfigSchema.extend({
  type: z.literal("table"),
  setup: chartConfigSetupBaseSchema
    .extend({
      query_mode: tableQueryModeTypes.optional().default("builder"),
      mode: tableModeTypes.optional().default("records"),
      sql_query: z.string().optional(),
      visible_columns: z.array(z.string()).optional(),
      grouped_column_order: z.array(z.string()).optional(),
      sql_column_order: z.array(z.string()).optional(),
      operation_type: statisticOperationEnum.optional(),
      operation_value: z.string().optional(),
      group_by_column_name: z.string().optional(),
      group_by_secondary_column_name: z.string().optional(),
      group_by_label: z.string().optional(),
      group_by_secondary_label: z.string().optional(),
      grouped_display_mode: tableGroupedDisplayModes.optional().default("flat"),
      grouped_collapse_initial: z.enum(["expanded", "collapsed"]).optional().default("collapsed"),
      grouped_show_subtotals: z.boolean().optional().default(true),
      primary_metric_label: z.string().optional(),
      record_column_labels: z.record(z.string()).optional(),
      sql_column_labels: z.record(z.string()).optional(),
      additional_metrics: z.array(tableMetricSchema).optional().default([]),
    })
    .default({}),
  options: dataConfigOptionsBaseSchema
    .extend({
      filter_by_viewport: z.boolean().optional().default(true),
      cross_filter: z.boolean().optional().default(true),
      sort_by: z.string().optional(),
      sorting: sortTypes.optional().default("desc"),
      page_size: z.number().min(1).max(100).optional().default(10),
      size: z.number().min(1).max(5000).optional().default(50),
      sticky_header: z.boolean().optional().default(true),
      show_totals: z.boolean().optional().default(true),
      // Viewer-facing column actions. Default on, so existing dashboards keep
      // the behaviour they were published with.
      show_sort_action: z.boolean().optional().default(true),
      show_filter_action: z.boolean().optional().default(true),
      format: formatNumberTypes.optional().default("none"),
      column_formats: z.record(formatNumberTypes).optional(),
      description: z.string().optional(),
      header_color: z.string().optional(),
    })
    .default({}),
});

export const filterLayoutTypes = z.enum(["checkbox", "cards", "chips", "select", "range", "picker"]);
export const pieLayoutTypes = z.enum(["center_active", "all_labels_outside", "legend"]);
export const pieChartTypes = z.enum(["donut", "pie", "half_donut"]);
export const labelSizeTypes = z.enum(["sm", "md", "lg"]);

// Target layer schema for multi-layer attribute filtering
export const filterTargetLayerSchema = z.object({
  layer_project_id: z.number(),
  column_name: z.string(),
});

export const filterDataConfigSchema = dataConfigSchema.extend({
  type: z.literal("filter"),
  setup: chartConfigSetupBaseSchema
    .extend({
      layout: filterLayoutTypes.optional().default("select"),
      column_name: z.string().optional(),
      placeholder: z.string().optional(),
      multiple: z.boolean().optional().default(false),
      // Chips/Checkbox-specific settings
      min_visible_options: z.number().min(1).max(20).optional().default(5),
      wrap: z.boolean().optional().default(true),
      show_all_option: z.boolean().optional().default(true),
      default_value: z.array(z.string()).optional(),
      custom_order: z.array(z.string()).optional(), // Custom chip order (values in desired order)
      // Range-specific settings
      show_histogram: z.boolean().optional().default(true),
      steps: z.number().min(1).max(100).optional().default(50),
      show_slider: z.boolean().optional().default(true),
      // Range slider step unit for datetime columns
      granularity: z.enum(["minute", "hour", "day", "week", "month"]).optional(),
    })
    .default({}),
  options: dataConfigOptionsBaseSchema
    .extend({
      description: z.string().optional(),
      zoom_to_selection: z.boolean().optional().default(true),
      // Color settings (for chips, checkbox, range layouts)
      color: z.string().optional().default(DEFAULT_WIDGET_COLOR),
      // Custom label mapping for discrete filter values
      label_map: z.array(z.tuple([z.string(), z.string()])).optional(),
      // Multi-layer attribute filtering
      target_layers: z.array(filterTargetLayerSchema).optional(),
      // Cross-filter options: when enabled, filter shows only values that exist in currently filtered data
      cross_filter_options: z.boolean().optional().default(true),
      // Allow clicking map features to populate this filter
      filter_by_map_click: z.boolean().optional().default(false),
    })
    .default({}),
});

// Chart configuration schemas
const chartConfigOptionsBaseSchema = z.object({
  filter_by_viewport: z.boolean().optional().default(true),
  cross_filter: z.boolean().optional().default(true),
  description: z.string().optional(),
});
export const chartsConfigBaseSchema = z.object({
  type: widgetTypes,
  setup: chartConfigSetupBaseSchema.optional().default({}),
  options: chartConfigOptionsBaseSchema.optional().default({}),
});

// Context label configuration for showing dynamic labels based on filtered data
export const contextLabelSchema = z.object({
  // Field to check for unique value (e.g., "city_name")
  field: z.string(),
  // Value to show when multiple unique values exist (e.g., "All Cities"). If empty, nothing is shown.
  default_value: z.string().optional(),
});

export const histogramChartConfigSchema = chartsConfigBaseSchema.extend({
  type: z.literal("histogram_chart"),
  setup: chartConfigSetupBaseSchema
    .extend({
      column_name: z.string().optional(),
    })
    .default({}),
  options: chartConfigOptionsBaseSchema
    .extend({
      num_bins: z.number().min(1).max(20).optional().default(10),
      x_axis_ticks: z.array(z.number()).optional(),
      min_value: z.number().optional(),
      max_value: z.number().optional(),
      include_outliers: z.boolean().optional().default(false),
      format: formatNumberTypes.optional().default("none"),
      display_field_label: z.string().optional(),
      // Base color for bars
      color: z.string().optional().default(DEFAULT_WIDGET_COLOR),
      // Color when hovering over a bar
      highlight_color: z.string().optional().default("#f5b704"),
      // Color for selected/filtered portion (only used in highlight mode)
      selected_color: z.string().optional().default("#9333EA"),
      // How to respond to cross-filter selections: filter data or highlight selected portion
      selection_response: selectionResponseTypes.optional().default("filter"),
    })
    .default({}),
});

export const categoriesChartConfigSchema = chartsConfigBaseSchema.extend({
  type: z.literal("categories_chart"),
  setup: chartConfigSetupBaseSchema
    .extend({
      operation_type: statisticOperationEnum.optional(),
      operation_value: z.string().optional(),
      group_by_column_name: z.string().optional(),
      custom_order: z.array(z.string()).optional(), // Custom category order
    })
    .default({}),
  options: chartConfigOptionsBaseSchema
    .extend({
      format: formatNumberTypes.optional().default("none"),
      sorting: sortTypes.optional().default("asc"),
      // Toggle between attribute-based styling and simple single-color styling
      attribute_based_styling: z.boolean().optional().default(true),
      // Source field used for attribute-based styling
      style_attribute_source: categoriesStyleSourceTypes.optional().default("statistics"),
      // Value-based classification method (applied to statistical result values)
      value_color_scale: valueColorScaleTypes.optional().default("quantile"),
      // Optional single base color for all categories
      color: z.string().optional(),
      // Color range for generating bar colors (like pie chart)
      color_range: widgetColorRange.optional().default(DEFAULT_COLOR_RANGE),
      // Custom color mapping: array of [category_value, hex_color] tuples
      color_map: z.array(z.tuple([z.string(), z.string()])).optional(),
      // Custom label mapping: array of [category_value, display_label] tuples
      label_map: z.array(z.tuple([z.string(), z.string()])).optional(),
      // Color for selected/filtered portion (only used in highlight mode)
      selected_color: z.string().optional().default("#9333EA"),
      // How to respond to cross-filter selections: filter data or highlight selected portion
      selection_response: selectionResponseTypes.optional().default("filter"),
      width: z.number().min(3).max(15).optional().default(5),
      num_categories: z.number().min(1).max(15).optional().default(1),
      show_other_aggregate: z.boolean().optional().default(false),
      // Dynamic context label based on filtered data
      context_label: contextLabelSchema.optional(),
    })
    .default({}),
});

export const pieChartConfigSchema = chartsConfigBaseSchema.extend({
  type: z.literal("pie_chart"),
  setup: chartConfigSetupBaseSchema
    .extend({
      operation_type: statisticOperationEnum.optional(),
      operation_value: z.string().optional(),
      group_by_column_name: z.string().optional(),
      custom_order: z.array(z.string()).optional(), // Custom category order
    })
    .default({}),
  options: chartConfigOptionsBaseSchema
    .extend({
      layout: pieLayoutTypes.optional().default("center_active"),
      chart_type: pieChartTypes.optional().default("donut"),
      label_size: labelSizeTypes.optional().default("md"),
      num_categories: z.number().min(1).max(15).optional().default(1),
      cap_others: z.boolean().optional().default(false),
      color_range: widgetColorRange.optional().default(DEFAULT_COLOR_RANGE),
      // Custom color mapping: array of [category_value, hex_color] tuples
      color_map: z.array(z.tuple([z.string(), z.string()])).optional(),
      // Custom label mapping: array of [category_value, display_label] tuples
      label_map: z.array(z.tuple([z.string(), z.string()])).optional(),
      sorting: sortTypes.optional().default("desc"),
      // Dynamic context label based on filtered data
      context_label: contextLabelSchema.optional(),
    })
    .default({}),
});

// Element configuration schemas
export const textElementConfigSchema = z.object({
  type: z.literal("text"),
  setup: z
    .object({
      text: z.string().optional().default("Text"),
    })
    .default({}),
});

export const dividerElementConfigSchema = z.object({
  type: z.literal("divider"),
  setup: z
    .object({
      size: z.number().min(1).max(10).optional().default(1),
      orientation: z.enum(["horizontal", "vertical"]).optional().default("horizontal"),
      color: z.string().optional().default("#000000"),
      thickness: z.number().min(0.1).max(5).optional().default(1), // thickness in mm
    })
    .default({}),
});

export const imageElementConfigSchema = z.object({
  type: z.literal("image"),
  setup: z
    .object({
      url: z.string().optional(),
      alt: z.string().optional(),
    })
    .default({}),
  options: z
    .object({
      description: z.string().optional(),
      has_padding: z.boolean().optional().default(false),
    })
    .default({}),
});

// Tab schema for individual tabs
export const tabItemSchema = z.object({
  id: z.string(),
  name: z.string().default("Tab"),
  widgetIds: z.array(z.string()).default([]),
});

// Tabs container configuration schema
export const tabsContainerConfigSchema = z.object({
  type: z.literal("tabs"),
  setup: z
    .object({
      title: z.string().optional().default(""),
      full_width: z.boolean().optional().default(false),
    })
    .default({}),
  tabs: z.array(tabItemSchema).default([
    { id: "tab-1", name: "Tab 1" },
    { id: "tab-2", name: "Tab 2" },
  ]),
});

export const linksSeparatorTypes = z.enum(["vertical_line", "dot", "dash"]);

export const linksLinkTypes = z.enum(["url", "popup"]);

export const linksItemSchema = z.object({
  label: z.string(),
  url: z.string().optional(),
  link_type: linksLinkTypes.optional().default("url"),
  popup_content: z.string().optional(),
  popup_type: popupTypes.optional().default("popover"),
  popup_placement: popupPlacements.optional().default("auto"),
  popup_size: popupSizes.optional().default("md"),
});

export type LinksItemSchema = z.infer<typeof linksItemSchema>;

export const linksElementConfigSchema = z.object({
  type: z.literal("links"),
  setup: z
    .object({
      title: z.string().optional(),
      links: z.array(linksItemSchema).default([]),
    })
    .default({}),
  options: z
    .object({
      description: z.string().optional(),
      show_external_icon: z.boolean().optional().default(true),
      open_in_new_tab: z.boolean().optional().default(true),
      secondary_text: z.string().optional(),
      separator: linksSeparatorTypes.optional().default("vertical_line"),
    })
    .default({}),
});

export const configSchemas = z.union([
  informationLayersConfigSchema,
  numbersDataConfigSchema,
  tableDataConfigSchema,
  filterDataConfigSchema,
  categoriesChartConfigSchema,
  histogramChartConfigSchema,
  pieChartConfigSchema,
  textElementConfigSchema,
  dividerElementConfigSchema,
  imageElementConfigSchema,
  tabsContainerConfigSchema,
  linksElementConfigSchema,
  richTextDataConfigSchema,
]);

export const widgetSchemaMap = {
  layers: informationLayersConfigSchema,
  numbers: numbersDataConfigSchema,
  table: tableDataConfigSchema,
  filter: filterDataConfigSchema,
  histogram_chart: histogramChartConfigSchema,
  categories_chart: categoriesChartConfigSchema,
  pie_chart: pieChartConfigSchema,
  text: textElementConfigSchema,
  divider: dividerElementConfigSchema,
  image: imageElementConfigSchema,
  tabs: tabsContainerConfigSchema,
  links: linksElementConfigSchema,
  rich_text: richTextDataConfigSchema,
};

export type WidgetTypes = z.infer<typeof widgetTypes>;
export type ChartConfigBaseSchema = z.infer<typeof chartsConfigBaseSchema>;
export type HistogramChartSchema = z.infer<typeof histogramChartConfigSchema>;
export type CategoriesChartSchema = z.infer<typeof categoriesChartConfigSchema>;
export type PieChartSchema = z.infer<typeof pieChartConfigSchema>;
export type TextElementSchema = z.infer<typeof textElementConfigSchema>;
export type DividerElementSchema = z.infer<typeof dividerElementConfigSchema>;
export type ImageElementSchema = z.infer<typeof imageElementConfigSchema>;
export type TabItemSchema = z.infer<typeof tabItemSchema>;
export type TabsContainerSchema = z.infer<typeof tabsContainerConfigSchema>;
export type LayerInformationSchema = z.infer<typeof informationLayersConfigSchema>;
export type GroupSwitcherType = z.infer<typeof groupSwitcherSchema>;
export type GroupSwitcherLayoutType = z.infer<typeof groupSwitcherLayoutTypes>;
export type NumbersDataSchema = z.infer<typeof numbersDataConfigSchema>;
export type TableDataSchema = z.infer<typeof tableDataConfigSchema>;
export type FilterDataSchema = z.infer<typeof filterDataConfigSchema>;
export type FilterLayoutTypes = z.infer<typeof filterLayoutTypes>;
export type RichTextVariableSchema = z.infer<typeof richTextVariableSchema>;
export type RichTextDataSchema = z.infer<typeof richTextDataConfigSchema>;

export type WidgetChartConfig = HistogramChartSchema | CategoriesChartSchema | PieChartSchema;
export type LinksElementSchema = z.infer<typeof linksElementConfigSchema>;
export type WidgetElementConfig =
  | TextElementSchema
  | DividerElementSchema
  | ImageElementSchema
  | TabsContainerSchema
  | LinksElementSchema;
export type WidgetInformationConfig = LayerInformationSchema;
export type WidgetDataConfig =
  | NumbersDataSchema
  | TableDataSchema
  | FilterDataSchema
  | RichTextDataSchema;

export type LayersLayoutStyleType = z.infer<typeof layersLayoutStyleTypes>;
export type LayersToggleStyleType = z.infer<typeof layersToggleStyleTypes>;
export type LayersTogglePositionType = z.infer<typeof layersTogglePositionTypes>;

export type WidgetConfigSchema = z.infer<typeof configSchemas>;
