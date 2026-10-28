import { formatFieldValue } from "@/lib/utils/formatFieldValue";
import { formatNumber } from "@/lib/utils/format-number";
import type { FormatNumberTypes } from "@/lib/validations/common";
import type { FieldKind as LayerFieldKind } from "@/lib/validations/layer";

// Local FieldKind alias so callers don't have to depend on layer validations
// for the rare custom-kind case; falls back to a loose string union.
export type FieldKind = LayerFieldKind | string;

export interface LayerField {
  name: string;
  type: string;
  kind?: FieldKind;
  /** Formula fields only — the result kind that drives formatting */
  output_kind?: string;
  display_config?: Record<string, unknown>;
}

export interface FieldDecorator {
  format?: FormatNumberTypes;
  prefix?: string;
  suffix?: string;
}

export interface FormatFeaturePropertiesInput {
  properties: Record<string, unknown>;
  layerFields: LayerField[];
  fieldLabels?: Record<string, string>;
  fieldOrder?: string[];
  fieldDecorators?: Record<string, FieldDecorator>;
  lang: string;
}

export interface FormatFeaturePropertiesResult {
  /** Output keyed by display label (`fieldLabels[k] ?? k`). */
  formatted: Record<string, string>;
  /** Output keyed by the original column name. */
  byColumn: Record<string, string>;
}

/**
 * Apply per-field, kind-aware formatting (area m²→ha, length, number with
 * format/prefix/suffix) to a feature's raw properties.
 *
 * Returns two parallel maps populated by a single pass:
 *  - `formatted`: keyed by display label — used by the legacy MapPopoverInfo /
 *    LayerInfo renderer.
 *  - `byColumn`: keyed by the original column name — used by the new popup
 *    renderer for `{{token}}` substitution.
 */
export function formatFeatureProperties(
  input: FormatFeaturePropertiesInput,
): FormatFeaturePropertiesResult {
  const {
    properties,
    layerFields,
    fieldLabels,
    fieldOrder,
    fieldDecorators,
    lang,
  } = input;

  const byName = new Map(layerFields.map((f) => [f.name, f]));
  const formatted: Record<string, string> = {};
  const byColumn: Record<string, string> = {};
  const keys = fieldOrder?.length ? fieldOrder : Object.keys(properties);

  for (const k of keys) {
    if (!(k in properties)) continue;
    // GeoJSON sources hand nested values over as objects, vector tiles as
    // JSON strings; both render as the JSON text.
    const raw = properties[k];
    const v = typeof raw === "object" && raw !== null ? JSON.stringify(raw) : raw;
    const f = byName.get(k);
    const displayKey = fieldLabels?.[k] ?? k;
    if (!f || v === null || v === undefined || v === "") {
      const out = v == null ? "" : String(v);
      formatted[displayKey] = out;
      byColumn[k] = out;
      continue;
    }
    const rawKind = f.kind === "formula" ? (f.output_kind ?? "string") : f.kind;
    const kind: FieldKind =
      (rawKind as FieldKind) ?? (f.type === "number" ? "number" : "string");
    // Coerce numeric strings back to a number so kind-aware formatting applies.
    const numericValue =
      f.type === "number" && !isNaN(Number(v)) ? Number(v) : v;
    const decorator = fieldDecorators?.[k];
    // For plain number fields, a field-list format override takes precedence.
    // For dimensioned kinds (area, length, perimeter), always use
    // formatFieldValue so that the configured unit (e.g. ha) is applied. A
    // format override on these kinds has no effect — unit conversion takes
    // priority.
    let result: string;
    if (decorator?.format && kind === "number") {
      result = formatNumber(Number(numericValue), decorator.format, lang);
    } else {
      result = formatFieldValue(
        numericValue,
        kind as LayerFieldKind,
        f.display_config ?? {},
      );
    }
    if (decorator?.prefix || decorator?.suffix) {
      result = `${decorator.prefix ?? ""}${result}${decorator.suffix ?? ""}`;
    }
    formatted[displayKey] = result;
    byColumn[k] = result;
  }

  return { formatted, byColumn };
}
