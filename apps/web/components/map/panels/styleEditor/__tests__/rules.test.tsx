import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RulesSection } from "@/components/map/panels/styleEditor/sections/RulesSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, pickColor, renderPanel } from "./renderPanel";

// The layer's values of a field with how many features hold each; one answer per request, as SWR keeps it.
const uniqueValues = vi.hoisted(() => {
  const answers = new Map<string, unknown>();
  return vi.fn((layerId: string, field: string, params?: { page?: number }) => {
    const key = `${layerId}|${field}|${params?.page ?? 1}`;
    if (layerId && field && !answers.has(key))
      answers.set(key, {
        items: [
          { value: "Gymnasium", count: 12 },
          { value: "Realschule", count: 5 },
        ],
        total: 2,
        page: params?.page ?? 1,
      });
    return { data: answers.get(key), isLoading: false };
  });
});
vi.mock("@/lib/api/layers", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLayerUniqueValues: uniqueValues,
}));
// The whole dataset's traffic, 0 to 100 in ten bins.
const histogram = vi.hoisted(() => {
  const stats = {
    bins: Array.from({ length: 10 }, (_, i) => ({ range: [i * 10, i * 10 + 10], count: i + 1 })),
    missing_count: 0,
    total_rows: 55,
  };
  return vi.fn((layerId?: string, _params?: object) => ({
    histogramStats: layerId ? stats : undefined,
    isLoading: false,
  }));
});
vi.mock("@/lib/api/projects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjectLayerHistogramStats: histogram,
}));

const FIELDS = [
  { name: "traffic", type: "number" as const, label: "traffic" },
  { name: "name", type: "string" as const, label: "name" },
  { name: "built", type: "date" as const, label: "built" },
];
const QUIET = { id: "r1", name: "Quiet", when: { op: "<", args: [{ property: "traffic" }, 1500] } };
const UNNAMED = { id: "r2", name: "Unnamed", when: { op: "isNull", args: [{ property: "name" }] } };

/** `layerId` is the dataset the value lists and the histogram read; a part's editor asks the server for that
 * dataset's own style (Reset to dataset), so the tests that open one go without. */
function setup(rules: object[] = [], geometry: "line" | "point" = "line", layerId = "dataset-1") {
  return renderPanel(
    <PopoverProvider>
      <SymbolSection />
      <RulesSection />
    </PopoverProvider>,
    {
      document: {
        version: "1.0.0",
        kind: "vector",
        symbol:
          geometry === "line" ? { line: { color: "#2166ac", width: 3 } } : { marker: { color: "#1a6b4d" } },
        ...(rules.length ? { rules } : {}),
      } as LayerStyle,
      data: {
        layerId,
        geometry,
        fields: FIELDS,
        fieldTypes: Object.fromEntries(FIELDS.map((f) => [f.name, f.type])),
      },
    }
  );
}

const openRule = (name: string) =>
  userEvent.click(
    within(screen.getByText(name).closest("[data-rule-row]") as HTMLElement).getAllByRole("button")[0]
  );

/** The rule's conditions, each a row as the filter panel's are. */
const conditionRows = () => [...document.querySelectorAll<HTMLElement>("[data-filter-row]")];
const openCondition = (i: number) => userEvent.click(within(conditionRows()[i]).getAllByRole("button")[0]);
/** "Add a condition": the field first (the field picker), then its editor opens. */
async function addCondition(field: string) {
  await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
  const picker = screen
    .getAllByRole("listbox")
    .find((list) => list.getAttribute("aria-label") !== "style_editor.condition_value") as HTMLElement;
  await userEvent.click(within(picker).getByText(field));
}
async function pickOp(op: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "style_editor.condition_compare" }));
  await userEvent.click(screen.getByRole("option", { name: `filter_panel.op.${op}` }));
}
/** Types into the condition editor's value box and leaves it. */
async function typeValue(text: string, name = "style_editor.condition_value") {
  const box = screen.getByRole("textbox", { name });
  await userEvent.clear(box);
  await userEvent.type(box, text);
  fireEvent.blur(box);
}
const valueList = () => screen.getByRole("listbox", { name: "style_editor.condition_value" });
const confirmButton = () => screen.getByRole("button", { name: "style_editor.add_rule_confirm" });

describe("rules", () => {
  beforeEach(() => {
    uniqueValues.mockClear();
    histogram.mockClear();
  });

  it("a rule's condition is a row with its sentence that opens its editor one level further", async () => {
    setup([QUIET]);
    await openRule("Quiet");
    const rows = conditionRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByTitle("traffic filter_panel.op.is_less_than 1500")).toBeDefined();
    await openCondition(0);
    // Beside the rule's popover, headed by its field, the comparison as the filter's editor has it.
    const editor = document.querySelector("[data-popover-level='2']") as HTMLElement;
    expect(
      within(editor).getByRole("button", { name: "style_editor.condition_field: traffic" })
    ).toBeDefined();
    expect(within(editor).getByRole("combobox", { name: "style_editor.condition_compare" }).textContent).toBe(
      "filter_panel.op.is_less_than"
    );
  });

  it("an edit in the condition's editor writes the rule in the style's spelling", async () => {
    const { store } = setup([QUIET]);
    await openRule("Quiet");
    await openCondition(0);
    await typeValue("2000");
    expect(store.get("rules.0.when")).toEqual({ op: "<", args: [{ property: "traffic" }, 2000] });
    expect(within(conditionRows()[0]).getByTitle("traffic filter_panel.op.is_less_than 2000")).toBeDefined();
  });

  it("a text field's values are picked from the layer's list, with their counts", async () => {
    const notA = { id: "r5", name: "Not A", when: { op: "<>", args: [{ property: "name" }, "a"] } };
    const { store } = setup([notA]);
    await openRule("Not A");
    expect(uniqueValues).not.toHaveBeenCalled();
    await openCondition(0);
    expect(uniqueValues).toHaveBeenCalledWith("dataset-1", "name", expect.objectContaining({ page: 1 }));
    expect(within(valueList()).getByText("12")).toBeDefined();
    await userEvent.click(within(valueList()).getByText("Gymnasium"));
    // "is not" in the style's spelling: a bare `<>`, not the filter's alternative of an empty value.
    expect(store.get("rules.0.when")).toEqual({ op: "<>", args: [{ property: "name" }, "Gymnasium"] });
  });

  it("a number comparison has the slider over the layer's histogram", async () => {
    const { store } = setup([QUIET]);
    await openRule("Quiet");
    await openCondition(0);
    expect(histogram).toHaveBeenCalledWith("dataset-1", expect.objectContaining({ column_name: "traffic" }));
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.condition_value" }), {
      target: { value: 70 },
    });
    expect(store.get("rules.0.when")).toEqual({ op: "<", args: [{ property: "traffic" }, 70] });
  });

  it("a date condition offers no relative dates: a style does not change with the day", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    await addCondition("built");
    const compare = screen.getByRole("combobox", { name: "style_editor.condition_compare" });
    expect(compare.textContent).toBe("filter_panel.op.is");
    await userEvent.click(compare);
    const offered = screen.getAllByRole("option").map((option) => option.textContent);
    expect(offered).toContain("filter_panel.op.is_before");
    expect(offered).not.toContain("filter_panel.op.in_the_last");
    expect(offered).not.toContain("filter_panel.op.is_on");
  });

  it("a new rule is written once its condition is complete", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    expect(conditionRows()).toHaveLength(0);
    await addCondition("traffic");
    expect(conditionRows()).toHaveLength(1);
    await pickOp("is_less_than");
    // Not complete yet: the row says so, and the rule waits.
    expect(within(conditionRows()[0]).getByText("filter_panel.unfinished")).toBeDefined();
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    await typeValue("1500");
    expect(store.get("rules")).toBeUndefined();
    expect(confirmButton().hasAttribute("disabled")).toBe(false);
    await userEvent.click(confirmButton());
    expect(store.get("rules.0.when")).toEqual({ op: "<", args: [{ property: "traffic" }, 1500] });
    expect(typeof store.get("rules.0.id")).toBe("string");
    // The rule's editor takes the new rule's place, its condition a row.
    expect(screen.getByText("style_editor.rule")).toBeDefined();
    expect(within(conditionRows()[0]).getByTitle("traffic filter_panel.op.is_less_than 1500")).toBeDefined();
  });

  it("a second condition brings the all or any choice and a remove button per condition", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    await addCondition("traffic");
    await pickOp("is_greater_than");
    await typeValue("10");
    // One condition: "When", no all or any, nothing to remove (a rule keeps one).
    expect(screen.getByText("style_editor.when")).toBeDefined();
    expect(screen.queryByRole("button", { name: "filter_panel.match_all" })).toBeNull();
    expect(
      within(conditionRows()[0]).queryByRole("button", { name: "style_editor.remove_condition" })
    ).toBeNull();
    await addCondition("name");
    await pickOp("is_blank");
    expect(conditionRows()).toHaveLength(2);
    for (const row of conditionRows())
      expect(within(row).getByRole("button", { name: "style_editor.remove_condition" })).toBeDefined();
    // The filter panel's match menu, beside "When".
    expect(screen.getByText("style_editor.when")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "filter_panel.match_all" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("filter_panel.match_any"));
    expect(screen.getByRole("button", { name: "filter_panel.match_any" })).toBeDefined();
    await userEvent.click(confirmButton());
    expect(store.get("rules.0.when")).toEqual({
      op: "or",
      args: [
        { op: ">", args: [{ property: "traffic" }, 10] },
        { op: "isNull", args: [{ property: "name" }] },
      ],
    });
  });

  it("Cancel closes the new rule and its condition's editor without writing it", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    await addCondition("traffic");
    await pickOp("is_less_than");
    await typeValue("5");
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByText("style_editor.new_rule")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "style_editor.condition_compare" })).toBeNull();
    expect(store.get("rules")).toBeUndefined();
  });

  it("removing a condition leaves the others and writes the rule without it", async () => {
    const both = { id: "r4", name: "Both", when: { op: "and", args: [QUIET.when, UNNAMED.when] } };
    const { store } = setup([both]);
    await openRule("Both");
    expect(conditionRows()).toHaveLength(2);
    await userEvent.click(
      within(conditionRows()[1]).getByRole("button", { name: "style_editor.remove_condition" })
    );
    expect(conditionRows()).toHaveLength(1);
    expect(within(conditionRows()[0]).getByTitle("traffic filter_panel.op.is_less_than 1500")).toBeDefined();
    expect(store.get("rules.0.when")).toEqual(QUIET.when);
  });

  it("a condition being written stays out of the rule until it is complete", async () => {
    const { store } = setup([QUIET]);
    await openRule("Quiet");
    await addCondition("name");
    expect(conditionRows()).toHaveLength(2);
    expect(store.get("rules.0.when")).toEqual(QUIET.when);
    await userEvent.click(within(valueList()).getByText("Gymnasium"));
    expect(store.get("rules.0.when")).toEqual({
      op: "and",
      args: [QUIET.when, { op: "=", args: [{ property: "name" }, "Gymnasium"] }],
    });
  });

  it("an undo puts the rule's condition rows back as they were", async () => {
    const { store } = setup([QUIET]);
    await openRule("Quiet");
    await openCondition(0);
    await typeValue("2000");
    act(() => store.undo());
    expect(within(conditionRows()[0]).getByTitle("traffic filter_panel.op.is_less_than 1500")).toBeDefined();
  });

  it("a rule is a row of its own: its name in the field across the row, what it changes under it", async () => {
    setup([{ ...QUIET, visible: false }]);
    const row = screen.getByText("Quiet").closest("[data-rule-row]") as HTMLElement;
    // No label column: the name is the field's value, not squeezed beside it.
    const field = within(row).getAllByRole("button")[0];
    expect(field.textContent).toBe("Quiet");
    expect(within(row).getByText("style_editor.effect_hidden")).toBeDefined();
    await userEvent.click(field);
    expect(screen.getByText("style_editor.rule")).toBeDefined();
    expect(field.getAttribute("aria-expanded")).toBe("true");
  });

  it("Visible off hides the matching features; moving a rule up changes its place", async () => {
    const { store } = setup([QUIET, UNNAMED]);
    await openRule("Quiet");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.rule_visible" }));
    expect(store.get("rules.0.visible")).toBe(false);
    // Both moves on each row, the ends disabled: the rules' fields end at one place.
    const first = screen.getByText("Quiet").closest("[data-rule-row]") as HTMLElement;
    expect(
      (within(first).getByRole("button", { name: "style_editor.move_rule_up" }) as HTMLButtonElement).disabled
    ).toBe(true);
    await userEvent.click(
      within(screen.getByText("Unnamed").closest("[data-rule-row]") as HTMLElement).getByRole("button", {
        name: "style_editor.move_rule_up",
      })
    );
    expect((store.get("rules") as Array<{ id: string }>).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("Style the matching features makes the symbol rows edit the rule", async () => {
    const { store } = setup([QUIET], "line", "");
    await openRule("Quiet");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.style_matching" }));
    expect(store.scope).toEqual({ rule: "r1", index: 0 });
    await openGroup("style_editor.part_line");
    await pickColor(
      screen.getAllByText("style_editor.color").at(-1)!.parentElement as HTMLElement,
      "#9aa3ad"
    );
    expect(store.get("rules.0.line.color")).toBe("#9aa3ad");
    expect(store.get("symbol.line.color")).toBe("#2166ac");
  });

  it("a condition the rows cannot show is text; Edit as CQL2 writes valid JSON only", async () => {
    const nested = {
      id: "r3",
      name: "Deep",
      when: {
        op: "and",
        args: [
          {
            op: "or",
            args: [
              { op: "=", args: [{ property: "name" }, "a"] },
              { op: "isNull", args: [{ property: "name" }] },
            ],
          },
          { op: "<", args: [{ property: "traffic" }, 5] },
        ],
      },
    };
    const { store } = setup([nested]);
    await openRule("Deep");
    expect(conditionRows()).toHaveLength(0);
    expect(screen.getByText("style_editor.condition_custom")).toBeDefined();
    const editor = screen.getByRole("textbox", { name: "style_editor.edit_cql" });
    fireEvent.change(editor, { target: { value: "{ not json" } });
    expect(store.get("rules.0.when")).toEqual(nested.when);
    const simpler = { op: "isNull", args: [{ property: "name" }] };
    fireEvent.change(editor, { target: { value: JSON.stringify(simpler) } });
    expect(store.get("rules.0.when")).toEqual(simpler);
    // Rows can show it now.
    expect(within(conditionRows()[0]).getByTitle("name filter_panel.op.is_blank")).toBeDefined();
    await act(async () => {});
  });

  it("a rule without an id (spec 6 example, an AI write) can be edited, styled and removed", async () => {
    const gymnasium = { name: "Gymnasium", when: { op: "=", args: [{ property: "name" }, "Gymnasium"] } };
    const { store } = setup([gymnasium, { ...QUIET, id: undefined }]);
    expect((store.get("rules") as Array<{ id: string }>).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(store.canUndo).toBe(false);
    await openRule("Gymnasium");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.rule_visible" }));
    expect(store.get("rules.0.visible")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "style_editor.style_matching" }));
    expect(store.scope).toEqual({ rule: "r1", index: 0 });
    await openRule("Quiet");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.remove_rule" }));
    expect((store.get("rules") as Array<{ name: string }>).map((r) => r.name)).toEqual(["Gymnasium"]);
  });

  it("per-layer keys have no row in rule scope", async () => {
    const { store } = setup([{ ...QUIET }], "point", "");
    act(() => store.setScope({ rule: "r1", index: 0 }));
    await openGroup("style_editor.part_fill");
    expect(screen.queryByText("style_editor.shape")).toBeNull();
  });
});
