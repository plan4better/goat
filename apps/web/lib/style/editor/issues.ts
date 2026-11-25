// The issues a save returns (spec 11) in the panel: which section and row a JSON pointer names (list items by id or
// index), the fix operations as edits, and the issue in the panel's language.
import type { TFunction } from "i18next";

import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { parsePointer } from "@/lib/style/pointer";
import type { StyleIssue } from "@/lib/style/save";

export type Section = "general" | "symbol" | "rules" | "layer" | "legend" | "popup";

const SECTIONS: Record<string, Section> = {
  symbol: "symbol",
  classify: "symbol",
  rules: "rules",
  legend: "legend",
  popup: "popup",
  render: "general",
};

/** The dot path a pointer names in `doc`: list items by index or by their id; null when an item is gone. */
export function pointerPath(doc: LayerStyle, pointer: string): Path | null {
  const out: string[] = [];
  let current: unknown = doc;
  for (const segment of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment)
        ? Number(segment)
        : current.findIndex((item) => isObject(item) && item.id === segment);
      if (index < 0 || index >= current.length) return null;
      out.push(String(index));
      current = current[index];
    } else {
      out.push(segment);
      current = isObject(current) ? current[segment] : undefined;
    }
  }
  return out.join(".");
}

export function issueTarget(doc: LayerStyle, pointer: string): { section: Section; path: Path } | null {
  const path = pointerPath(doc, pointer);
  if (path === null) return null;
  return { section: SECTIONS[path.split(".")[0]] ?? "layer", path };
}

const MAIN_COLORS = ["fill.color", "line.color", "marker.color"];

/** goatlib's `_retarget`: the classification sets `target`, and its class records move the old key's values there. */
function retargeted(classification: JsonObject, target: string): JsonObject {
  const out = structuredClone(classification);
  const records: JsonObject[] = [
    ...(Array.isArray(out.classes) ? out.classes.filter(isObject) : []),
    ...(["other", "no_data"] as const).map((k) => out[k]).filter(isObject),
  ];
  const sets = (key: string) => {
    const [part, sub] = key.split(".");
    return records.some((r) => isObject(r[part]) && sub in r[part]);
  };
  const old = (typeof out.target === "string" && out.target) || MAIN_COLORS.find(sets);
  out.target = target;
  if (!old || old === target) return out;
  const [oldPart, oldKey] = [old.slice(0, old.indexOf(".")), old.slice(old.indexOf(".") + 1)];
  const [newPart, newKey] = [target.slice(0, target.indexOf(".")), target.slice(target.indexOf(".") + 1)];
  for (const record of records) {
    const part = record[oldPart];
    if (!isObject(part) || !(oldKey in part)) continue;
    const value = part[oldKey];
    delete part[oldKey];
    if (!Object.keys(part).length) delete record[oldPart];
    record[newPart] = { ...(isObject(record[newPart]) ? record[newPart] : {}), [newKey]: value };
  }
  return out;
}

/** The document with one of the spec's fix operations applied (set, remove, retarget, use_field, round), as goatlib's
 * `apply_fix` applies it: the path names the value to change (for retarget, the classification). */
export function applyFix(doc: LayerStyle, fix: NonNullable<StyleIssue["fix"]>): LayerStyle {
  const path = pointerPath(doc, fix.path);
  if (path === null) return doc;
  switch (fix.op) {
    case "set":
      return setIn(doc, path, fix.value);
    case "remove":
      return setIn(doc, path, undefined);
    case "retarget": {
      const classification = getIn(doc, path);
      return isObject(classification) && fix.target?.includes(".")
        ? setIn(doc, path, retargeted(classification, fix.target))
        : doc;
    }
    case "use_field":
      return fix.field ? setIn(doc, path, fix.field) : doc;
    case "round": {
      const value = getIn(doc, path);
      return typeof value === "number" ? setIn(doc, path, Math.round(value)) : doc;
    }
    default:
      return doc;
  }
}

/** The issue codes the panel words itself: `style_editor.issue_<code>`, with `_<case>` where the issue's
 * `params.case` names one. `needs` are the params the text reads, `count` the one its plural follows. Any other code
 * or case keeps the server's English message. */
export const WORDED_ISSUES: Record<string, { needs: readonly string[]; count?: string }> = {
  classes_merged_not_above_zero: { needs: ["asked"] },
  classes_merged_one_value: { needs: ["asked"] },
  classes_merged_repeated_values: { needs: ["asked", "made"], count: "made" },
  classes_merged_joined: { needs: ["asked", "made"], count: "made" },
  no_values: { needs: ["field"] },
  no_values_band: { needs: [] },
  unknown_field: { needs: ["field"] },
  too_many_classes: { needs: ["classes", "limit"] },
  too_many_categories: { needs: ["categories", "limit"] },
  palette_kind_mismatch_ordered: { needs: ["palette"] },
  palette_kind_mismatch_qualitative: { needs: ["palette"] },
  palette_too_short: { needs: ["classes", "colors"] },
  domain_outside_data: { needs: ["min", "max"] },
  too_many_features_for_render: { needs: ["limit", "features"] },
  unknown_category: { needs: ["values", "count"], count: "count" },
  unknown_category_cell: { needs: ["values"] },
  unclassified_values: { needs: ["values"] },
  classes_invalid: { needs: [] },
  low_opacity: { needs: [] },
  nothing_drawn: { needs: [] },
  mixed_icon_kinds: { needs: [] },
  extrude_drops_pattern: { needs: [] },
  base_above_height: { needs: [] },
};

/** A param as a text names it: a list as its items separated by commas. */
const asText = (value: unknown): unknown => (Array.isArray(value) ? value.map(String).join(", ") : value);

/** An issue in the panel's language, built from its params; the server's message for a code or case the panel does
 * not word, or when a value its text needs is missing. */
export function issueText(t: TFunction, issue: StyleIssue): string {
  const params = issue.params ?? {};
  const key = typeof params.case === "string" ? `${issue.code}_${params.case}` : issue.code;
  const worded = Object.prototype.hasOwnProperty.call(WORDED_ISSUES, key) ? WORDED_ISSUES[key] : undefined;
  if (!worded || worded.needs.some((name) => params[name] === undefined || params[name] === null))
    return issue.message;
  const values: Record<string, unknown> = Object.fromEntries(
    worded.needs.map((name) => [name, asText(params[name])])
  );
  if (worded.count) values.count = params[worded.count];
  // React escapes the text it renders, so field and palette names go in as they are.
  return t(`style_editor.issue_${key}`, {
    ...values,
    defaultValue: issue.message,
    interpolation: { escapeValue: false },
  });
}
