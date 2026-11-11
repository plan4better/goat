import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { RulesSection } from "@/components/map/panels/styleEditor/sections/RulesSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, pickColor, renderPanel } from "./renderPanel";

const FIELDS = [
  { name: "traffic", type: "number" as const, label: "traffic" },
  { name: "name", type: "string" as const, label: "name" },
];
const QUIET = { id: "r1", name: "Quiet", when: { op: "<", args: [{ property: "traffic" }, 1500] } };
const UNNAMED = { id: "r2", name: "Unnamed", when: { op: "isNull", args: [{ property: "name" }] } };

function setup(rules: object[] = [], geometry: "line" | "point" = "line") {
  return renderPanel(
    <PopoverProvider>
      <SymbolSection />
      <RulesSection />
    </PopoverProvider>,
    {
      document: {
        version: 1,
        kind: "vector",
        symbol:
          geometry === "line" ? { line: { color: "#2166ac", width: 3 } } : { marker: { color: "#1a6b4d" } },
        ...(rules.length ? { rules } : {}),
      } as LayerStyle,
      data: {
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

describe("rules", () => {
  /** Picks `option` from the dropdown named `name` in condition `n` (from 1). */
  const pickIn = async (n: number, name: string, option: string) => {
    const groups = screen.getAllByRole("group", { name: "style_editor.condition_n" });
    await userEvent.click(within(groups[n - 1]).getByRole("combobox", { name }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText(option));
  };

  it("a new rule is written once its condition is complete", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    const add = screen.getByRole("button", { name: "style_editor.add_rule_confirm" });
    expect(add.hasAttribute("disabled")).toBe(true);
    // One condition on one line: the field, the comparison and the value.
    const [condition] = screen.getAllByRole("group", { name: "style_editor.condition_n" });
    expect(
      within(condition).getByRole("combobox", { name: "style_editor.condition_field" }).textContent
    ).toBe("style_editor.condition_field");
    await pickIn(1, "style_editor.condition_field", "traffic");
    await pickIn(1, "style_editor.condition_compare", "filter_expressions.is_less_than");
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(condition).getByRole("textbox", { name: "style_editor.condition_value" }), {
      target: { value: "1500" },
    });
    expect(store.get("rules")).toBeUndefined();
    expect(add.hasAttribute("disabled")).toBe(false);
    await userEvent.click(add);
    expect(store.get("rules.0.when")).toEqual({ op: "<", args: [{ property: "traffic" }, 1500] });
    expect(typeof store.get("rules.0.id")).toBe("string");
  });

  it("a second condition brings the all or any choice and a remove button per condition", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    // One condition: "When", no all or any.
    expect(screen.getByText("style_editor.when")).toBeDefined();
    expect(screen.queryByText("style_editor.match_lead")).toBeNull();
    expect(screen.queryByRole("button", { name: "style_editor.remove_condition" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    expect(screen.getAllByRole("group", { name: "style_editor.condition_n" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "style_editor.remove_condition" })).toHaveLength(2);
    await pickIn(1, "style_editor.condition_field", "traffic");
    await pickIn(1, "style_editor.condition_compare", "filter_expressions.is_greater_than");
    fireEvent.change(
      within(screen.getAllByRole("group", { name: "style_editor.condition_n" })[0]).getByRole("textbox"),
      { target: { value: "10" } }
    );
    await pickIn(2, "style_editor.condition_field", "name");
    await pickIn(2, "style_editor.condition_compare", "filter_expressions.is_blank");
    // A comparison without a value has no value box.
    expect(
      within(screen.getAllByRole("group", { name: "style_editor.condition_n" })[1]).queryByRole("textbox")
    ).toBeNull();
    // Two: "Match all of these", with a menu for all or any.
    expect(screen.queryByText("style_editor.when")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^style_editor.match_lead/ }));
    await userEvent.click(within(screen.getByRole("listbox")).getByText("style_editor.match_any"));
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule_confirm" }));
    expect(store.get("rules.0.when")).toEqual({
      op: "or",
      args: [
        { op: ">", args: [{ property: "traffic" }, 10] },
        { op: "isNull", args: [{ property: "name" }] },
      ],
    });
  });

  it("Cancel closes the new rule without writing it; the comparison shows its short label", async () => {
    const { store } = setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    await pickIn(1, "style_editor.condition_field", "traffic");
    await pickIn(1, "style_editor.condition_compare", "filter_expressions.is_less_than");
    expect(screen.getByRole("combobox", { name: "style_editor.condition_compare" }).textContent).toBe(
      "style_editor.op_short_is_less_than"
    );
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.queryByText("style_editor.new_rule")).toBeNull();
    expect(store.get("rules")).toBeUndefined();
  });

  it("removing a condition leaves the others", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_rule" }));
    await pickIn(1, "style_editor.condition_field", "traffic");
    await userEvent.click(screen.getByRole("button", { name: "style_editor.add_condition" }));
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.remove_condition" })[1]);
    const groups = screen.getAllByRole("group", { name: "style_editor.condition_n" });
    expect(groups).toHaveLength(1);
    expect(
      within(groups[0]).getByRole("combobox", { name: "style_editor.condition_field" }).textContent
    ).toContain("traffic");
  });

  it("Visible off hides the matching features; moving a rule up changes its place", async () => {
    const { store } = setup([QUIET, UNNAMED]);
    await openRule("Quiet");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.rule_visible" }));
    expect(store.get("rules.0.visible")).toBe(false);
    await userEvent.click(
      within(screen.getByText("Unnamed").closest("[data-rule-row]") as HTMLElement).getByRole("button", {
        name: "style_editor.move_rule_up",
      })
    );
    expect((store.get("rules") as Array<{ id: string }>).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("Style the matching features makes the symbol rows edit the rule", async () => {
    const { store } = setup([QUIET]);
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

  it("a condition the builder cannot show is text; Edit as CQL2 writes valid JSON only", async () => {
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
    const editor = screen.getByRole("textbox", { name: "style_editor.edit_cql" });
    fireEvent.change(editor, { target: { value: "{ not json" } });
    expect(store.get("rules.0.when")).toEqual(nested.when);
    const simpler = { op: "isNull", args: [{ property: "name" }] };
    fireEvent.change(editor, { target: { value: JSON.stringify(simpler) } });
    expect(store.get("rules.0.when")).toEqual(simpler);
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
    const { store } = setup([{ ...QUIET }], "point");
    act(() => store.setScope({ rule: "r1", index: 0 }));
    await openGroup("style_editor.part_fill");
    expect(screen.queryByText("style_editor.shape")).toBeNull();
  });
});
