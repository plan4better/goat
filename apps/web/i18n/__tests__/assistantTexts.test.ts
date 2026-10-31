import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import { STARTER_KEYS } from "@/lib/assistant/starters";
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
      // With its format, if any: `{{count, number}}` in one language needs it in the other.
      const placeholders = (text: string) =>
        [...text.matchAll(/{{\s*(\w+)\s*(?:,\s*(\w+)\s*)?}}/g)].map((m) => `${m[1]},${m[2] ?? ""}`).sort();
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

  it("keep the start page to one sentence of what it is for, without Undo or the @ hint", () => {
    // The answers carry Undo themselves and the composer's chip teaches the @.
    for (const group of GROUPS) {
      expect(EN[`assistant_empty_sub_${group}`], group).not.toMatch(/Undo|@|never changes/);
      expect(DE[`assistant_empty_sub_${group}`], group).not.toMatch(/Rückgängig|@|ändert er nie/);
    }
  });

  it("name the map view chip briefly, so the composer's chips fit a narrow dock", () => {
    expect(EN.assistant_chip_map_view).toBe("Map view");
    expect(DE.assistant_chip_map_view).toBe("Kartenansicht");
  });

  it("write the German starters as questions or infinitives, never as an order to the assistant", () => {
    for (const key of STARTER_KEYS) expect(DE[`assistant_starter_${key}`], key).not.toMatch(/\bSie\b/);
  });

  it("state the AI notices word for word, as approved", () => {
    const notice = {
      en: "You are writing with an AI assistant. Your messages and the data it reads are sent to the AI model your organization uses.",
      de: "Sie schreiben mit einem KI-Assistenten. Ihre Nachrichten und die Daten, die er liest, werden an das KI-Modell übermittelt, das Ihre Organisation nutzt.",
    };
    expect(EN.assistant_scope_note).toBe("AI answers can be wrong. Check results before you use them.");
    expect(DE.assistant_scope_note).toBe(
      "KI-Antworten können fehlerhaft sein. Prüfen Sie Ergebnisse, bevor Sie sie verwenden."
    );
    expect(EN.assistant_proposal_apply_hint).toBe("The page changes only when you apply this suggestion.");
    expect(DE.assistant_proposal_apply_hint).toBe(
      "Die Seite ändert sich erst, wenn Sie diesen Vorschlag anwenden."
    );
    // Without a privacy policy to link, the notice ends before its last sentence.
    expect(EN.assistant_ai_notice_no_policy).toBe(notice.en);
    expect(DE.assistant_ai_notice_no_policy).toBe(notice.de);
    expect(EN.assistant_ai_notice).toBe(`${notice.en} Details are in the <policy>privacy policy</policy>.`);
    expect(DE.assistant_ai_notice).toBe(
      `${notice.de} Details finden Sie in der <policy>Datenschutzerklärung</policy>.`
    );
    expect(EN.assistant_caveat_fallback).toBe(
      "Your organization's AI provider is unavailable. This answer uses GOAT AI, so this request was processed by GOAT AI's model provider."
    );
    expect(DE.assistant_caveat_fallback).toBe(
      "Der KI-Anbieter Ihrer Organisation ist nicht erreichbar. Diese Antwort verwendet GOAT AI, die Anfrage wurde daher vom Modell-Anbieter von GOAT AI verarbeitet."
    );
    expect(EN.ai_settings_description).toMatch(
      / When AI is on, members' messages and the data the assistant reads are processed by the selected model provider\. Make sure your organization may share this data with it\.$/
    );
    expect(DE.ai_settings_description).toMatch(
      / Ist KI aktiviert, verarbeitet der gewählte Modell-Anbieter die Nachrichten der Mitglieder und die Daten, die der Assistent liest\. Stellen Sie sicher, dass Ihre Organisation diese Daten mit ihm teilen darf\.$/
    );
  });

  it("say Features and Layouts in German, as the cards and the mode toggle do", () => {
    for (const key of assistantKeys(DE)) {
      expect(DE[key], key).not.toMatch(/objekt/i);
      expect(DE[key], key).not.toMatch(/Drucklayout/);
    }
    for (const key of assistantKeys(EN)) expect(EN[key], key).not.toMatch(/print layout/i);
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
    }
    for (const key of STARTER_KEYS) expect(EN, key).toHaveProperty(`assistant_starter_${key}`);
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
