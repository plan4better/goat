import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

import { type Translate, plainTranslate } from "@/lib/assistant/chips";
import {
  ARGUMENT_CHARS,
  clip,
  foldRepeatedWrites,
  groupSummary,
  staysVisible,
  stepLabel,
  stepNames,
  stepResult,
  stepRows,
} from "@/lib/assistant/stepLabels";

import { enTranslate } from "./enTranslate";

/** The German texts through i18next itself, values unescaped as the dock renders them. */
const deTranslate = plainTranslate(commonT("de") as unknown as Parameters<typeof plainTranslate>[0]);

type State = "output-available" | "output-error" | "input-available";

let counter = 0;
const call = (
  toolName: string,
  input: unknown,
  output?: unknown,
  state: State = output === undefined ? "input-available" : "output-available"
): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName,
    toolCallId: `c${(counter += 1)}`,
    state,
    input,
    ...(state === "output-available" ? { output } : {}),
    ...(state === "output-error" ? { errorText: "Internal English detail" } : {}),
  }) as DynamicToolUIPart;
const failed = (toolName: string, input: unknown) => call(toolName, input, undefined, "output-error");

const label = (step: DynamicToolUIPart, steps: DynamicToolUIPart[] = [step]) =>
  stepLabel(step, stepNames(steps), enTranslate);

describe("step labels", () => {
  it("name what core_find searched for, and fall back to the plain label", () => {
    expect(label(call("core_find", { query: "bike" }))).toBe("Searched your content for “bike”");
    expect(label(call("core_find", { query: "bike", kind: "any" }))).toBe("Searched your content for “bike”");
    expect(label(call("core_find", { query: "Anna", kind: "workflow" }))).toBe(
      "Searched workflows for “Anna”"
    );
    expect(label(call("core_find", { query: "A3", kind: "layout" }))).toBe("Searched layouts for “A3”");
    expect(label(call("core_find", { query: "rad", kind: "dataset" }))).toBe("Searched datasets for “rad”");
    expect(label(call("core_find", { query: "rad", kind: "project" }))).toBe("Searched projects for “rad”");
    expect(label(call("core_find", { query: "rad", kind: "nonsense" }))).toBe(
      "Searched your content for “rad”"
    );
    expect(label(call("core_find", {}))).toBe("Searched your content");
    expect(label(call("core_find", { query: "  " }))).toBe("Searched your content");
    expect(label(call("core_find", undefined))).toBe("Searched your content");
  });

  it("name the catalog search words and count the filters that narrow it", () => {
    expect(label(call("catalog_search", { q: "Radverkehr" }))).toBe("Searched the catalog for “Radverkehr”");
    expect(label(call("catalog_search", { q: "Radverkehr", themes: "transportation", year: 2023 }))).toBe(
      "Searched the catalog for “Radverkehr” (filters: 2)"
    );
    expect(label(call("catalog_search", { themes: "transportation" }))).toBe(
      "Searched the catalog (filters: 1)"
    );
    // Ranking, sorting and paging do not narrow the result.
    expect(
      label(call("catalog_search", { bbox_boost: "1,2,3,4", sortby: "-updated", limit: 5, offset: 5 }))
    ).toBe("Searched the catalog");
    expect(label(call("catalog_search", { q: "", themes: null }))).toBe("Searched the catalog");
    // A region counts as a filter; an empty list of regions does not.
    expect(label(call("catalog_search", { q: "rad", nuts: ["DE212"] }))).toBe(
      "Searched the catalog for “rad” (filters: 1)"
    );
    expect(label(call("catalog_search", { q: "rad", nuts: [] }))).toBe("Searched the catalog for “rad”");
  });

  it("name the region a lookup was for", () => {
    expect(label(call("catalog_find_region", { name: "München" }))).toBe("Looked up the region “München”");
    expect(label(call("catalog_find_region", {}))).toBe("Looked up a region");
    expect(label(call("catalog_show_records", { ids: ["a"] }))).toBe("Listed the recommended datasets");
    expect(label(call("project_get_workflows", {}))).toBe("Listed the project's workflows");
    expect(label(call("project_get_workflows", {}, { project_name: "Tool 4 V2", workflows: [] }))).toBe(
      "Listed the workflows of “Tool 4 V2”"
    );
    expect(label(call("project_get_layouts", {}, { project_name: "Tool 3", layouts: [] }))).toBe(
      "Listed the layouts of “Tool 3”"
    );
    expect(label(call("core_show_items", { groups: [] }))).toBe("Listed the matching items");
  });

  it("name a catalog record by its title, else its id", () => {
    const record = { item_id: "ds-1" };
    expect(label(call("catalog_get_record", record, { title: "Radverkehrsnetz" }))).toBe(
      "Read the catalog record “Radverkehrsnetz”"
    );
    expect(label(call("catalog_get_record", record, { properties: { title: "Item title" } }))).toBe(
      "Read the catalog record “Item title”"
    );
    expect(label(call("catalog_get_record", record))).toBe("Read the catalog record “ds-1”");
    expect(label(call("catalog_get_record", {}))).toBe("Read a catalog record");
  });

  it("name the prefix of a term check, and keep tools without a main argument plain", () => {
    expect(label(call("catalog_suggest_terms", { prefix: "rad" }))).toBe("Checked search terms for “rad”");
    expect(label(call("catalog_describe", { max_values: 5 }, { items: 1 }))).toBe("Read the catalog filters");
    expect(label(call("map_propose_view", { title: "Berlin" }, {}))).toBe("Prepared a map view");
    expect(label(call("core_whoami", {}, {}))).toBe("Read your account");
    expect(label(call("some_new_tool", {}, {}))).toBe("some_new_tool");
  });

  it("name the layer a project tool read from its result", () => {
    const layer = { layer_project_id: 87152 };
    expect(label(call("project_get_fields", layer, { layer: "Radwege" }))).toBe(
      "Read the fields of “Radwege”"
    );
    expect(label(call("project_sample_features", layer, { layer: "Radwege" }))).toBe(
      "Read sample features of “Radwege”"
    );
    expect(label(call("project_area_statistics", layer, { layer: "Radwege" }))).toBe(
      "Computed area statistics of “Radwege”"
    );
    expect(label(call("project_count_features", layer, { layer: "Radwege", count: 4 }))).toBe(
      "Counted features in “Radwege”"
    );
  });

  it("mark a filtered count, and tell two counts of one layer apart", () => {
    const filter = { conditions: [{ field: "surface", op: "=", value: "asphalt" }] };
    const plain = call("project_count_features", { layer_project_id: 1 }, { layer: "Radwege" });
    const filtered = call("project_count_features", { layer_project_id: 1, filter }, { layer: "Radwege" });
    expect(label(plain)).toBe("Counted features in “Radwege”");
    expect(label(filtered)).toBe("Counted features in “Radwege” (filtered)");
    expect(label(call("project_count_features", { layer_project_id: 1, filter: null }, { layer: "A" }))).toBe(
      "Counted features in “A”"
    );
  });

  it("name the field and the layer of a field statistic", () => {
    const step = call(
      "project_field_statistics",
      { layer_project_id: 3, field: "width" },
      { layer: "Radwege" }
    );
    expect(label(step)).toBe("Computed statistics of “width” in “Radwege”");
    expect(label(call("project_field_statistics", { layer_project_id: 3 }, { layer: "Radwege" }))).toBe(
      "Computed field statistics"
    );
  });

  it("name the project of a layer list", () => {
    expect(label(call("project_get_layers", { project_id: "p1" }, { name: "Bike plan", layers: [] }))).toBe(
      "Read the layers of “Bike plan”"
    );
    expect(label(call("project_get_layers", {}))).toBe("Read the project layers");
  });

  it("take a layer's name from the answer's layer list while the call has no result", () => {
    const layers = call(
      "project_get_layers",
      {},
      {
        project_id: "p1",
        name: "Bike plan",
        layers: [
          { layer_project_id: 87152, name: "Radwege" },
          { layer_project_id: 9, name: "Parks" },
        ],
      }
    );
    const running = call("project_count_features", { layer_project_id: 87152 });
    const broken = failed("project_get_fields", { layer_project_id: 9, project_id: "p1" });
    const steps = [layers, running, broken];
    expect(label(running, steps)).toBe("Counted features in “Radwege”");
    expect(label(broken, steps)).toBe("Read the fields of “Parks”");
  });

  it("do not give one project's layer name to another project's layer", () => {
    const layers = call(
      "project_get_layers",
      { project_id: "p1" },
      { project_id: "p1", name: "One", layers: [{ layer_project_id: 5, name: "Radwege" }] }
    );
    const other = call("project_count_features", { layer_project_id: 5, project_id: "p2" });
    const current = call("project_count_features", { layer_project_id: 5 });
    expect(label(other, [layers, other])).toBe("Counted features in layer 5");
    // A call without project_id is about the open project, which this list did not name.
    expect(label(current, [layers, current])).toBe("Counted features in layer 5");
    const same = call("project_count_features", { layer_project_id: 5, project_id: "p1" });
    expect(label(same, [layers, same])).toBe("Counted features in “Radwege”");
  });

  it("fall back to the layer's ID when no name is known", () => {
    expect(label(call("project_count_features", { layer_project_id: 87152 }))).toBe(
      "Counted features in layer 87152"
    );
    expect(label(failed("project_get_fields", { layer_project_id: 87152 }))).toBe(
      "Read the fields of layer 87152"
    );
    expect(
      label(
        call(
          "project_field_statistics",
          { layer_project_id: 87152, field: "width" },
          undefined,
          "output-error"
        )
      )
    ).toBe("Computed statistics of “width” in layer 87152");
    expect(label(call("project_count_features", {}))).toBe("Counted features");
  });

  it("cut a long argument to one line with an ellipsis", () => {
    const long = "Radverkehr ".repeat(20);
    const text = label(call("core_find", { query: `${long}\nmore` }));
    expect(text).not.toMatch(/\n/);
    const argument = text.slice("Searched your content for “".length, -1);
    expect(Array.from(argument)).toHaveLength(ARGUMENT_CHARS);
    expect(argument.endsWith("…")).toBe(true);
    expect(clip("short")).toBe("short");
    expect(clip("a".repeat(ARGUMENT_CHARS))).toBe("a".repeat(ARGUMENT_CHARS));
    expect(clip("a".repeat(ARGUMENT_CHARS + 1))).toBe(`${"a".repeat(ARGUMENT_CHARS - 1)}…`);
    // A character outside the BMP is not cut in half.
    expect(clip("🚲".repeat(ARGUMENT_CHARS + 5))).toBe(`${"🚲".repeat(ARGUMENT_CHARS - 1)}…`);
    // A layer name is cut like any other argument.
    const layer = label(call("project_get_fields", { layer_project_id: 1 }, { layer: "L".repeat(80) }));
    expect(layer).toBe(`Read the fields of “${"L".repeat(ARGUMENT_CHARS - 1)}…”`);
  });

  it("leave the values unescaped for the React text they end up in", () => {
    const step = call("core_find", { query: "a & <b> / 'c'" });
    expect(stepLabel(step, stepNames([step]), plainTranslate(enTranslate))).toBe(
      "Searched your content for “a & <b> / 'c'”"
    );
  });
});

describe("step rows", () => {
  const ids = (steps: DynamicToolUIPart[]) => steps.map((step) => step.toolCallId);
  const shape = (steps: DynamicToolUIPart[]) =>
    stepRows(steps).map((row) => [row.step.toolCallId, ids(row.rejected)]);

  it("folds a rejected attempt into the successful call of the same tool right after it", () => {
    const rejected = failed("project_count_features", { layer_project_id: 1, filter: "bad" });
    const retry = call("project_count_features", { layer_project_id: 1 }, { layer: "A", count: 3 });
    expect(shape([rejected, retry])).toEqual([[retry.toolCallId, [rejected.toolCallId]]]);
  });

  it("folds several rejected attempts into the call that finally succeeded", () => {
    const first = failed("core_find", { query: "" });
    const second = failed("core_find", { query: "x" });
    const ok = call("core_find", { query: "xy" }, { projects: [], datasets: [] });
    expect(shape([first, second, ok])).toEqual([[ok.toolCallId, [first.toolCallId, second.toolCallId]]]);
  });

  it("keeps a failure that no successful retry of the same tool follows", () => {
    const lone = failed("core_find", { query: "x" });
    const other = call("core_whoami", {}, {});
    const last = failed("catalog_search", { q: "a" });
    expect(shape([lone, other, last])).toEqual([
      [lone.toolCallId, []],
      [other.toolCallId, []],
      [last.toolCallId, []],
    ]);
    // A success of another tool in between does not count as the retry.
    const retry = call("core_find", { query: "xy" }, {});
    expect(shape([lone, other, retry])).toEqual([
      [lone.toolCallId, []],
      [other.toolCallId, []],
      [retry.toolCallId, []],
    ]);
    // Neither does a retry that is still running or fails as well.
    const running = call("core_find", { query: "xy" });
    expect(shape([lone, running])).toEqual([
      [lone.toolCallId, []],
      [running.toolCallId, []],
    ]);
    const again = failed("core_find", { query: "xy" });
    expect(shape([lone, again])).toEqual([
      [lone.toolCallId, []],
      [again.toolCallId, []],
    ]);
  });

  it("does not fold a failure into an earlier success, or a success into nothing", () => {
    const ok = call("core_find", { query: "x" }, {});
    const bad = failed("core_find", { query: "y" });
    expect(shape([ok, bad])).toEqual([
      [ok.toolCallId, []],
      [bad.toolCallId, []],
    ]);
  });
});

describe("workflow step labels", () => {
  const created = {
    workflow: { id: "w1", name: "Schools: 15-minute walk", project_id: "p1" },
    open_issues: [],
    groups: [],
  };

  it("name the workflow a create step made, and fall back to the plain label", () => {
    expect(label(call("workflow_create", { draft: {} }, created))).toBe(
      "Created the workflow “Schools: 15-minute walk”"
    );
    expect(label(call("workflow_create_from_template", { template_id: "t1" }, created))).toBe(
      "Created the workflow “Schools: 15-minute walk”"
    );
    expect(label(call("workflow_create", { draft: {} }))).toBe("Created a workflow");
    expect(label(failed("workflow_create_from_template", { template_id: "t1" }))).toBe(
      "Created a workflow from a template"
    );
  });

  it("have a label for each of the assistant's new tools", () => {
    expect(label(call("ask_user", { questions: [] }, {}))).toBe("Asked for your choice");
    expect(label(call("skills_load", { name: "build-a-workflow" }, {}))).toBe(
      "Read the instructions for the task"
    );
    expect(label(call("workflow_tools", {}, {}))).toBe("Read the available tools");
    expect(label(call("workflow_describe_tool", { tool_ids: ["buffer"] }, {}))).toBe(
      "Read the settings of tools"
    );
    expect(label(call("workflow_find_templates", { query: "catchment" }, {}))).toBe(
      "Searched workflow templates"
    );
    expect(label(call("workflow_check_draft", { draft: {} }, {}))).toBe("Checked the workflow draft");
    expect(label(call("project_add_catalog_layer", { catalog_id: "c1" }, {}))).toBe(
      "Added a catalog dataset to the project"
    );
  });
});

describe("running step labels", () => {
  const running = (step: DynamicToolUIPart, t: Translate = enTranslate) =>
    stepLabel(step, stepNames([step]), t, true);

  it("say in the present tense what the step is doing, with its argument", () => {
    expect(running(call("catalog_search", { q: "Schule" }))).toBe("Searching the catalog for “Schule”…");
    expect(running(call("catalog_search", { q: "Schule", year: 2024 }))).toBe(
      "Searching the catalog for “Schule” (filters: 1)…"
    );
    expect(running(call("core_find", { query: "rad", kind: "workflow" }))).toBe(
      "Searching workflows for “rad”…"
    );
    expect(running(call("catalog_get_record", { item_id: "ds-1" }))).toBe(
      "Reading the catalog record “ds-1”…"
    );
    expect(running(call("project_count_features", { layer_project_id: 5 }))).toBe(
      "Counting features in layer 5…"
    );
    expect(running(call("workflow_check_draft", { draft: {} }))).toBe("Checking the workflow draft…");
    expect(running(call("workflow_create", { draft: {} }))).toBe("Creating a workflow…");
  });

  it("say it in German, and fall back to Working for a tool the dock does not know", () => {
    expect(running(call("catalog_search", { q: "Schule" }), deTranslate)).toBe(
      "Durchsucht den Katalog nach „Schule“…"
    );
    expect(running(call("project_count_features", {}), deTranslate)).toBe("Zählt Features…");
    expect(running(call("some_new_tool", {}))).toBe("Working…");
    expect(running(call("some_new_tool", {}), deTranslate)).toBe("Arbeitet…");
  });

  it("keep the past tense for a finished step", () => {
    const step = call("catalog_search", { q: "Schule" }, { numberMatched: 2 });
    expect(stepLabel(step, stepNames([step]), enTranslate)).toBe("Searched the catalog for “Schule”");
  });
});

describe("step group summaries", () => {
  const search = (q: string) => call("catalog_search", { q }, { numberMatched: 1 });
  const record = (id: string) => call("catalog_get_record", { item_id: id }, { title: id });
  const region = () => call("catalog_find_region", { name: "Bonn" }, { regions: [] });
  const summary = (steps: DynamicToolUIPart[], t: Translate = enTranslate) =>
    groupSummary(stepRows(steps), t, false);

  it("count the steps by kind, in the order the kinds first appear", () => {
    const steps = [
      search("a"),
      record("r1"),
      search("b"),
      record("r2"),
      record("r3"),
      search("c"),
      record("r4"),
      record("r5"),
      search("d"),
      record("r6"),
      region(),
    ];
    expect(summary(steps)).toBe("Searched the catalog 4 times, read 6 catalog records, looked up a region");
    expect(summary(steps, deTranslate)).toBe(
      "Katalog 4-mal durchsucht, 6 Katalogeinträge gelesen, eine Region nachgeschlagen"
    );
  });

  it("start with a capital whichever kind comes first", () => {
    expect(summary([region(), search("a")])).toBe("Looked up a region, searched the catalog");
    expect(summary([region(), search("a")], deTranslate)).toBe(
      "Eine Region nachgeschlagen, Katalog durchsucht"
    );
  });

  it("name three kinds at most, then count the other steps", () => {
    const count = () => call("project_count_features", { layer_project_id: 1 }, { layer: "A", count: 1 });
    const fields = () => call("project_get_fields", { layer_project_id: 1 }, { layer: "A", fields: [] });
    const steps = [search("a"), search("b"), record("r1"), region(), count(), count(), fields()];
    expect(summary(steps)).toBe(
      "Searched the catalog 2 times, read a catalog record, looked up a region and 3 more steps"
    );
    expect(summary(steps, deTranslate)).toBe(
      "Katalog 2-mal durchsucht, einen Katalogeintrag gelesen, eine Region nachgeschlagen und 3 weitere Schritte ausgeführt"
    );
    expect(summary([search("a"), record("r1"), region(), fields()])).toBe(
      "Searched the catalog, read a catalog record, looked up a region and 1 more step"
    );
  });

  it("leave writes and failures out of the count: they stay visible as lines of their own", () => {
    const create = call("workflow_create", { draft: {} }, { workflow: { name: "W" } });
    const added = call("project_add_catalog_layer", { catalog_id: "c1" }, {});
    const broken = failed("core_find", { query: "x" });
    const steps = [search("a"), broken, search("b"), create, added];
    const rows = stepRows(steps);
    expect(rows.filter((row) => staysVisible(row, false)).map((row) => row.step)).toEqual([
      broken,
      create,
      added,
    ]);
    expect(groupSummary(rows, enTranslate, false)).toBe("Searched the catalog 2 times");
    // A rejected attempt the model corrected is part of its retry, not a failure.
    const rejected = failed("catalog_search", { q: "" });
    expect(stepRows([rejected, search("c")]).filter((row) => staysVisible(row, false))).toEqual([]);
  });

  it("keep a step the run left unreturned visible once the answer stopped, and count it while it runs", () => {
    const unreturned = call("catalog_search", { q: "c" });
    const rows = stepRows([search("a"), search("b"), unreturned]);
    expect(rows.filter((row) => staysVisible(row, false)).map((row) => row.step)).toEqual([unreturned]);
    expect(groupSummary(rows, enTranslate, false)).toBe("Searched the catalog 2 times");
    expect(rows.filter((row) => staysVisible(row, true))).toEqual([]);
    expect(groupSummary(rows, enTranslate, true)).toBe("Searched the catalog 3 times");
  });

  it("count records, regions, layers, projects, statistics and tasks by the inputs that name them", () => {
    const fields = (layer: number, project?: string) =>
      call(
        "project_get_fields",
        { layer_project_id: layer, ...(project ? { project_id: project } : {}) },
        {}
      );
    const regionOf = (name: string) => call("catalog_find_region", { name }, { regions: [] });
    const layers = (project?: string) =>
      call("project_get_layers", project ? { project_id: project } : {}, {});
    const statistic = (tool: string, field?: string) =>
      call(tool, { layer_project_id: 1, ...(field ? { field } : {}) }, {});
    const skill = (name: string) => call("skills_load", { name }, {});
    expect(summary([record("r1"), record("r1"), record("r2")])).toBe("Read 2 catalog records");
    expect(summary([fields(1), fields(1)])).toBe("Read the fields of a layer");
    expect(summary([fields(1), fields(1, "p2"), fields(2)])).toBe("Read the fields of 3 layers");
    expect(summary([regionOf("Bonn"), regionOf("bonn "), regionOf("Köln")])).toBe("Looked up 2 regions");
    // A call without project_id reads the open project.
    expect(summary([layers(), layers("p2"), layers()])).toBe("Read the layers of 2 projects");
    expect(
      summary([
        statistic("project_field_statistics", "a"),
        statistic("project_field_statistics", "a"),
        statistic("project_area_statistics"),
      ])
    ).toBe("Computed 2 statistics");
    expect(summary([skill("build-a-workflow"), skill("build-a-workflow")])).toBe(
      "Read the instructions for a task"
    );
    const page = (id: string) => call("docs_read", { page: id }, {});
    expect(summary([page("map/filter"), page("map/filter")])).toBe("Read a page of the documentation");
    expect(summary([page("map/filter"), page("map/layers")], deTranslate)).toBe(
      "2 Seiten der Dokumentation gelesen"
    );
    // A call that names nothing counts on its own.
    const unnamed = () => call("catalog_get_record", {}, {});
    expect(summary([unnamed(), unnamed()])).toBe("Read 2 catalog records");
    expect(summary([layers(), layers("p2")], deTranslate)).toBe("Die Layer von 2 Projekten gelesen");
  });

  it("count statistics on one layer apart when the inputs that shape them differ", () => {
    const district = (name: string) => ({
      match: "all",
      conditions: [{ field: "district", op: "=", value: name }],
    });
    const area = (input: Record<string, unknown> = {}) =>
      call("project_area_statistics", { layer_project_id: 3, ...input }, { feature_count: 4 });
    const widths = (input: Record<string, unknown> = {}) =>
      call(
        "project_field_statistics",
        { layer_project_id: 3, field: "width", ...input },
        { kind: "numeric", feature_count: 4 }
      );
    // The parks of two districts are two results, and so are two classifications of one field.
    expect(summary([area({ filter: district("A") }), area({ filter: district("B") })])).toBe(
      "Computed 2 statistics"
    );
    expect(summary([widths({ filter: district("A") }), widths()])).toBe("Computed 2 statistics");
    expect(summary([widths({ breaks: 5 }), widths({ breaks: 7 })])).toBe("Computed 2 statistics");
    expect(summary([widths({ method: "quantile" }), widths({ method: "equal_interval" })])).toBe(
      "Computed 2 statistics"
    );
    // The same inputs written in another order, or a filter given as null, are the same statistic.
    const reordered = { conditions: [{ value: "A", op: "=", field: "district" }], match: "all" };
    expect(summary([area({ filter: reordered }), area({ filter: district("A") })])).toBe(
      "Computed a statistic"
    );
    expect(summary([area({ filter: null }), area()])).toBe("Computed a statistic");
    expect(summary([area({ filter: district("A") }), area({ filter: district("B") })], deTranslate)).toBe(
      "2 Statistiken berechnet"
    );
  });

  it("count a call that names the open project as one without project_id", () => {
    const open = "3731e570-0000-4000-8000-000000000001";
    const openSummary = (steps: DynamicToolUIPart[]) =>
      groupSummary(stepRows(steps), enTranslate, false, open);
    const layers = (project?: string) =>
      call("project_get_layers", project ? { project_id: project } : {}, {});
    const fields = (project?: string) =>
      call("project_get_fields", { layer_project_id: 1, ...(project ? { project_id: project } : {}) }, {});
    const workflows = (project?: string) =>
      call("project_get_workflows", project ? { project_id: project } : {}, {});
    const area = (project?: string) =>
      call(
        "project_area_statistics",
        { layer_project_id: 1, ...(project ? { project_id: project } : {}) },
        {}
      );
    expect(openSummary([layers(), layers(open)])).toBe("Read the layers of a project");
    expect(openSummary([layers(), layers(open.toUpperCase())])).toBe("Read the layers of a project");
    expect(openSummary([fields(), fields(open)])).toBe("Read the fields of a layer");
    expect(openSummary([workflows(open), workflows()])).toBe("Listed the workflows of a project");
    expect(openSummary([area(open), area()])).toBe("Computed a statistic");
    // Another project stays another project.
    expect(openSummary([layers(), layers("p2")])).toBe("Read the layers of 2 projects");
    // Without an open project, an ID is counted as it is.
    expect(summary([layers(), layers(open)])).toBe("Read the layers of 2 projects");
  });

  it("count a step of a tool the dock does not know", () => {
    expect(summary([search("a"), call("some_new_tool", {}, {}), call("other_new_tool", {}, {})])).toBe(
      "Searched the catalog, ran 2 steps"
    );
  });

  it("keep a workflow run visible, and count reads of runs by workflow and group statistics as statistics", () => {
    const ran = call("workflow_run", { workflow_id: "w1" }, { status: "succeeded" });
    const lastRun = (workflow: string) => call("workflow_last_run", { workflow_id: workflow }, {});
    const groups = (field: string) =>
      call("project_group_statistics", { layer_project_id: 1, operation: "count", group_by: field }, {});
    expect(label(ran)).toBe("Ran the workflow");
    expect(label(lastRun("w1"))).toBe("Read the workflow's last run");
    expect(label(groups("district"))).toBe("Computed statistics per group");
    const rows = stepRows([ran, lastRun("w1"), lastRun("w1"), groups("district"), groups("type")]);
    expect(rows.filter((row) => staysVisible(row, false)).map((row) => row.step)).toEqual([ran]);
    expect(groupSummary(rows, enTranslate, false)).toBe(
      "Read the last run of a workflow, computed 2 statistics"
    );
    expect(summary([lastRun("w1"), lastRun("w2")])).toBe("Read the last runs of 2 workflows");
    expect(summary([lastRun("w1"), lastRun("w2")], deTranslate)).toBe(
      "Die letzten Läufe von 2 Workflows gelesen"
    );
  });
});

describe("workflow edit steps", () => {
  const summary = (steps: DynamicToolUIPart[], t: Translate = enTranslate) =>
    groupSummary(stepRows(steps), t, false);
  const read = (workflow: string, name?: string) =>
    call("workflow_get", { workflow_id: workflow }, name ? { workflow_id: workflow, name, revision: 4 } : {});
  const edit = call(
    "workflow_update",
    { workflow_id: "w1", operations: [] },
    { workflow_id: "w1", revision_before: 4, revision_after: 5, changed_steps: [] }
  );

  it("name the workflow read, and say a change of it", () => {
    expect(label(read("w1", "Schools: walk"))).toBe("Read the workflow “Schools: walk”");
    expect(label(call("workflow_get", { workflow_id: "w1" }))).toBe("Read a workflow");
    expect(label(edit)).toBe("Changed the workflow");
    expect(stepLabel(edit, stepNames([edit]), deTranslate)).toBe("Workflow geändert");
  });

  it("keep a change visible as a line of its own, and count reads by workflow", () => {
    const rows = stepRows([read("w1", "A"), edit, read("w1", "A"), read("w2", "B")]);
    expect(rows.filter((row) => staysVisible(row, false)).map((row) => row.step)).toEqual([edit]);
    expect(summary([read("w1", "A"), read("w1", "A"), read("w2", "B")])).toBe("Read 2 workflows");
    expect(summary([read("w1", "A")], deTranslate)).toBe("Einen Workflow gelesen");
  });

  it("name the changed workflow by what the answer's other steps read or made of it", () => {
    const de = (step: DynamicToolUIPart, steps: DynamicToolUIPart[]) =>
      stepLabel(step, stepNames(steps), deTranslate);
    // Its result carries no name: the read before it does.
    expect(label(edit, [read("W1", "Schools: walk"), edit])).toBe("Changed the workflow “Schools: walk”");
    expect(de(edit, [read("w1", "Schools: walk"), edit])).toBe("Workflow „Schools: walk“ geändert");
    // A workflow the answer created, or one the project's list named.
    const created = call(
      "workflow_create",
      { draft: {} },
      { workflow: { id: "w1", name: "Kitas", project_id: "p1" }, groups: [] }
    );
    expect(label(edit, [created, edit])).toBe("Changed the workflow “Kitas”");
    const listed = call(
      "project_get_workflows",
      {},
      { project_name: "P", workflows: [{ id: "w1", name: "Radnetz" }] }
    );
    expect(label(edit, [listed, edit])).toBe("Changed the workflow “Radnetz”");
    // Under way, and failed: the same name.
    const changing = call("workflow_update", { workflow_id: "w1", operations: [] });
    expect(stepLabel(changing, stepNames([read("w1", "Kitas"), changing]), enTranslate, true)).toBe(
      "Changing the workflow “Kitas”…"
    );
    const broken = failed("workflow_update", { workflow_id: "w1", operations: [] });
    expect(label(broken, [read("w1", "Kitas"), broken])).toBe("Changed the workflow “Kitas”");
    // Another workflow's name is not this one's.
    expect(label(edit, [read("w2", "Other"), edit])).toBe("Changed the workflow");
  });
});

describe("added datasets", () => {
  const added = (...names: string[]) =>
    call(
      "project_add_catalog_layer",
      { catalog_id: "c1" },
      { project_id: "p1", layers: names.map((name, index) => ({ layer_project_id: index + 1, name })) }
    );

  it("name the dataset an add put into the project", () => {
    expect(label(added("Zensus 2022 population"))).toBe("Added “Zensus 2022 population” to the project");
    expect(stepLabel(added("Supermärkte"), stepNames([]), deTranslate)).toBe(
      "„Supermärkte“ zum Projekt hinzugefügt"
    );
    // A long name is cut, as every argument of a label is.
    const long = "x".repeat(60);
    expect(label(added(long))).toBe(`Added “${clip(long)}” to the project`);
  });

  it("fall back to the plain label without one name: a failed add, or a bundle's several layers", () => {
    expect(label(failed("project_add_catalog_layer", { catalog_id: "c1" }))).toBe(
      "Added a catalog dataset to the project"
    );
    expect(label(added("Stops", "Routes"))).toBe("Added a catalog dataset to the project");
    expect(label(added())).toBe("Added a catalog dataset to the project");
    expect(
      stepLabel(call("project_add_catalog_layer", { catalog_id: "c1" }), stepNames([]), enTranslate, true)
    ).toBe("Adding a catalog dataset to the project…");
  });
});

describe("style and map steps", () => {
  const summary = (steps: DynamicToolUIPart[], t: Translate = enTranslate) =>
    groupSummary(stepRows(steps), t, false);
  const de = (step: DynamicToolUIPart) => stepLabel(step, stepNames([step]), deTranslate);
  const running = (step: DynamicToolUIPart, t: Translate = enTranslate) =>
    stepLabel(step, stepNames([step]), t, true);
  const styleRead = (layer: number, part?: string) =>
    call("style_get", { layer_project_id: layer, ...(part && { part }) }, { layer_project_id: layer });
  const catalog = () =>
    call("style_catalog", { kind: "palettes" }, { kind: "palettes", results: [], total: 0 });
  const styleChange = call(
    "style_update",
    { layer_project_id: 1, operations: [] },
    { layer_project_id: 1, style_id: "s1", name: "Default", created: false, active: true }
  );
  const mapChange = call(
    "map_update",
    { operations: [{ op: "set_layer", layer_project_id: 1, visible: false }] },
    { applied: [{ index: 0, op: "set_layer", layer_project_id: 1, fields: ["visible"], summary: "hidden" }] }
  );

  it("labels the four new tools in both languages, finished and running", () => {
    expect(label(styleRead(1))).toBe("Read the style");
    expect(de(styleRead(1))).toBe("Stil gelesen");
    expect(label(catalog())).toBe("Looked up palettes and icons");
    expect(de(catalog())).toBe("Paletten und Icons nachgeschlagen");
    expect(label(styleChange)).toBe("Changed the style");
    expect(de(styleChange)).toBe("Stil geändert");
    expect(label(mapChange)).toBe("Changed the map");
    expect(de(mapChange)).toBe("Karte geändert");

    expect(running(call("style_get", { layer_project_id: 1 }))).toBe("Reading the style…");
    expect(running(call("style_get", { layer_project_id: 1 }), deTranslate)).toBe("Liest den Stil…");
    expect(running(call("style_catalog", { kind: "icons" }))).toBe("Looking up palettes and icons…");
    expect(running(call("style_catalog", { kind: "icons" }), deTranslate)).toBe(
      "Schlägt Paletten und Icons nach…"
    );
    const changingStyle = call("style_update", { layer_project_id: 1, new_style: { name: "Dichte" } });
    expect(running(changingStyle)).toBe("Changing the style…");
    expect(running(changingStyle, deTranslate)).toBe("Ändert den Stil…");
    const changingMap = call("map_update", { operations: [] });
    expect(running(changingMap)).toBe("Changing the map…");
    expect(running(changingMap, deTranslate)).toBe("Ändert die Karte…");
    // A failed change keeps the plain label.
    expect(label(failed("style_update", { layer_project_id: 1 }))).toBe("Changed the style");
    expect(label(failed("map_update", { operations: [] }))).toBe("Changed the map");
  });

  it("says Created the style with its name when the result created one", () => {
    const created = (name: unknown) =>
      call(
        "style_update",
        { layer_project_id: 1, new_style: { name: "x" } },
        { layer_project_id: 1, style_id: "s2", name, created: true, active: true }
      );
    expect(label(created("Population density"))).toBe("Created the style “Population density”");
    expect(de(created("Bevölkerungsdichte"))).toBe("Stil „Bevölkerungsdichte“ erstellt");
    // A long name is cut, as every argument of a label is.
    const long = "y".repeat(60);
    expect(label(created(long))).toBe(`Created the style “${clip(long)}”`);
    // Without a name, or for a style changed in place, the plain label.
    expect(label(created(""))).toBe("Changed the style");
    expect(label(styleChange)).toBe("Changed the style");
  });

  it("says Moved the map view for a change that only moved the view", () => {
    const moved = call(
      "map_update",
      { operations: [{ op: "set_view", zoom: 12 }] },
      // The tool lists the view among what it applied.
      {
        applied: [{ index: 0, op: "set_view", summary: "The page shows the view: zoom 12." }],
        view: { camera: { zoom: 12 } },
      }
    );
    expect(label(moved)).toBe("Moved the map view");
    expect(de(moved)).toBe("Kartenansicht bewegt");
    // A view beside other changes, or no view at all: the map label.
    const both = call(
      "map_update",
      { operations: [] },
      { applied: [{ index: 0, op: "set_basemap", summary: "light" }], view: { camera: { zoom: 3 } } }
    );
    expect(label(both)).toBe("Changed the map");
    expect(label(call("map_update", { operations: [] }, { applied: [], view: null }))).toBe(
      "Changed the map"
    );
    expect(running(call("map_update", { operations: [{ op: "set_view", zoom: 12 }] }))).toBe(
      "Changing the map…"
    );
  });

  it("says Checked what removing the layer affects for a removal that waits for the user", () => {
    const ask = (layer: number) => ({
      layer_project_id: layer,
      name: `Layer ${layer}`,
      value: `remove_layer:${layer}`,
      facts: { used_by_workflows: [] },
    });
    const asked = (confirm: unknown, applied: unknown[] = []) =>
      call(
        "map_update",
        { operations: [{ op: "remove_layer", layer_project_id: 1 }] },
        { project_id: "p1", applied, confirm }
      );
    expect(label(asked([ask(1)]))).toBe("Checked what removing the layer affects");
    expect(de(asked([ask(1)]))).toBe("Geprüft, was das Entfernen des Layers betrifft");
    expect(label(asked([ask(1), ask(2)]))).toBe("Checked what removing the layers affects");
    expect(de(asked([ask(1), ask(2)]))).toBe("Geprüft, was das Entfernen der Layer betrifft");
    // It asks before the view: a view beside the question does not make it a move.
    const askedWithView = call(
      "map_update",
      { operations: [] },
      {
        project_id: "p1",
        applied: [{ index: 1, op: "set_view", summary: "The page shows the view: zoom 12." }],
        confirm: [ask(1)],
        view: { camera: { zoom: 12 } },
      }
    );
    expect(label(askedWithView)).toBe("Checked what removing the layer affects");
    // Something applied, or nothing to ask: the labels it has without the question.
    const hiddenOp = {
      index: 0,
      op: "set_layer",
      layer_project_id: 2,
      fields: ["visible"],
      summary: "hidden",
    };
    expect(label(asked([], [hiddenOp]))).toBe("Changed the map");
    expect(label(asked([ask(1)], [hiddenOp]))).toBe("Changed the map");
    expect(label(asked([]))).toBe("Changed the map");
    expect(label(asked(null))).toBe("Changed the map");
    expect(running(call("map_update", { operations: [{ op: "remove_layer", layer_project_id: 1 }] }))).toBe(
      "Changing the map…"
    );
  });

  it("never folds style_update and map_update into a summary", () => {
    const rows = stepRows([styleRead(1), styleChange, catalog(), mapChange]);
    expect(rows.filter((row) => staysVisible(row, false)).map((row) => row.step)).toEqual([
      styleChange,
      mapChange,
    ]);
    expect(groupSummary(rows, enTranslate, false)).toBe("Read a style, looked up palettes and icons");
  });

  it("counts style_get and style_catalog under their own kinds", () => {
    // Two reads of one style (another part of it) are one style read.
    expect(summary([styleRead(1), styleRead(1, "/popup"), styleRead(2)])).toBe("Read 2 styles");
    expect(summary([styleRead(1)])).toBe("Read a style");
    expect(summary([styleRead(1)], deTranslate)).toBe("Einen Stil gelesen");
    expect(summary([styleRead(1), styleRead(2)], deTranslate)).toBe("2 Stile gelesen");
    expect(summary([catalog()])).toBe("Looked up palettes and icons");
    // The count of lookups says nothing to the reader: several read as one.
    expect(summary([catalog(), catalog()])).toBe("Looked up palettes and icons");
    expect(summary([catalog()], deTranslate)).toBe("Paletten und Icons nachgeschlagen");
    expect(summary([catalog(), catalog()], deTranslate)).toBe("Paletten und Icons nachgeschlagen");
  });
});

describe("step results", () => {
  it("write counts with the UI language's thousands separator", () => {
    const counted = call("project_count_features", { layer_project_id: 1 }, { layer: "A", count: 4766 });
    expect(stepResult(counted, enTranslate)).toBe("4,766 features");
    expect(stepResult(counted, deTranslate)).toBe("4.766 Features");
    const found = call("catalog_search", { q: "a" }, { numberMatched: 12500 });
    expect(stepResult(found, deTranslate)).toBe("12.500 Datensätze");
  });

  it("say nothing about a result an earlier release kept back, for any tool", () => {
    // Stored before the data policy was removed: neither a count nor "none".
    const withheld = { withheld: true, reason: "Withheld: the data policy allows no 'contains'." };
    const sampled = call("project_sample_features", { layer_project_id: 1 }, withheld);
    expect(stepResult(sampled, enTranslate)).toBeUndefined();
    const counted = call("project_count_features", { layer_project_id: 1 }, withheld);
    expect(stepResult(counted, deTranslate)).toBeUndefined();
    const uncounted = call("project_count_features", { layer_project_id: 1 }, { layer: "A", count: null });
    expect(stepResult(uncounted, enTranslate)).toBeUndefined();
  });
});

describe("repeated writes", () => {
  const styleChange = () =>
    call(
      "style_update",
      { layer_project_id: 1, operations: [] },
      {
        project_id: "p1",
        layer_project_id: 1,
        style_id: "s1",
        created: false,
        revision_before: 1,
        revision_after: 2,
      }
    );
  const styleCreate = (name: string) =>
    call("style_update", { layer_project_id: 1, operations: [] }, { style_id: "s2", created: true, name });
  const read = (workflow: string, name: string) =>
    call("workflow_get", { workflow_id: workflow }, { workflow_id: workflow, name, revision: 4 });
  const edit = (workflow: string) =>
    call(
      "workflow_update",
      { workflow_id: workflow, operations: [] },
      { workflow_id: workflow, revision_before: 4, revision_after: 5, changed_steps: [] }
    );
  const search = (q: string) => call("catalog_search", { q }, { numberMatched: 3 });
  /** Each row as its call and the further calls it stands for. */
  const shape = (steps: DynamicToolUIPart[]) =>
    foldRepeatedWrites(stepRows(steps), stepNames(steps), enTranslate).map((row) => [
      row.step.toolCallId,
      (row.repeats ?? []).map((step) => step.toolCallId),
    ]);

  it("fold adjacent finished writes with the same label into the first one's row", () => {
    const steps = [styleChange(), styleChange(), styleChange(), styleChange(), styleChange()];
    const [first, ...rest] = steps;
    expect(shape(steps)).toEqual([[first.toolCallId, rest.map((step) => step.toolCallId)]]);
  });

  it("keep writes with different labels apart", () => {
    const a = edit("w1");
    const b = edit("w2");
    const steps = [read("w1", "A"), read("w2", "B"), a, b];
    expect(shape(steps).slice(2)).toEqual([
      [a.toolCallId, []],
      [b.toolCallId, []],
    ]);
    const changed = styleChange();
    const created = styleCreate("X");
    expect(shape([created, changed])).toEqual([
      [created.toolCallId, []],
      [changed.toolCallId, []],
    ]);
    // The same workflow's name twice is the same label.
    const again = edit("w1");
    expect(shape([read("w1", "A"), a, again]).slice(1)).toEqual([[a.toolCallId, [again.toolCallId]]]);
  });

  it("break a run at a failed, running or other step, and keep failed and running writes on their own", () => {
    const [one, two, three] = [styleChange(), styleChange(), styleChange()];
    const broken = failed("style_update", { layer_project_id: 1, operations: [] });
    const busy = call("style_update", { layer_project_id: 1, operations: [] });
    const between = search("a");
    expect(shape([one, busy, two])).toEqual([
      [one.toolCallId, []],
      [busy.toolCallId, []],
      [two.toolCallId, []],
    ]);
    expect(shape([one, between, two, three])).toEqual([
      [one.toolCallId, []],
      [between.toolCallId, []],
      [two.toolCallId, [three.toolCallId]],
    ]);
    // A failure followed by a success of the same tool is that call's retry: the retried call stands alone.
    expect(shape([one, broken, two, three])).toEqual([
      [one.toolCallId, []],
      [two.toolCallId, []],
      [three.toolCallId, []],
    ]);
    const lastBroken = failed("style_update", { layer_project_id: 1, operations: [] });
    expect(shape([one, two, lastBroken])).toEqual([
      [one.toolCallId, [two.toolCallId]],
      [lastBroken.toolCallId, []],
    ]);
  });

  it("never fold reads, and leave the summary and the visible lines of a group as they were", () => {
    const [a, b] = [search("a"), search("a")];
    expect(shape([a, b])).toEqual([
      [a.toolCallId, []],
      [b.toolCallId, []],
    ]);
    const steps = [search("a"), styleChange(), styleChange(), search("b")];
    const rows = foldRepeatedWrites(stepRows(steps), stepNames(steps), enTranslate);
    expect(groupSummary(rows, enTranslate, false)).toBe(groupSummary(stepRows(steps), enTranslate, false));
    expect(rows.filter((row) => staysVisible(row, false))).toHaveLength(1);
  });
});
