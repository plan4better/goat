import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { FILTER_OPERATORS } from "@/lib/filter/generated/operators";

/** The filter panel's texts: every one in both languages, a sentence word for every operator, no dashes. */
const KEYS = [
  "title",
  "empty",
  "no_fields",
  "clear",
  "condition",
  "match_all",
  "match_any",
  "match_all_note",
  "match_any_note",
  "result_all_one",
  "result_all_other",
  "result_of_one",
  "result_of_other",
  "custom",
  "custom_note",
  "unfinished",
  "wildcard",
  "limit_conditions",
  "issue_unknown_field",
  "issue_field_type_mismatch",
  "issue_too_many_conditions",
  "issue_too_many_values",
  "save_refused",
  "switch",
  "range",
  "days_one",
  "days_other",
  "more",
  "search_values",
  "use_value",
  "picked",
  "no_values",
  "area",
  "area_whole",
  "area_view",
  "area_shape",
  "area_shape_polygon",
  "area_shape_circle",
  "area_shapes_one",
  "area_shapes_other",
  "area_regions_one",
  "area_regions_other",
  "area_features_one",
  "area_features_other",
  "area_outside_of",
  "area_remove",
  "area_switch",
  "area_use_view",
  "area_drawing",
  "area_over_limit",
  "area_simplify_question",
  "area_add_simplified",
  "area_keep",
  "area_inside",
  "area_outside",
  "area_empty",
  "area_add",
  "area_add_view",
  "area_add_polygon",
  "area_add_circle",
  "area_add_regions",
  "area_add_features",
  "area_limit_shapes",
  "area_limit_features",
  "area_draw_busy",
  "area_no_layers",
  "area_remove_piece",
  "area_search_regions",
  "area_search_features",
  "area_no_regions",
  "area_no_features",
  "area_more",
  "issue_too_many_shapes",
  "issue_too_long",
  "issue_area_too_detailed",
];
const OPS = [...new Set(Object.values(FILTER_OPERATORS).flat())];

describe("filter panel texts", () => {
  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s has every text, without dashes inside it", (_language, messages) => {
    const texts = (
      messages as unknown as { filter_panel: Record<string, string> & { op: Record<string, string> } }
    ).filter_panel;
    for (const key of KEYS) {
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(/[–—]/);
    }
    for (const op of OPS) expect(texts.op[op], op).toBeTruthy();
    const labels = (messages as unknown as { filter_expressions: Record<string, string> }).filter_expressions;
    for (const op of OPS) expect(labels[op], op).toBeTruthy();
  });
});
