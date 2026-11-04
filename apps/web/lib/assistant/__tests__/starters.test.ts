import { describe, expect, it } from "vitest";

import {
  MAX_STARTERS,
  MAX_STARTER_LAYER_NAME,
  STARTER_KEYS,
  pickStarters,
  showStarters,
  starterContext,
} from "@/lib/assistant/starters";
import type { StarterContext } from "@/lib/assistant/starters";
import type { AssistantSurfaceId } from "@/lib/assistant/types";

import { enTranslate } from "./enTranslate";

/** A seeded generator (mulberry32): the same seed gives the same sequence, nearby seeds unrelated ones. */
const seeded = (seed: number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
};

const SURFACES: AssistantSurfaceId[] = [
  "project.map",
  "project.workflows",
  "project.layouts",
  "project.dashboard",
  "catalog",
  "none",
];

/**
 * The starters that need something from the page, by what they need. An empty
 * project has no layers to ask about; a viewer may not create a workflow.
 */
const NEEDS_EDIT = ["walk", "workflow"];
const NEEDS_LAYER_NAME = ["layers", "layer_fields"];
const NEEDS_SELECTED_LAYER = ["selected_layer"];
const NEEDS_VIEWPORT = ["view_data"];
const NEEDS_WORKFLOW = ["open_workflow", "check_workflow"];
const NEEDS_RECORD = ["selected_record"];
const NEEDS_ANYTHING = [
  ...NEEDS_EDIT,
  ...NEEDS_LAYER_NAME,
  ...NEEDS_SELECTED_LAYER,
  ...NEEDS_VIEWPORT,
  ...NEEDS_WORKFLOW,
  ...NEEDS_RECORD,
];

const keys = (starters: { key: string }[]) => starters.map((starter) => starter.key);

/** Drawn and shown with the same context, in English. */
const shown = (surface: AssistantSurfaceId, ctx: StarterContext, seed: number) =>
  showStarters(pickStarters(surface, ctx, seeded(seed)), ctx, enTranslate);

describe("pickStarters", () => {
  it("never offers a starter whose page context is missing", () => {
    for (const surface of SURFACES) {
      for (let seed = 0; seed < 50; seed += 1) {
        const picked = keys(pickStarters(surface, {}, seeded(seed)));
        expect(
          picked.filter((key) => NEEDS_ANYTHING.includes(key)),
          `${surface} ${seed}`
        ).toEqual([]);
        // An empty project, no selection, no open workflow, no edit rights: still something to start with.
        expect(picked.length, surface).toBeGreaterThan(0);
      }
    }
  });

  it("offers the starters of what the page has", () => {
    const everything = {
      selectedLayer: true,
      viewport: true,
      workflow: true,
      selectedRecord: true,
      layerNames: ["Supermärkte"],
      canEdit: true,
    };
    const seen = (surface: AssistantSurfaceId) => {
      const all = new Set<string>();
      for (let seed = 0; seed < 200; seed += 1)
        keys(pickStarters(surface, everything, seeded(seed))).forEach((key) => all.add(key));
      return all;
    };
    expect([...seen("project.map")]).toEqual(
      expect.arrayContaining([...NEEDS_EDIT, ...NEEDS_LAYER_NAME, ...NEEDS_SELECTED_LAYER, ...NEEDS_VIEWPORT])
    );
    expect([...seen("project.workflows")]).toEqual(
      expect.arrayContaining([...NEEDS_EDIT, ...NEEDS_WORKFLOW])
    );
    expect([...seen("catalog")]).toEqual(expect.arrayContaining(NEEDS_RECORD));
    // A mode offers only its own: no map view in Workflows, no workflow in Map.
    expect(seen("project.workflows").has("view_data")).toBe(false);
    expect(seen("project.map").has("open_workflow")).toBe(false);
  });

  it("offers a viewer of the project nothing that creates a workflow, and asks about it all the same", () => {
    const viewer = { selectedLayer: true, viewport: true, workflow: true, layerNames: ["Supermärkte"] };
    for (const surface of ["project.map", "project.workflows"] as const) {
      const all = new Set<string>();
      for (let seed = 0; seed < 200; seed += 1)
        keys(pickStarters(surface, viewer, seeded(seed))).forEach((key) => all.add(key));
      expect(
        [...all].filter((key) => NEEDS_EDIT.includes(key)),
        surface
      ).toEqual([]);
      // Checking the open workflow changes nothing: a viewer may ask it.
      if (surface === "project.workflows") expect(all.has("check_workflow")).toBe(true);
    }
    // The right taken away after the draw: the drawn workflow starters go with it.
    const picks = [{ key: "walk" }, { key: "workflow" }, { key: "help_project" }];
    expect(keys(showStarters(picks, { canEdit: true }, enTranslate))).toEqual([
      "walk",
      "workflow",
      "help_project",
    ]);
    expect(keys(showStarters(picks, {}, enTranslate))).toEqual(["help_project"]);
  });

  it("returns at most four, each once", () => {
    const everything = { selectedLayer: true, viewport: true, layerNames: ["A", "B"] };
    for (let seed = 0; seed < 50; seed += 1) {
      const picked = keys(pickStarters("project.map", everything, seeded(seed)));
      expect(MAX_STARTERS).toBe(4);
      expect(picked).toHaveLength(4);
      expect(new Set(picked).size).toBe(4);
    }
  });

  it("picks the same starters for the same random sequence, and others for another", () => {
    const ctx = { selectedLayer: true, viewport: true, layerNames: ["A", "B", "C"] };
    const first = pickStarters("project.map", ctx, seeded(7));
    expect(pickStarters("project.map", ctx, seeded(7))).toEqual(first);
    const others = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1)
      others.add(keys(pickStarters("project.map", ctx, seeded(seed))).join());
    expect(others.size).toBeGreaterThan(1);
  });

  it("names a layer of the project in the fields starter, unescaped", () => {
    const names = ["Bus & Bahn", "Supermärkte"];
    const texts = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const fields = shown("project.layouts", { layerNames: names }, seed).find(
        (starter) => starter.key === "layer_fields"
      );
      if (fields) texts.add(fields.text);
    }
    expect([...texts].sort()).toEqual([
      "Which fields does “Bus & Bahn” have?",
      "Which fields does “Supermärkte” have?",
    ]);
  });

  it("marks the sentence starts as drafts", () => {
    const all = new Map<string, boolean>();
    for (let seed = 0; seed < 200; seed += 1)
      for (const starter of shown("project.map", { layerNames: ["A"], canEdit: true }, seed))
        all.set(starter.key, starter.draft);
    expect(all.get("walk")).toBe(true);
    expect(all.get("workflow")).toBe(true);
    expect(all.get("datasets")).toBe(true);
    expect(all.get("layers")).toBe(false);
    expect(all.get("help_project")).toBe(false);
    // An empty project: the three sentence starts and the help question, nothing else to offer.
    const empty = shown("project.map", { canEdit: true }, 1);
    expect(empty.map((s) => s.key)).toEqual(["walk", "workflow", "datasets", "help_project"]);
    expect(empty[0].text).toBe("How many residents can walk in 10 minutes to");
  });

  it("quotes only a layer name short enough for one card line", () => {
    expect(MAX_STARTER_LAYER_NAME).toBe(40);
    const long = "L".repeat(MAX_STARTER_LAYER_NAME + 1);
    const fits = "F".repeat(MAX_STARTER_LAYER_NAME);
    const offered = (layerNames: string[]) => {
      const all = new Set<string>();
      for (let seed = 0; seed < 200; seed += 1)
        shown("project.layouts", { layerNames }, seed).forEach((starter) => all.add(starter.text));
      return all;
    };
    // Only a long name: the project has layers to list, none to quote.
    const onlyLong = offered([long]);
    expect(onlyLong.has("Which layers does this project contain?")).toBe(true);
    expect([...onlyLong].filter((text) => text.startsWith("Which fields"))).toEqual([]);
    expect([...offered([long, fits])].filter((text) => text.startsWith("Which fields"))).toEqual([
      `Which fields does “${fits}” have?`,
    ]);
  });

  it("knows every key it can offer", () => {
    expect(STARTER_KEYS).toEqual(
      expect.arrayContaining(["layers", "walk", "help", "cycling_projects", ...NEEDS_ANYTHING])
    );
  });
});

describe("showStarters", () => {
  const everything: StarterContext = {
    selectedLayer: true,
    viewport: true,
    workflow: true,
    selectedRecord: true,
    layerNames: ["Radwege", "Supermärkte"],
    canEdit: true,
  };

  it("drops a drawn starter once the page no longer has what it refers to", () => {
    const picks = [
      { key: "selected_layer" },
      { key: "view_data" },
      { key: "layer_fields", name: "Radwege" },
      { key: "walk" },
    ];
    expect(keys(showStarters(picks, everything, enTranslate))).toEqual([
      "selected_layer",
      "view_data",
      "layer_fields",
      "walk",
    ]);
    // The layer deselected and the map view chip removed: the rest stays as drawn.
    const after = showStarters(picks, { ...everything, selectedLayer: false, viewport: false }, enTranslate);
    expect(keys(after)).toEqual(["layer_fields", "walk"]);
    // The named layer left the project (or was renamed).
    expect(keys(showStarters(picks, { ...everything, layerNames: ["Supermärkte"] }, enTranslate))).toEqual([
      "selected_layer",
      "view_data",
      "walk",
    ]);
    expect(
      keys(showStarters([{ key: "open_workflow" }], { ...everything, workflow: false }, enTranslate))
    ).toEqual([]);
    expect(
      keys(showStarters([{ key: "selected_record" }], { ...everything, selectedRecord: false }, enTranslate))
    ).toEqual([]);
  });

  it("translates as it shows, so the texts follow the language", () => {
    const picks = [{ key: "layer_fields", name: "Bus & Bahn" }, { key: "help_project" }];
    const ctx = { layerNames: ["Bus & Bahn"] };
    const german: typeof enTranslate = (key, options) =>
      key === "assistant_starter_layer_fields"
        ? `Welche Felder hat „${(options as { name: string }).name}“?`
        : `de:${key}`;
    expect(showStarters(picks, ctx, enTranslate).map((starter) => starter.text)).toEqual([
      "Which fields does “Bus & Bahn” have?",
      "What can the assistant do in this project?",
    ]);
    expect(showStarters(picks, ctx, german).map((starter) => starter.text)).toEqual([
      "Welche Felder hat „Bus & Bahn“?",
      "de:assistant_starter_help_project",
    ]);
  });
});

describe("starterContext", () => {
  it("reads what the message carries, and whether the user may edit the project", () => {
    expect(
      starterContext(
        {
          surface: "project.map",
          project_id: "p1",
          selected_layer_project_id: 3,
          viewport: { center: [9, 53], zoom: 11 },
        },
        ["Supermärkte"],
        true
      )
    ).toEqual({
      selectedLayer: true,
      viewport: true,
      workflow: false,
      selectedRecord: false,
      layerNames: ["Supermärkte"],
      canEdit: true,
    });
    expect(starterContext({ surface: "project.workflows", project_id: "p1", workflow_id: "w1" })).toEqual({
      selectedLayer: false,
      viewport: false,
      workflow: true,
      selectedRecord: false,
      layerNames: [],
      canEdit: false,
    });
    expect(starterContext({ surface: "catalog", selected_record_id: "r1" }).selectedRecord).toBe(true);
    expect(starterContext(null)).toEqual({
      selectedLayer: false,
      viewport: false,
      workflow: false,
      selectedRecord: false,
      layerNames: [],
      canEdit: false,
    });
  });
});
