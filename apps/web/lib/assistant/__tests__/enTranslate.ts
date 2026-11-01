import en from "@/i18n/locales/en/common.json";

import type { Translate } from "@/lib/assistant/chips";

const EN = en as unknown as Record<string, string>;
const NUMBER = new Intl.NumberFormat("en");
const ESCAPED: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
};

/**
 * The English texts with i18next's interpolation: `{{name}}` is replaced by the
 * option, HTML-escaped unless the call turns `escapeValue` off, as i18next does;
 * `{{name, number}}` is the number with English thousands separators.
 */
export const enTranslate: Translate = (key, options = {}) => {
  const { interpolation, defaultValue, ...values } = options as Record<string, unknown>;
  const escape = (interpolation as { escapeValue?: boolean } | undefined)?.escapeValue !== false;
  // i18next's plural keys for English: `_one` for exactly one, `_other` otherwise.
  const plural =
    typeof values.count === "number" ? EN[`${key}_${values.count === 1 ? "one" : "other"}`] : undefined;
  const template = plural ?? EN[key] ?? (typeof defaultValue === "string" ? defaultValue : key);
  return template.replace(/{{\s*(\w+)\s*(,\s*number\s*)?}}/g, (_match, name: string, number?: string) => {
    const raw = values[name];
    const value = number && typeof raw === "number" ? NUMBER.format(raw) : String(raw ?? "");
    return escape ? value.replace(/[&<>"'/]/g, (char) => ESCAPED[char]) : value;
  });
};
