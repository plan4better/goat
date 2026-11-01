import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

/** The step nodes' own checks are gone (the workflow check reports issues
 * now), and so are the texts only they used. */
const REMOVED_KEYS = ["missing_layer_connections", "missing_required_config", "fields_not_in_input_layer"];

/** Texts the step badges, settings and notices add to the editor. */
const ADDED_KEYS = ["required_field_marker", "workflow_damaged_saved", "workflow_damaged_drawing"];

describe("workflow editor texts", () => {
  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s has every added text, without dashes inside it", (_language, messages) => {
    const texts = messages as unknown as Record<string, string>;
    for (const key of ADDED_KEYS) {
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(/[–—]/);
    }
  });

  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s no longer carries the step nodes' own check texts", (_language, messages) => {
    for (const key of REMOVED_KEYS) {
      expect(Object.keys(messages), key).not.toContain(key);
    }
  });
});
