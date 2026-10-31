import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import { type ItemActionContext, cardBehaviour, inProject } from "@/lib/assistant/itemActions";
import {
  MAX_CARDS,
  type ResultItem,
  SHOW_TOOLS,
  ownThumbnail,
  shownGroups,
  uniqueGroups,
} from "@/lib/assistant/items";

const part = (toolName: string, output: unknown): DynamicToolUIPart => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: "c1",
  state: "output-available",
  input: {},
  output,
});

const ids = (item: ResultItem) => `${item.kind}:${item.id}`;
const NONE = () => null;
const NOWHERE: ItemActionContext = {
  projectId: null,
  canAddToProject: false,
  canZoom: false,
  layerOfDataset: NONE,
};
/** The open project's Map page: its map can zoom. */
const IN_P1: ItemActionContext = {
  projectId: "p1",
  canAddToProject: true,
  canZoom: true,
  layerOfDataset: NONE,
};

describe("result items", () => {
  it("reads the user's own items, dropping kinds and rows it does not know", () => {
    const groups = shownGroups(
      part("core_show_items", {
        groups: [
          {
            title: "Projekte",
            items: [
              { kind: "project", id: "p1", name: "Radverkehr", note: "Radnetz" },
              { kind: "layer", id: "11", project_id: "p1", project_name: "Radverkehr", name: "Radwege" },
              // A layer needs its project; an unknown kind is skipped.
              { kind: "layer", id: "12", name: "Ohne Projekt" },
              { kind: "workflow", id: "w1", name: "Später" },
              "kaputt",
            ],
          },
        ],
        not_found: [],
      })
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Projekte");
    expect(groups[0].items.map(ids)).toEqual(["project:p1", "layer:11"]);
    expect(groups[0].items[1]).toMatchObject({
      projectId: "p1",
      projectName: "Radverkehr",
      title: "Radwege",
    });
  });

  it("reads catalog records, grouped or stored flat before the groups", () => {
    const grouped = shownGroups(
      part("catalog_show_records", {
        groups: [{ records: [{ id: "ds-1", title: "Netz", type: "feature", publisher: "Berlin" }] }],
      })
    );
    expect(grouped[0].items[0]).toMatchObject({
      kind: "catalog",
      title: "Netz",
      detail: "feature",
      publisher: "Berlin",
    });
    const flat = shownGroups(part("catalog_show_records", { shown: [{ id: "x" }] }));
    expect(flat[0].items[0]).toMatchObject({ kind: "catalog", id: "x", title: "x" });
    expect(shownGroups(part("catalog_search", { results: [{ id: "x" }] }))).toEqual([]);
  });

  it("shows each item once, with a layer's id unique only within its project", () => {
    const layer = (id: string, projectId: string): ResultItem => ({
      kind: "layer",
      id,
      projectId,
      title: id,
    });
    const groups = uniqueGroups([
      { items: [layer("11", "p1"), layer("11", "p2")] },
      { items: [layer("11", "p1"), { kind: "project", id: "11", title: "P" }] },
    ]);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
  });

  it("leaves out what an earlier list of the answer showed, and caps each list on its own", () => {
    const projects = (prefix: string): ResultItem[] =>
      Array.from({ length: MAX_CARDS }, (_, n) => ({ kind: "project", id: `${prefix}${n}`, title: "P" }));
    const seen = new Set<string>();
    expect(uniqueGroups([{ items: projects("a") }], seen)[0].items).toHaveLength(MAX_CARDS);
    // a0 is shown already; the second list still shows as many cards of its own.
    const second = uniqueGroups([{ items: [projects("a")[0], ...projects("b")] }], seen);
    expect(second[0].items.map((item) => item.id)).toEqual(projects("b").map((item) => item.id));
  });
});

describe("card behaviour", () => {
  const project: ResultItem = { kind: "project", id: "p2", title: "P" };
  const dataset: ResultItem = { kind: "dataset", id: "d1", datasetId: "d1", title: "D" };
  const layer: ResultItem = { kind: "layer", id: "11", projectId: "p1", datasetId: "d9", title: "L" };
  const elsewhere: ResultItem = { kind: "layer", id: "40", projectId: "p2", datasetId: "d4", title: "E" };
  const locked: ResultItem = { ...elsewhere, datasetId: null, locked: true };
  const catalog: ResultItem = { kind: "catalog", id: "ds-1", title: "C" };
  const bundle: ResultItem = { kind: "bundle", id: "b1", title: "B" };
  const of = (item: ResultItem, context: ItemActionContext) => {
    const { action, preview, layer: target } = cardBehaviour(item, context);
    return { action: action?.id ?? null, preview, layer: target };
  };

  it("opens a project, but not the one the page shows, and has no preview", () => {
    expect(of(project, NOWHERE)).toEqual({ action: "open_project", preview: false, layer: undefined });
    expect(of({ ...project, id: "p1" }, IN_P1)).toEqual({ action: null, preview: false, layer: undefined });
  });

  it("zooms to anything already in the open project, without a preview", () => {
    expect(of(layer, IN_P1)).toEqual({ action: "zoom_to_layer", preview: false, layer: 11 });
    // A dataset the open project shows as layer 77.
    const showing: ItemActionContext = { ...IN_P1, layerOfDataset: (id) => (id === "d1" ? 77 : null) };
    expect(of(dataset, showing)).toEqual({ action: "zoom_to_layer", preview: false, layer: 77 });
  });

  it("offers no Zoom where the page has no map, and still knows the layer is in the project", () => {
    // Workflows, Layouts and Dashboard show the project without its map.
    const noMap: ItemActionContext = { ...IN_P1, canZoom: false };
    expect(of(layer, noMap)).toEqual({ action: null, preview: false, layer: 11 });
    const showing: ItemActionContext = { ...noMap, layerOfDataset: (id) => (id === "d1" ? 77 : null) };
    expect(of(dataset, showing)).toEqual({ action: null, preview: false, layer: 77 });
    expect(inProject(5, noMap)).toEqual({ action: null, preview: false, layer: 5 });
    expect(inProject(5, IN_P1)).toEqual(expect.objectContaining({ preview: false, layer: 5 }));
    expect(inProject(5, IN_P1).action?.id).toBe("zoom_to_layer");
    // Anything else is offered as on the map.
    expect(of(catalog, noMap)).toEqual({ action: "add_to_project", preview: true, layer: undefined });
  });

  it("adds other data to an editable open project, with a preview", () => {
    for (const item of [dataset, elsewhere, catalog, bundle]) {
      expect(of(item, IN_P1)).toEqual({ action: "add_to_project", preview: true, layer: undefined });
    }
  });

  it("opens a workflow or layout in its project's editor, without a preview", () => {
    const workflow: ResultItem = { kind: "workflow", id: "w1", projectId: "p2", title: "W" };
    const layout: ResultItem = { kind: "layout", id: "l1", projectId: "p1", title: "L" };
    expect(of(workflow, IN_P1)).toEqual({ action: "open_workflow", preview: false, layer: undefined });
    expect(of(layout, IN_P1)).toEqual({ action: "open_layout", preview: false, layer: undefined });
  });

  it("reads a workflow or layout only with its project", () => {
    const groups = shownGroups(
      part("core_show_items", {
        groups: [
          {
            items: [
              { kind: "workflow", id: "w1", project_id: "p1", project_name: "Allach", name: "Fahrrad" },
              { kind: "layout", id: "l1", name: "Ohne Projekt" },
            ],
          },
        ],
      })
    );
    expect(groups[0].items).toEqual([
      expect.objectContaining({ kind: "workflow", id: "w1", projectId: "p1", projectName: "Allach" }),
    ]);
  });

  it("asks for the project outside an editable one, and offers nothing for a locked layer", () => {
    for (const item of [dataset, elsewhere, catalog, bundle]) {
      expect(of(item, NOWHERE)).toEqual({ action: "add_to_other_project", preview: true, layer: undefined });
    }
    expect(of(dataset, { ...IN_P1, canAddToProject: false }).action).toBe("add_to_other_project");
    expect(of(locked, IN_P1)).toEqual({ action: null, preview: false, layer: undefined });
  });
});

describe("created workflows", () => {
  const output = {
    workflow: { id: "w-new", name: "Schools: 15-minute walk", project_id: "p1" },
    open_issues: [{ step: "Schools", code: "layer_not_chosen", message: "Schools: no layer chosen." }],
    groups: [
      {
        title: null,
        items: [{ kind: "workflow", id: "w-new", project_id: "p1", name: "Schools: 15-minute walk", detail: null }],
      },
    ],
  };

  it("become a workflow card, read like the items core_show_items names", () => {
    for (const tool of ["workflow_create", "workflow_create_from_template"]) {
      expect(SHOW_TOOLS).toContain(tool);
      expect(shownGroups(part(tool, output))).toEqual([
        {
          title: null,
          items: [
            expect.objectContaining({
              kind: "workflow",
              id: "w-new",
              projectId: "p1",
              title: "Schools: 15-minute walk",
            }),
          ],
        },
      ]);
    }
  });

  it("open in their project's workflow editor", () => {
    const [item] = shownGroups(part("workflow_create", output))[0].items;
    expect(cardBehaviour(item, IN_P1).action?.id).toBe("open_workflow");
  });
});

describe("card thumbnails", () => {
  it("leave out GOAT's default artwork, wherever it is served from, and keep an item's own picture", () => {
    for (const url of [
      "/assets/img/goat_new_dataset_thumbnail.png",
      "https://assets.example/img/goat_new_dataset_thumbnail.png",
      "https://assets.example/img/goat_new_project_artwork.png?v=2",
    ]) {
      expect(ownThumbnail(url), url).toBeUndefined();
    }
    const own = "https://s3.example/thumbnails/layer/abc.png?X-Amz-Signature=1";
    expect(ownThumbnail(own)).toBe(own);
    expect(ownThumbnail(null)).toBeUndefined();
    expect(ownThumbnail(undefined)).toBeUndefined();
  });
});
