import type { Layer, PopupProperties } from "@/lib/validations/layer";
import type { FormatNumberTypes } from "@/lib/validations/common";
import type { MapGeoJSONFeature } from "react-map-gl/maplibre";


export enum EditorModes {
  DRAW = "draw",
  MODIFY_GEOMETRY = "modify_geometry",
  MODIFY_ATTRIBUTES = "modify_attributes",
  DELETE = "delete",
}

export type MapPopoverEditorProps = {
  title?: string;
  lngLat?: [number, number];
  feature?: MapGeoJSONFeature | undefined;
  editMode: EditorModes;
  layer: Layer;
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConfirm: (payload: any) => void;
};



export interface MapPopoverInfoProps {
  title: string;
  properties?: Record<string, string>; // Keep properties flexible
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jsonProperties?: Record<string, Array<{ [key: string]: any }>>; // Allow any value type in data
  lngLat: [number, number];
  /**
   * Optional layer id. When set, the popup applies the layer's
   * per-field formatting (kind + display_config from queryables) to
   * property values whose key matches a known column.
   */
  layerId?: string;
  /**
   * The clicked ProjectLayer's own id (`layer_project.id`). `layerId`
   * carries the dataset id, which is ambiguous when the same dataset
   * backs several project layers with different popup configs — popup
   * hosts resolve the owning layer by this id first.
   */
  projectLayerId?: string;
  /**
   * When a field_list interaction is configured, maps column names to
   * display labels and controls which fields are shown (and in what order).
   */
  fieldLabels?: Record<string, string>;
  fieldOrder?: string[];
  /**
   * Per-field prefix/suffix/format overrides from the field_list config.
   * Applied after kind-aware formatting (so area units are preserved).
   */
  fieldDecorators?: Record<string, { prefix?: string; suffix?: string; format?: FormatNumberTypes }>;
  /**
   * Snapshot of the clicked feature's full unfiltered properties, taken
   * at click time. Used by `MapFeaturePopover` for {{token}} substitution
   * so the popup stays bound to the originally-clicked feature even when
   * unrelated UI changes (e.g. switching the selected layer in the panel)
   * mutate the reactive `highlightedFeature` state.
   */
  featureProperties?: Record<string, unknown>;
  /**
   * How the popup was opened. Used by the active-feature pulse layer to
   * decide between a pulsing ring (click) and a static dot (hover) —
   * hover popups are transient and the pulse animation reads too loud.
   */
  triggeredBy?: "click" | "hover";
  /** The popup shown instead of the layer's own: a hexagon's (lib/style/h3Popup.ts). */
  popup?: PopupProperties;
  onClose: () => void;
}

