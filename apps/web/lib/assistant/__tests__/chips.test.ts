import { describe, expect, it, vi } from "vitest";

import { contextChips, plainTranslate, stripContext, withSources } from "@/lib/assistant/chips";
import type { PageContext, SourceRef } from "@/lib/assistant/types";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;
const source: SourceRef = { kind: "project", id: "p9", name: "Berlin" };

describe("context chips", () => {
  it("describes a catalog page and strips what the user removed", () => {
    const context: PageContext = {
      surface: "catalog",
      q: "rad",
      facets: { themes: ["a", "b"] },
      from: "2020-01-01",
      nuts: ["DED"],
      selected_record_id: "r1",
    };
    const chips = contextChips(context, undefined, t);
    expect(chips.map((chip) => [chip.key, chip.removable])).toEqual([
      ["surface", false],
      ["q", true],
      ["filters", true],
      ["selected_record_id", true],
    ]);
    expect(chips[2].label).toBe('assistant_chip_filters:{"count":4}');
    expect(stripContext(context, new Set(["filters", "q"]))).toEqual({
      surface: "catalog",
      selected_record_id: "r1",
    });
  });

  it("names the project and the mode on project pages", () => {
    const context: PageContext = {
      surface: "project.map",
      project_id: "p1",
      selected_layer_project_id: 4,
      viewport: { center: [13, 52], zoom: 10 },
    };
    const chips = contextChips(context, "Radnetz", t);
    expect(chips[0]).toEqual({
      key: "surface",
      kind: "target",
      removable: false,
      label: 'assistant_chip_project:{"name":"Radnetz","mode":"map"}',
    });
    expect(chips.slice(1).map((chip) => chip.key)).toEqual(["selected_layer_project_id", "viewport"]);
    expect(stripContext(context, new Set(["viewport"]))).toEqual({
      surface: "project.map",
      project_id: "p1",
      selected_layer_project_id: 4,
    });
  });

  it("adds sources as removable chips and sends nothing for a plain page", () => {
    expect(withSources(null, [])).toBeNull();
    const home = withSources(null, [source]);
    expect(home).toEqual({ surface: "none", sources: [source] });
    expect(contextChips(home, undefined, t)).toEqual([
      { key: "source:p9", kind: "source", removable: true, label: 'assistant_chip_source:{"name":"Berlin"}' },
    ]);
    expect(stripContext(home, new Set(["source:p9"]))).toBeNull();
    expect(stripContext(null, new Set())).toBeNull();
  });
});

describe("plainTranslate", () => {
  it("passes the options through and turns i18next escaping off", () => {
    const i18n = vi.fn((key: string) => key);
    const translate = plainTranslate(i18n);
    expect(translate("assistant_toast_answer_ready", { title: "A & B" })).toBe(
      "assistant_toast_answer_ready"
    );
    expect(i18n).toHaveBeenCalledWith("assistant_toast_answer_ready", {
      title: "A & B",
      interpolation: { escapeValue: false },
    });
    translate("assistant_untitled");
    expect(i18n).toHaveBeenLastCalledWith("assistant_untitled", { interpolation: { escapeValue: false } });
  });
});
