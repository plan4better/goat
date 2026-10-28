// Label templates in the panel (spec 3.4): field tokens with escaped braces, the fields a template uses, and the
// preview text: the template filled from one feature with numbers formatted as the map draws them (spec 18.3).
import { type NumberFormatSpec, parseTemplate } from "@/lib/style/compile/labels";
import type { FieldType } from "@/lib/style/compile/types";

const NUMBER_TYPES = new Set<FieldType>(["number", "integer"]);

export const isNumberType = (type: FieldType | undefined): boolean =>
  type !== undefined && NUMBER_TYPES.has(type);

/** `{name}` with `{` and `}` in the name escaped. */
export const fieldToken = (name: string): string => `{${name.replace(/[{}]/g, (brace) => `\\${brace}`)}}`;

/** The fields a template uses, in order. */
export const templateFields = (template: string): string[] =>
  parseTemplate(template).flatMap((part) => ("field" in part ? [part.field] : []));

/** The field when the template is that one field alone (a plain field label), else null. */
export function templateField(template: string): string | null {
  const parts = parseTemplate(template);
  return parts.length === 1 && "field" in parts[0] ? parts[0].field : null;
}

/** A number as the label shows it: the twin of the compiler's formatNumber expression. */
export function formatNumberText(n: number, format: NumberFormatSpec, locale: string): string {
  const decimals = format.decimals ?? "auto";
  let text: string;
  if (format.thousands_separator === false) {
    text = String(typeof decimals === "number" ? Math.round(n * 10 ** decimals) / 10 ** decimals : n);
  } else {
    const value = decimals === 0 ? Math.round(n) : n;
    text = new Intl.NumberFormat(
      locale,
      typeof decimals === "number" ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}
    ).format(value);
  }
  if (format.abbreviate && Math.abs(n) >= 1000) {
    const [divisor, unit] = Math.abs(n) >= 1000000 ? [1000000, "M"] : [1000, "k"];
    const short = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    text = `${short.format(n / divisor)} ${unit}`;
  }
  if (format.always_show_sign && n > 0) text = `+${text}`;
  return `${format.prefix ?? ""}${text}${format.suffix ?? ""}`;
}

/** The template filled from `feature`: number fields formatted, a field the data lacks shown as `{name?}`. */
export function fillTemplate(
  template: string,
  feature: Record<string, unknown> | undefined,
  types: Record<string, FieldType>,
  format: NumberFormatSpec,
  locale: string,
  formats: Record<string, NumberFormatSpec> = {}
): string {
  return parseTemplate(template)
    .map((part) => {
      if ("text" in part) return part.text;
      if (!(part.field in types)) return `{${part.field}?}`;
      const value = feature?.[part.field];
      if (value === undefined || value === null) return "";
      return isNumberType(types[part.field]) && typeof value === "number"
        ? formatNumberText(value, { ...format, ...formats[part.field] }, locale)
        : String(value);
    })
    .join("");
}
