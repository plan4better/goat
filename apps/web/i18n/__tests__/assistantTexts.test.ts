import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { STEP_KIND_NAMES } from "@/lib/assistant/stepLabels";
import { RUN_ERROR_CODES } from "@/lib/assistant/types";

const EN = en as unknown as Record<string, string>;
const DE = de as unknown as Record<string, string>;
const assistantKeys = (texts: Record<string, string>) =>
  Object.keys(texts)
    .filter((k) => k.startsWith("assistant_"))
    .sort();

const TOOLS = [
  "core_find",
  "core_page_context",
  "core_whoami",
  "catalog_describe",
  "catalog_get_record",
  "catalog_propose_filters",
  "catalog_search",
  "catalog_suggest_terms",
  "map_propose_view",
  "project_area_statistics",
  "project_count_features",
  "project_field_statistics",
  "project_get_fields",
  "project_get_layers",
  "project_sample_features",
  "ask_user",
  "skills_load",
  "workflow_tools",
  "workflow_describe_tool",
  "workflow_find_templates",
  "workflow_check_draft",
  "workflow_create",
  "workflow_create_from_template",
  "workflow_get",
  "workflow_update",
  "project_add_catalog_layer",
  "project_add_dataset",
];
const ROWS = [
  "q",
  "themes",
  "license",
  "language",
  "publisher",
  "type",
  "geometry_type",
  "geographical_code",
  "year",
  "from",
  "to",
  "nuts",
  "sortby",
  "number_matched",
  "project",
  "center",
  "zoom",
  "bbox",
  "layer",
  "filter",
];
const GROUPS = ["catalog", "project", "none"];

/** Every literal `assistant_…` key in the dock's source files. */
function usedKeys(): string[] {
  const roots = ["components/assistant", "lib/assistant", "hooks/assistant"].map((dir) =>
    path.join(__dirname, "../..", dir)
  );
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__") walk(full);
      } else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  roots.forEach((root) => {
    try {
      walk(root);
    } catch (error) {
      // a root created by a later task may not exist yet
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  const keys = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'](assistant_[a-z0-9_]+)["']/g))
      keys.add(match[1]);
  }
  return [...keys].sort();
}

describe("assistant texts", () => {
  it("exist in English and German with the same keys and placeholders", () => {
    expect(assistantKeys(DE)).toEqual(assistantKeys(EN));
    for (const key of assistantKeys(EN)) {
      const placeholders = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
      expect(placeholders(DE[key]), key).toEqual(placeholders(EN[key]));
    }
  });

  it("call a conversation an Unterhaltung in German, as everywhere in the dock", () => {
    for (const key of assistantKeys(DE)) expect(DE[key], key).not.toMatch(/Gespräch/);
  });

  it("speak of an ask card's questions as a whole, since a card holds one to four", () => {
    // The card's own name is plural too ("Questions from the assistant").
    const toasts = [
      "assistant_ask_already_answered",
      "assistant_ask_cannot_answer",
      "assistant_ask_passed_over",
    ];
    for (const key of toasts) {
      expect(EN[key], key).toMatch(/\bthese questions\b/i);
      expect(EN[key], key).not.toMatch(/\bthis question\b/i);
      expect(DE[key], key).toMatch(/\bdiese Fragen\b/i);
      expect(DE[key], key).not.toMatch(/\bdiese Frage\b/i);
    }
  });

  it("never say the assistant leaves what exists alone, now that it changes workflows", () => {
    expect(EN.assistant_empty_sub_project).not.toMatch(/never changes/);
    expect(DE.assistant_empty_sub_project).not.toMatch(/ändert er nie/);
    expect(EN.assistant_empty_sub_project).toMatch(/Undo/);
    expect(DE.assistant_empty_sub_project).toMatch(/Rückgängig/);
  });

  it("use no dashes inside sentences", () => {
    for (const key of assistantKeys(EN)) {
      expect(EN[key], key).not.toMatch(/[—–]/);
      expect(DE[key], key).not.toMatch(/[—–]/);
    }
  });

  it("cover every key the dock uses, and the dynamic families", () => {
    expect(usedKeys().length).toBeGreaterThan(0);
    // A key read with a count (`t(key, { count })`) exists as its plural forms only.
    const missing = usedKeys().filter((key) => !(key in EN) && !(`${key}_one` in EN && `${key}_other` in EN));
    expect(missing).toEqual([]);
    for (const tool of TOOLS) expect(EN, tool).toHaveProperty(`assistant_tool_${tool}`);
    for (const code of RUN_ERROR_CODES) expect(EN, code).toHaveProperty(`assistant_run_error_${code}`);
    for (const row of ROWS) expect(EN, row).toHaveProperty(`assistant_proposal_row_${row}`);
    for (const group of GROUPS) {
      expect(EN).toHaveProperty(`assistant_empty_heading_${group}`);
      expect(EN).toHaveProperty(`assistant_empty_sub_${group}`);
      for (const n of [1, 2, 3]) expect(EN).toHaveProperty(`assistant_suggestion_${group}_${n}`);
    }
  });

  it("give every step label a running form, and every summary kind its plural forms", () => {
    const labels = Object.keys(EN).filter(
      (key) => key.startsWith("assistant_tool_") && !key.endsWith("_running")
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((key) => !(`${key}_running` in EN))).toEqual([]);
    // A running form says the step is still under way.
    for (const key of labels) expect(EN[`${key}_running`], key).toMatch(/…$/);
    for (const kind of STEP_KIND_NAMES) {
      for (const form of ["one", "other"]) expect(EN).toHaveProperty(`assistant_steps_${kind}_${form}`);
    }
  });
});
