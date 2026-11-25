import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { WORDED_ISSUES, issueText } from "@/lib/style/editor/issues";
import type { StyleIssue } from "@/lib/style/save";

import { issueText as filterIssueText } from "@/components/map/panels/filter/ConditionFields";

const issue = (
  code: string,
  params?: Record<string, unknown>,
  message = "The server's text."
): StyleIssue => ({
  level: "info",
  code,
  path: "/classify/v",
  message,
  ...(params ? { params } : {}),
});

/** Every worded code and case with the params goatlib sends for it (tests/unit/style/test_issue_params.py). */
const SAMPLES: Record<string, Record<string, unknown>> = {
  classes_merged_not_above_zero: { case: "not_above_zero", asked: 6, made: 1 },
  classes_merged_one_value: { case: "one_value", asked: 6, made: 1 },
  classes_merged_repeated_values: { case: "repeated_values", asked: 6, made: 5 },
  classes_merged_joined: { case: "joined", asked: 6, made: 5 },
  no_values: { field: "population" },
  no_values_band: { case: "band" },
  unknown_field: { field: "population" },
  too_many_classes: { classes: 8, limit: 7 },
  too_many_categories: { categories: 13, limit: 12 },
  palette_kind_mismatch_ordered: { case: "ordered", palette: "Viridis" },
  palette_kind_mismatch_qualitative: { case: "qualitative", palette: "Dark2" },
  palette_too_short: { classes: 5, colors: 2 },
  domain_outside_data: { min: 3440, max: 25580 },
  too_many_features_for_render: { limit: 100000, features: 100001 },
  unknown_category: { values: ["Atlantis", "Lemuria"], count: 2 },
  unknown_category_cell: { case: "cell", values: [9], count: 1 },
  unclassified_values: { values: [2, 3, 4] },
  low_opacity: {},
  nothing_drawn: {},
  mixed_icon_kinds: {},
  extrude_drops_pattern: {},
  base_above_height: {},
  classes_invalid: {},
};

describe("the style panel's issue texts", () => {
  it("words every code and case it knows in English and German, with every value filled in", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(WORDED_ISSUES).sort());
    for (const language of ["en", "de"] as const) {
      const t = commonT(language);
      for (const [key, params] of Object.entries(SAMPLES)) {
        const code = typeof params.case === "string" ? key.slice(0, -params.case.length - 1) : key;
        const text = issueText(t, issue(code, params));
        expect(text, `${language} ${key}`).not.toBe("The server's text.");
        expect(text, `${language} ${key}`).not.toMatch(/\{\{|style_editor\.|[\u2013\u2014]/);
        if (language === "de") expect(text, key).not.toMatch(/Ebene/);
      }
    }
  });

  it("says why a quantile made fewer classes, with the numbers, in the panel's language", () => {
    const merged = issue("classes_merged", { case: "repeated_values", asked: 6, made: 5 });
    expect(issueText(commonT("de"), merged)).toBe(
      "Viele Werte sind gleich, daher fallen Klassengrenzen auf denselben Wert: 5 Klassen statt 6. " +
        "Wählen Sie weniger Klassen oder eine andere Methode."
    );
    expect(issueText(commonT("en"), merged)).toBe(
      "Many values are the same, so some class limits fell on the same value: 5 classes instead of 6. " +
        "Choose fewer classes or another method."
    );
    const one = issue("classes_merged", { case: "joined", asked: 3, made: 1 });
    expect(issueText(commonT("de"), one)).toMatch(/: 1 Klasse statt 3\./);
  });

  it("names lists and large numbers as the language writes them", () => {
    const de = commonT("de");
    expect(issueText(de, issue("unknown_category", { values: ["Atlantis", "Lemuria"], count: 2 }))).toBe(
      "Kein Objekt hat diese Werte: Atlantis, Lemuria."
    );
    expect(issueText(de, issue("too_many_features_for_render", { limit: 100000, features: 100001 }))).toMatch(
      /100\.000 Objekte .* 100\.001\./
    );
  });

  it("keeps the server's text for a code or case without a text, or without the values its text needs", () => {
    const t = commonT("de");
    expect(issueText(t, issue("template_syntax"))).toBe("The server's text.");
    expect(issueText(t, issue("classes_merged", { case: "a_new_case", asked: 6, made: 5 }))).toBe(
      "The server's text."
    );
    expect(issueText(t, issue("classes_merged"))).toBe("The server's text.");
    expect(issueText(t, issue("unknown_field", {}))).toBe("The server's text.");
  });

  it("leaves the filter panel's texts as they are", () => {
    expect(filterIssueText(commonT("de"), { code: "unknown_field", field: "name" })).toBe(
      "Der Layer hat kein Feld „name“."
    );
  });
});
