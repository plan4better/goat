import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { filterIssues } from "@/lib/filter/issues";
import type { Fields, FilterModel } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { writeFilter } from "@/lib/filter/write";

import { FilterPanel } from "@/components/map/panels/filter/FilterPanel";

import { renderWithProviders } from "../../styleEditor/__tests__/renderPanel";

// Counts each condition row's renders inside a memo boundary of its own: a row renders again only when its props
// change, so the count shows which rows a change reached.
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("@/components/map/panels/filter/ConditionRow", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/map/panels/filter/ConditionRow")>();
  const Original = original.ConditionRow;
  return {
    ...original,
    ConditionRow: memo(function Counted(props: Parameters<typeof Original>[0]) {
      renders.set(props.row.id, (renders.get(props.row.id) ?? 0) + 1);
      return <Original {...props} />;
    }),
  };
});
const uniqueValues = vi.hoisted(() =>
  vi.fn((_layerId: string, _field: string, _params?: object) => ({ data: undefined, isLoading: false }))
);
vi.mock("@/lib/api/layers", () => ({
  useLayerUniqueValues: uniqueValues,
  useLayerQueryables: () => ({ queryables: undefined, isLoading: false }),
  useDatasetCollectionItems: () => ({ data: undefined, isLoading: false }),
}));
// The area's draw tool and its outline live on the map, which these tests have none of.
vi.mock("@/components/map/panels/filter/area/useAreaDraw", () => ({
  useAreaDraw: () => ({ available: false, drawing: null, start: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/components/map/panels/filter/area/outline", () => ({ useAreaOutline: vi.fn() }));
// The whole dataset's traffic, 0 to 100 in ten bins; one answer, as SWR keeps it.
const histogram = vi.hoisted(() => {
  const stats = {
    bins: Array.from({ length: 10 }, (_, i) => ({ range: [i * 10, i * 10 + 10], count: i + 1 })),
    missing_count: 0,
    total_rows: 55,
  };
  return vi.fn((layerId?: string, _params?: object) => ({
    histogramStats: layerId ? (stats as typeof stats | undefined) : undefined,
    isLoading: false,
  }));
});
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<object>()),
  useProjectLayerHistogramStats: histogram,
}));
// The dataset holds 5000 features, 1200 of them under any filter.
const counted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/processes", () => ({
  useFeatureCount: (layerId: string | undefined, filter?: string) => {
    counted(layerId, filter);
    return {
      featureCount: layerId ? (filter ? 1200 : 5000) : undefined,
      isLoading: false,
      isError: undefined,
    };
  },
}));

const FIELDS: Fields = { name: "string", traffic: "number" };
const p = (field: string) => ({ property: field });
const AREA = {
  op: "s_intersects",
  args: [
    p("geom"),
    {
      type: "Polygon",
      coordinates: [
        [
          [7.1, 50.7],
          [7.2, 50.7],
          [7.2, 50.8],
          [7.1, 50.7],
        ],
      ],
    },
  ],
};

function setup(
  cql: unknown,
  opts: { canEdit?: boolean; canSwitch?: boolean; ui?: unknown; fields?: Fields } = {}
) {
  const fields = opts.fields ?? FIELDS;
  const model = readFilter(cql, opts.ui, fields);
  const onApply = vi.fn<(model: FilterModel) => Promise<void>>(async () => undefined);
  const view = renderWithProviders(
    <FilterPanel
      model={model}
      fields={fields}
      issues={filterIssues(model, fields)}
      canEdit={opts.canEdit ?? true}
      canSwitch={opts.canSwitch}
      onApply={onApply}
      layerId="dataset-1"
    />
  );
  return { ...view, model, onApply };
}

const rowEl = (id: string) => document.querySelector(`[data-filter-row="${id}"]`) as HTMLElement;
/** The conditions' rows: the area has a row of its own above them. */
const conditionRows = () => document.querySelectorAll("[data-filter-row]:not([data-filter-row='area'])");
const openRow = (id: string) => userEvent.click(within(rowEl(id)).getAllByRole("button")[0]);
const written = (model: FilterModel) => writeFilter(model, FIELDS);
const lastApplied = (onApply: ReturnType<typeof setup>["onApply"]) =>
  onApply.mock.calls.at(-1)?.[0] as FilterModel;

/** Types into the condition editor's value box and leaves it. */
async function typeValue(text: string, name = "style_editor.condition_value") {
  const box = screen.getByRole("textbox", { name });
  await userEvent.clear(box);
  await userEvent.type(box, text);
  fireEvent.blur(box);
}

describe("the filter panel", () => {
  beforeEach(() => {
    renders.clear();
    counted.mockClear();
    uniqueValues.mockClear();
    // Back to its answer above, also after a test that gave it another.
    histogram.mockReset();
  });

  it("asks for a field's values only once a row's editor opens", async () => {
    setup({
      op: "and",
      args: [
        { op: "in", args: [p("name"), ["a", "b"]] },
        { op: "=", args: [p("traffic"), 10] },
      ],
    });
    expect(uniqueValues).not.toHaveBeenCalled();
    await openRow("r0");
    expect(uniqueValues).toHaveBeenCalledWith("dataset-1", "name", expect.objectContaining({ page: 1 }));
    expect(uniqueValues.mock.calls.every(([, field]) => field === "name")).toBe(true);
    expect(screen.getByRole("listbox", { name: "style_editor.condition_value" })).toBeDefined();
  });

  it("asks for a field's histogram only once a number comparison's editor opens", async () => {
    setup({
      op: "and",
      args: [
        { op: "in", args: [p("name"), ["a", "b"]] },
        { op: ">=", args: [p("traffic"), 10] },
      ],
    });
    await openRow("r0");
    expect(histogram).not.toHaveBeenCalled();
    await openRow("r1");
    expect(histogram).toHaveBeenCalledWith("dataset-1", expect.objectContaining({ column_name: "traffic" }));
    // The slider over the histogram, the box for an exact value under it.
    expect(screen.getByRole("slider", { name: "style_editor.condition_value" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "style_editor.condition_value" })).toBeDefined();
  });

  it("a step of the slider saves the value", async () => {
    const { onApply } = setup({ op: "between", args: [p("traffic"), 20, 60] });
    await openRow("r0");
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.condition_value_to" }), {
      target: { value: 70 },
    });
    await vi.waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(lastApplied(onApply).rows).toEqual([
      expect.objectContaining({ field: "traffic", op: "is_between", value: 20, value2: 70 }),
    ]);
  });

  it("without the field's histogram the editor shows the boxes only", async () => {
    histogram.mockImplementation(() => ({ histogramStats: undefined, isLoading: true }));
    setup({ op: "<", args: [p("traffic"), 10] });
    await openRow("r0");
    expect(histogram).toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "style_editor.condition_value" })).toBeDefined();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("typing in one row's editor renders that row again, not the others", async () => {
    const { onApply } = setup({
      op: "and",
      args: [
        { op: "like", args: [p("name"), "%ab%"] },
        { op: ">", args: [p("traffic"), 10] },
      ],
    });
    await openRow("r0");
    const before = { r0: renders.get("r0") ?? 0, r1: renders.get("r1") ?? 0 };
    await typeValue("abc");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(renders.get("r1")).toBe(before.r1);
    expect(renders.get("r0")).toBeGreaterThan(before.r0);
  });

  it("a new condition calls up once it is complete, not before", async () => {
    const { onApply } = setup(undefined);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("traffic"));
    await userEvent.click(screen.getByRole("combobox", { name: "style_editor.condition_compare" }));
    // The editor of the new row lists the field's values too: the comparison's options are the menu's.
    await userEvent.click(screen.getByRole("option", { name: "filter_panel.op.is_greater_than" }));
    expect(onApply).not.toHaveBeenCalled();
    await typeValue("5{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(lastApplied(onApply)).toEqual({
      match: "all",
      rows: [expect.objectContaining({ field: "traffic", op: "is_greater_than", value: 5, enabled: true })],
    });
  });

  it("an unfinished row stays in the panel and saves nothing", async () => {
    const { onApply } = setup(undefined);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("name"));
    expect(conditionRows()).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a viewer sees the rows as text, with nothing to change", async () => {
    const { onApply } = setup(
      {
        op: "and",
        args: [{ op: "like", args: [p("name"), "%ab%"] }, { op: ">", args: [p("traffic"), 10] }, AREA],
      },
      { canEdit: false }
    );
    expect(conditionRows()).toHaveLength(2);
    expect(within(rowEl("area")).getByText("filter_panel.area_shape")).toBeDefined();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("a saved area beside a condition is the filter's area, kept as it was when the condition changes", async () => {
    const cql = { op: "and", args: [AREA, { op: "like", args: [p("name"), "%ab%"] }] };
    const { onApply } = setup(cql);
    expect(within(rowEl("area")).getByText("filter_panel.area_shape")).toBeDefined();
    expect(screen.queryByText("filter_panel.custom")).toBeNull();
    expect(conditionRows()).toHaveLength(1);
    await openRow("r0");
    await typeValue("xy");
    const out = written(lastApplied(onApply));
    expect(JSON.stringify((out.cql?.args as unknown[])[0])).toBe(JSON.stringify(AREA));
    expect((out.cql?.args as unknown[])[1]).toEqual({ op: "like", args: [p("name"), "%xy%"] });
  });

  it("a row on a field the layer no longer has is marked and survives an edit beside it", async () => {
    const gone = { op: "=", args: [p("gone"), "x"] };
    const { onApply } = setup({ op: "and", args: [gone, { op: "like", args: [p("name"), "%ab%"] }] });
    expect(within(rowEl("r0")).getByText("filter_panel.issue_unknown_field")).toBeDefined();
    await openRow("r1");
    await typeValue("xy");
    expect((written(lastApplied(onApply)).cql?.args as unknown[])[0]).toEqual(gone);
    // It can still be removed.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(rowEl("r0")).getByRole("button", { name: "style_editor.remove_condition" }));
    expect(lastApplied(onApply).rows.map((r) => r.id)).toEqual(["r1"]);
  });

  it("a switched-off row goes to the notes and comes back as it was", async () => {
    const kept = { op: ">", args: [p("traffic"), 10] };
    const cql = { op: "and", args: [{ op: "like", args: [p("name"), "%ab%"] }, kept] };
    const { onApply } = setup(cql);
    const toggle = () => userEvent.click(within(rowEl("r1")).getByRole("checkbox"));
    await toggle();
    const off = written(lastApplied(onApply));
    expect(off.cql).toEqual({ op: "and", args: [cql.args[0]] });
    expect(off.ui).toEqual({ v: 1, off: [{ at: 1, cql: kept }] });
    await toggle();
    expect(written(lastApplied(onApply))).toEqual({ cql, ui: undefined });
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("without switches (a format with no notes) the rows have no switch and can still be removed", async () => {
    const cql = { op: "and", args: [AREA, { op: ">", args: [p("traffic"), 10] }] };
    const { onApply } = setup(cql, { canSwitch: false });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    await userEvent.click(within(rowEl("r0")).getByRole("button", { name: "style_editor.remove_condition" }));
    // The area stays: it is not one of the conditions.
    expect(lastApplied(onApply).rows).toEqual([]);
    expect(lastApplied(onApply).area?.pieces).toHaveLength(1);
    await userEvent.click(within(rowEl("area")).getByRole("button", { name: "filter_panel.area_remove" }));
    expect(lastApplied(onApply)).toEqual({ match: "all", rows: [] });
  });

  it("contains with % or _ saves nothing and says why", async () => {
    const { onApply } = setup({ op: "and", args: [{ op: "like", args: [p("name"), "%ab%"] }] });
    await openRow("r0");
    await typeValue("50%");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getAllByText("filter_panel.wildcard").length).toBeGreaterThan(0);
  });

  it("match all or any shows from two rows and writes the top level", async () => {
    const { onApply } = setup({
      op: "and",
      args: [
        { op: "like", args: [p("name"), "%ab%"] },
        { op: ">", args: [p("traffic"), 10] },
      ],
    });
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.match_all" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("filter_panel.match_any"));
    expect(written(lastApplied(onApply)).cql?.op).toBe("or");
    expect(screen.getByRole("button", { name: "filter_panel.match_any" })).toBeDefined();
  });

  it("one row has no match to choose", () => {
    setup({ op: "and", args: [{ op: ">", args: [p("traffic"), 10] }] });
    expect(screen.queryByRole("button", { name: "filter_panel.match_all" })).toBeNull();
  });

  it("counts the features the filter keeps, of all the dataset holds", () => {
    const cql = { op: "and", args: [{ op: ">", args: [p("traffic"), 10] }] };
    setup(cql);
    expect(screen.getByText("filter_panel.result_of")).toBeDefined();
    expect(counted).toHaveBeenCalledWith("dataset-1", JSON.stringify(cql));
  });

  it("without a condition that applies it counts all features and asks for no filtered count", async () => {
    setup(undefined);
    expect(screen.getByText("filter_panel.result_all")).toBeDefined();
    // An unfinished row filters nothing.
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("name"));
    expect(screen.getByText("filter_panel.result_all")).toBeDefined();
    expect(counted.mock.calls.every(([, filter]) => filter === undefined)).toBe(true);
  });

  it("the editor's header names the field and changes it", async () => {
    const { onApply } = setup({ op: "and", args: [{ op: ">", args: [p("traffic"), 10] }] });
    await openRow("r0");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.condition_field: traffic" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("name"));
    expect(screen.getByRole("button", { name: "style_editor.condition_field: name" })).toBeDefined();
    // The value of a number does not fit a text: the row waits for a new one and saves nothing of itself.
    expect(lastApplied(onApply).rows[0]).toEqual(
      expect.objectContaining({ field: "name", value: undefined })
    );
  });

  it("Delete on a row removes it", async () => {
    const { onApply } = setup({
      op: "and",
      args: [
        { op: "like", args: [p("name"), "%ab%"] },
        { op: ">", args: [p("traffic"), 10] },
      ],
    });
    within(rowEl("r0")).getAllByRole("button")[0].focus();
    await userEvent.keyboard("{Delete}");
    expect(lastApplied(onApply).rows.map((r) => r.id)).toEqual(["r1"]);
  });

  it("clear removes every row and the area", async () => {
    const { onApply } = setup({ op: "and", args: [{ op: ">", args: [p("traffic"), 10] }, AREA] });
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.clear" }));
    expect(lastApplied(onApply)).toEqual({ match: "all", rows: [] });
  });

  it("clear is there for an area alone, and not for an empty filter", async () => {
    const { onApply, unmount } = setup(AREA);
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.clear" }));
    expect(lastApplied(onApply)).toEqual({ match: "all", rows: [] });
    unmount();
    setup(undefined);
    expect(screen.queryByRole("button", { name: "filter_panel.clear" })).toBeNull();
  });

  it("a dataset without fields says so and offers no condition to add", () => {
    setup(undefined, { fields: {} });
    expect(screen.getByText("filter_panel.no_fields")).toBeDefined();
    expect(screen.queryByText("filter_panel.empty")).toBeNull();
    expect(screen.queryByRole("button", { name: "style_editor.add_condition" })).toBeNull();
  });

  it("the remove button lies over the row's end, taking no room from what the row says", () => {
    setup({ op: ">", args: [p("traffic"), 10] });
    const remove = screen.getByRole("button", { name: "style_editor.remove_condition" });
    expect(getComputedStyle(remove).position).toBe("absolute");
  });

  it("names the limit and stops adding at 20 conditions", () => {
    const args = Array.from({ length: 20 }, (_, i) => ({ op: ">", args: [p("traffic"), i] }));
    setup({ op: "and", args });
    expect(screen.getByRole("button", { name: "style_editor.add_condition" }).hasAttribute("disabled")).toBe(
      true
    );
    expect(screen.getByText("filter_panel.limit_conditions")).toBeDefined();
  });

  it("keeps its draft when its own save comes back, and takes a change from outside", async () => {
    const onApply = vi.fn(async (_model: FilterModel) => undefined);
    // The caller's saved model, changed from the test as a save or another panel changes it.
    const show: { current: (model: FilterModel) => void } = { current: () => undefined };
    function Harness() {
      const [model, setModel] = useState<FilterModel>({ match: "all", rows: [] });
      show.current = setModel;
      return (
        <FilterPanel
          model={model}
          fields={FIELDS}
          issues={filterIssues(model, FIELDS)}
          canEdit
          onApply={onApply}
        />
      );
    }
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("traffic"));
    await userEvent.click(screen.getByRole("combobox", { name: "style_editor.condition_compare" }));
    // The editor of the new row lists the field's values too: the comparison's options are the menu's.
    await userEvent.click(screen.getByRole("option", { name: "filter_panel.op.is_greater_than" }));
    await typeValue("5{Enter}");
    const out = written(onApply.mock.calls.at(-1)?.[0] as FilterModel);
    // The saved filter read again: other ids, the same filter. The open editor keeps its row.
    act(() => show.current(readFilter(out.cql, out.ui, FIELDS)));
    expect(document.querySelector("[data-filter-row='n1']")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "style_editor.condition_value" })).toBeDefined();
    // Changed elsewhere: the panel shows the new filter.
    act(() =>
      show.current(readFilter({ op: "and", args: [{ op: "<", args: [p("traffic"), 3] }] }, undefined, FIELDS))
    );
    expect(document.querySelector("[data-filter-row='n1']")).toBeNull();
    expect(document.querySelector("[data-filter-row='r0']")).not.toBeNull();
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("puts the caller's action on the result under its count, after Clear", () => {
    const model = readFilter({ op: "and", args: [{ op: ">", args: [p("traffic"), 10] }] }, undefined, FIELDS);
    renderWithProviders(
      <FilterPanel
        model={model}
        fields={FIELDS}
        issues={filterIssues(model, FIELDS)}
        canEdit
        onApply={vi.fn()}
        resultAction={<button>Save it</button>}
      />
    );
    const action = screen.getByRole("button", { name: "Save it" });
    const clear = screen.getByRole("button", { name: "filter_panel.clear" });
    // In the result's block, below the row with the count and Clear.
    const result = clear.parentElement?.parentElement as HTMLElement;
    expect(result).toContainElement(action);
    expect(clear.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the server's refusal at the top", async () => {
    const model = readFilter({ op: "and", args: [{ op: ">", args: [p("traffic"), 10] }] }, undefined, FIELDS);
    const { FilterSaveError } = await import("@/hooks/map/useLayerFilter");
    const onApply = vi.fn(async () => {
      throw new FilterSaveError(["Invalid CQL query: no"]);
    });
    renderWithProviders(
      <FilterPanel
        model={model}
        fields={FIELDS}
        issues={filterIssues(model, FIELDS)}
        canEdit
        onApply={onApply}
      />
    );
    await act(() => userEvent.click(within(rowEl("r0")).getByRole("checkbox")));
    expect(await screen.findByText("Invalid CQL query: no")).toBeDefined();
  });
});
