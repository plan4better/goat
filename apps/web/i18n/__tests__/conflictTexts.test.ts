import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

/** The banner an editor shows when core refused a save because the document
 * changed elsewhere: one text per document (German articles differ), with
 * and without who changed it, and its two buttons. */
const KEYS = [
  "workflow_changed_elsewhere",
  "workflow_changed_elsewhere_at",
  "workflow_changed_elsewhere_by",
  "report_layout_changed_elsewhere",
  "report_layout_changed_elsewhere_at",
  "report_layout_changed_elsewhere_by",
  "dashboard_changed_elsewhere",
  "dashboard_changed_elsewhere_at",
  "dashboard_changed_elsewhere_by",
  "changed_elsewhere_reload",
  "changed_elsewhere_keep_mine",
  // The workflow editor's conflict with an assistant edit it was about to load.
  "workflow_changed_by_assistant",
];

describe("conflict banner texts", () => {
  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s has every text, without dashes inside it", (_language, messages) => {
    const texts = messages as unknown as Record<string, string>;
    for (const key of KEYS) {
      expect(texts[key], key).toBeTruthy();
      expect(texts[key], key).not.toMatch(/[–—]/);
    }
  });

  it.each([
    ["en", en],
    ["de", de],
  ] as const)("%s names who and when only where the text says so", (_language, messages) => {
    const texts = messages as unknown as Record<string, string>;
    for (const document of ["workflow", "report_layout", "dashboard"]) {
      expect(texts[`${document}_changed_elsewhere`]).not.toMatch(/\{\{/);
      expect(texts[`${document}_changed_elsewhere_at`]).toMatch(/\{\{time\}\}/);
      expect(texts[`${document}_changed_elsewhere_at`]).not.toMatch(/\{\{name\}\}/);
      expect(texts[`${document}_changed_elsewhere_by`]).toMatch(/\{\{name\}\}.*\{\{time\}\}/);
    }
  });
});
