// A layer style's popup as today's popup configuration (spec 7.4): the same keys, with `field_list` written
// `fieldList`, attributes naming their field `name`, and the number options in `format_config`. Today's popup
// renderers draw it unchanged.
import type { FieldType } from "@/lib/style/compile/types";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, deepEqual, isObject } from "@/lib/style/json";
import { type PopupProperties, popupBlock, popupProperties } from "@/lib/validations/layer";

const NUMBER_OPTIONS = ["decimals", "thousands_separator", "abbreviate", "always_show_sign"] as const;

/** A UUID derived from a block's own id: today's blocks are keyed by UUIDs, GOAT Style ids are any text. */
export function stableId(text: string): string {
  let hex = "";
  for (let seed = 0; seed < 4; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const attributeType = (given: unknown, type?: FieldType): "string" | "number" | "boolean" => {
  if (given === "string" || given === "number" || given === "boolean") return given;
  if (type === "number" || type === "integer") return "number";
  return type === "boolean" ? "boolean" : "string";
};

function attribute(a: JsonObject, fields?: Record<string, FieldType>): JsonObject {
  const field = String(a.field ?? "");
  const format = isObject(a.format) ? a.format : {};
  const options = Object.fromEntries(NUMBER_OPTIONS.filter((k) => k in format).map((k) => [k, format[k]]));
  return {
    name: field,
    ...(typeof a.label === "string" ? { label: a.label } : {}),
    type: attributeType(a.type, fields?.[field]),
    ...(Object.keys(options).length ? { format_config: options } : {}),
    ...(typeof format.prefix === "string" ? { prefix: format.prefix } : {}),
    ...(typeof format.suffix === "string" ? { suffix: format.suffix } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A block's key in today's configuration: its id when that is a UUID already (a block the panel added), else a UUID
 * derived from it. */
const blockKey = (b: JsonObject, index: number): string =>
  typeof b.id === "string" && UUID.test(b.id)
    ? b.id
    : stableId(typeof b.id === "string" ? b.id : `block-${index}`);

function block(b: JsonObject, index: number, fields?: Record<string, FieldType>): JsonObject {
  const id = blockKey(b, index);
  if (b.type !== "field_list") return { ...b, id };
  const attributes = Array.isArray(b.attributes)
    ? b.attributes.filter(isObject).map((a) => attribute(a, fields))
    : [];
  return { ...b, id, type: "fieldList", attributes };
}

/** Today's popup configuration for a style's `popup`; null when the layer has no popup. */
export function toPopupConfig(popup: unknown, fields?: Record<string, FieldType>): PopupProperties | null {
  if (popup === false) return null;
  const source: JsonObject = isObject(popup) ? popup : {};
  // Raster popups (band values) come with the raster service.
  if ("bands" in source || source.enabled === false) return null;
  // A block today's popup cannot draw (a badge without its field) is left out rather than failing the popup.
  const blocks = (
    Array.isArray(source.blocks)
      ? source.blocks.filter(isObject).map((b, i) => block(b, i, fields))
      : [block({ type: "field_list", attributes: [] }, 0, fields)]
  ).filter((b) => popupBlock.safeParse(b).success);
  const parsed = popupProperties.safeParse({ ...source, blocks });
  return parsed.success ? parsed.data : popupProperties.parse({ blocks });
}

const configs = new WeakMap<object, PopupProperties | null>();

/** The popup a layer's style asks for, in today's configuration (one per document); undefined when it shows none. */
export function popupConfigOf(style: LayerStyle | null | undefined): PopupProperties | undefined {
  if (!style) return undefined;
  if (!configs.has(style)) configs.set(style, toPopupConfig(style.popup));
  return configs.get(style) ?? undefined;
}

/** What today's configuration fills in for a block of `type` that leaves keys out. */
function blockDefaults(type: unknown): JsonObject {
  // A badge needs its field to parse; the placeholder is not a default and never compared.
  const parsed = popupBlock.safeParse({ type, field: "_" });
  if (!parsed.success) return {};
  const { field: _field, ...defaults } = parsed.data as unknown as JsonObject;
  return defaults;
}

function fromAttribute(a: JsonObject, original: JsonObject | undefined): JsonObject {
  const options = isObject(a.format_config) ? a.format_config : {};
  const format: JsonObject = {
    ...Object.fromEntries(NUMBER_OPTIONS.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])),
    ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}),
    ...(typeof a.suffix === "string" ? { suffix: a.suffix } : {}),
  };
  return {
    field: a.name,
    ...(typeof a.label === "string" ? { label: a.label } : {}),
    // The type comes from the dataset unless the style names one.
    ...(original && "type" in original ? { type: a.type } : {}),
    ...(Object.keys(format).length ? { format } : {}),
  };
}

function fromBlock(b: JsonObject, original: JsonObject | undefined): JsonObject {
  const defaults = blockDefaults(b.type);
  const out: JsonObject = {};
  if (!original) out.id = b.id;
  else if (typeof original.id === "string") out.id = original.id;
  out.type = b.type === "fieldList" ? "field_list" : b.type;
  for (const [key, value] of Object.entries(b)) {
    if (key === "id" || key === "type" || value === undefined) continue;
    if (key === "attributes" && Array.isArray(value)) {
      const before =
        original && Array.isArray(original.attributes) ? original.attributes.filter(isObject) : [];
      if (!value.length && !(original && "attributes" in original)) continue;
      out.attributes = value
        .filter(isObject)
        .map((a, i) => fromAttribute(a, before[i]?.field === a.name ? before[i] : undefined));
      continue;
    }
    if (!(original && key in original) && deepEqual(value, defaults[key])) continue;
    out[key] = value;
  }
  return out;
}

/** A style's `popup` from today's configuration, the inverse of toPopupConfig: `field_list`, attributes by `field`, one
 * `format`; blocks keep the ids they had in `original`, a block added in the editor keeps its UUID; what the
 * configuration only filled in as a default stays out. A disabled popup is `false`. */
export function fromPopupConfig(config: PopupProperties, original: unknown): JsonObject | false {
  if (!config.enabled) return false;
  const source: JsonObject = isObject(original) ? original : {};
  const absent = (toPopupConfig({}) ?? {}) as unknown as JsonObject;
  const originals = Array.isArray(source.blocks) ? source.blocks.filter(isObject) : [];
  const byKey = new Map(originals.map((b, i) => [blockKey(b, i), b]));
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(config as unknown as JsonObject)) {
    if (value === undefined) continue;
    if (!(key in source) && deepEqual(value, absent[key])) continue;
    out[key] =
      key === "blocks" && Array.isArray(value)
        ? value.filter(isObject).map((b) => fromBlock(b, byKey.get(String(b.id))))
        : value;
  }
  return out;
}
