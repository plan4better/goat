import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FilterIssue } from "@/lib/filter/issues";
import type { FilterCondition } from "@/lib/filter/model";
import type { FieldType } from "@/lib/style/compile/types";

import { CommitInput, ConditionFields } from "@/components/map/panels/filter/ConditionFields";

import { renderWithProviders } from "../../styleEditor/__tests__/renderPanel";

// Two values of the field, one answer per request as SWR keeps it.
const { useLayerUniqueValues } = vi.hoisted(() => {
  const answer = {
    items: [
      { value: "open", count: 3 },
      { value: "closed", count: 2 },
    ],
    total: 2,
    page: 1,
  };
  return {
    useLayerUniqueValues: vi.fn((layerId: string, _field: string, _params?: object) => ({
      data: layerId ? answer : undefined,
      isLoading: false,
    })),
  };
});
vi.mock("@/lib/api/layers", () => ({ useLayerUniqueValues }));
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<object>()),
  useProjectLayerHistogramStats: () => ({ histogramStats: undefined, isLoading: false }),
}));

function show(
  row: FilterCondition,
  type: FieldType | undefined,
  props: Partial<Parameters<typeof ConditionFields>[0]> = {}
) {
  const onChange = vi.fn();
  const view = renderWithProviders(
    <ConditionFields row={row} type={type} issues={[]} onChange={onChange} {...props} />
  );
  return { ...view, onChange };
}

const compare = () => screen.getByRole("combobox", { name: "style_editor.condition_compare" });
/** The comparison's menu: a listbox, as the value list is. */
const menu = () =>
  screen
    .getAllByRole("listbox")
    .find((l) => l.getAttribute("aria-label") !== "style_editor.condition_value")!;
const options = async () => {
  await userEvent.click(compare());
  return within(menu())
    .getAllByRole("option")
    .map((o) => o.textContent);
};
const valueBox = () => screen.getByRole("textbox", { name: "style_editor.condition_value" });

describe("the condition's fields", () => {
  it("work without the filter panel: a typed value comes back as a patch", async () => {
    const { onChange } = show({ field: "traffic", op: "is_at_least" }, "number");
    expect(compare().textContent).toBe("filter_panel.op.is_at_least");
    await userEvent.type(valueBox(), "5");
    fireEvent.blur(valueBox());
    expect(onChange).toHaveBeenLastCalledWith({ value: 5 });
  });

  it("offer the field's comparisons, and a comparison with another box drops the value", async () => {
    const { onChange } = show({ field: "name", op: "contains_the_text", value: "ab" }, "string");
    expect(await options()).toContain("filter_panel.op.includes");
    await userEvent.click(within(menu()).getByText("filter_panel.op.is_blank"));
    expect(onChange).toHaveBeenLastCalledWith({ op: "is_blank", value: undefined, value2: undefined });
  });

  it("list the row's issues under the fields", () => {
    const issues: FilterIssue[] = [{ code: "field_type_mismatch", field: "traffic", type: "number" }];
    show({ field: "traffic", op: "is_at_least", value: "x" }, "number", { issues });
    expect(screen.getByText("filter_panel.issue_field_type_mismatch")).toBeInTheDocument();
  });

  it("name the number of days by the label shown beside it", async () => {
    const { onChange } = show({ field: "built", op: "in_the_last" }, "date");
    const days = screen.getByLabelText("filter_panel.days") as HTMLInputElement;
    expect(screen.getByText("filter_panel.days")).toBeInTheDocument();
    expect(screen.queryByLabelText("style_editor.condition_value")).toBeNull();
    await userEvent.type(days, "7");
    fireEvent.blur(days);
    expect(onChange).toHaveBeenLastCalledWith({ value: 7 });
  });
});

/** The fields over a row they hold themselves, as the column popover holds its row. */
function Held({
  initial,
  type,
  onRow,
  ...props
}: {
  initial: FilterCondition;
  type: FieldType | undefined;
  onRow: (row: FilterCondition) => void;
} & Partial<Parameters<typeof ConditionFields>[0]>) {
  const [row, setRow] = useState(initial);
  return (
    <ConditionFields
      row={row}
      type={type}
      issues={[]}
      layerId="dataset-1"
      onChange={(patch) =>
        setRow((current) => {
          const next = { ...current, ...patch };
          onRow(next);
          return next;
        })
      }
      {...props}
    />
  );
}

const valueOption = (label: string) =>
  within(screen.getByRole("listbox", { name: "style_editor.condition_value" }))
    .getByText(label)
    .closest("[role='option']") as HTMLElement;

describe("the condition's fields for a column", () => {
  it("offer only the comparisons they are given", async () => {
    show({ field: "name", op: "is" }, "string", { ops: ["is", "is_not", "is_blank"] });
    expect(await options()).toEqual([
      "filter_panel.op.is",
      "filter_panel.op.is_not",
      "filter_panel.op.is_blank",
    ]);
  });

  it("pick several values for is: two make includes, one is again", async () => {
    const onRow = vi.fn();
    renderWithProviders(
      <Held
        initial={{ field: "name", op: "is" }}
        type="string"
        onRow={onRow}
        pickSeveral
        ops={["is", "is_not"]}
      />
    );
    await userEvent.click(valueOption("open"));
    expect(onRow).toHaveBeenLastCalledWith({ field: "name", op: "is", value: "open" });
    await userEvent.click(valueOption("closed"));
    expect(onRow).toHaveBeenLastCalledWith({ field: "name", op: "includes", value: ["open", "closed"] });
    // The comparison still reads is.
    expect(compare().textContent).toBe("filter_panel.op.is");
    await userEvent.click(valueOption("open"));
    expect(onRow).toHaveBeenLastCalledWith({ field: "name", op: "is", value: "closed" });
  });

  it("keep several values when is turns into is not", async () => {
    const onRow = vi.fn();
    renderWithProviders(
      <Held
        initial={{ field: "name", op: "includes", value: ["open", "closed"] }}
        type="string"
        onRow={onRow}
        pickSeveral
        ops={["is", "is_not"]}
      />
    );
    await userEvent.click(compare());
    await userEvent.click(within(menu()).getByText("filter_panel.op.is_not"));
    expect(onRow).toHaveBeenLastCalledWith({ field: "name", op: "excludes", value: ["open", "closed"] });
  });

  it("scope the value list's counts by the filter they are given", () => {
    const filter = { op: "=", args: [{ property: "kind" }, "school"] };
    show({ field: "name", op: "is" }, "string", { layerId: "dataset-1", filter });
    const params = useLayerUniqueValues.mock.calls.at(-1)?.[2] as { query?: string };
    expect(params.query).toBe(JSON.stringify(filter));
  });

  it("count every key at once when live, and Enter says so", async () => {
    const onEnter = vi.fn();
    const { onChange } = show({ field: "name", op: "contains_the_text" }, "string", { live: true, onEnter });
    await userEvent.type(valueBox(), "ab");
    expect(onChange.mock.calls).toEqual([[{ value: "a" }], [{ value: "ab" }]]);
    await userEvent.type(valueBox(), "{Enter}");
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("take a text with a wildcard when live, and say once why it saves nothing", async () => {
    const onRow = vi.fn();
    renderWithProviders(
      <Held initial={{ field: "name", op: "contains_the_text" }} type="string" onRow={onRow} live />
    );
    await userEvent.type(valueBox(), "a%");
    expect(onRow).toHaveBeenLastCalledWith({ field: "name", op: "contains_the_text", value: "a%" });
    expect(screen.getAllByText("filter_panel.wildcard")).toHaveLength(1);
  });
});

describe("a typed value's box", () => {
  function box(props: Partial<Parameters<typeof CommitInput>[0]> = {}) {
    const onCommit = vi.fn();
    function Hold() {
      const [value, setValue] = useState<unknown>(undefined);
      return (
        <>
          <CommitInput
            value={value}
            kind="days"
            ariaLabel="days"
            {...props}
            onCommit={(next) => {
              onCommit(next);
              setValue(next);
            }}
          />
          {/* Another control setting the value, as the slider does. */}
          <button type="button" onClick={() => setValue(7)}>
            elsewhere
          </button>
        </>
      );
    }
    renderWithProviders(<Hold />);
    return { onCommit, input: screen.getByRole("textbox", { name: "days" }) as HTMLInputElement };
  }

  it("counts after a pause, not per key", async () => {
    const { onCommit, input } = box();
    await userEvent.type(input, "12");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("when live keeps a text that is no value yet as typed", async () => {
    const { onCommit, input } = box({ live: true });
    await userEvent.type(input, "1.5");
    expect(onCommit.mock.calls).toEqual([[1], [1], [undefined]]);
    expect(input.value).toBe("1.5");
  });

  it("when live still shows a value changed elsewhere", async () => {
    const { input } = box({ live: true });
    await userEvent.type(input, "3");
    await userEvent.click(screen.getByText("elsewhere"));
    expect(input.value).toBe("7");
  });

  it("commits on Enter, then calls onEnter", async () => {
    const order: unknown[] = [];
    const onEnter = () => order.push("enter");
    const { onCommit, input } = box({ onEnter });
    onCommit.mockImplementation((value) => order.push(value));
    await userEvent.type(input, "7{Enter}");
    expect(order).toEqual([7, "enter"]);
  });

  describe("for a date and time", () => {
    // Berlin is an hour ahead of UTC in winter and two in summer.
    beforeAll(() => {
      vi.stubEnv("TZ", "Europe/Berlin");
    });
    afterAll(() => {
      vi.unstubAllEnvs();
    });

    function moment(value: unknown) {
      const onCommit = vi.fn();
      renderWithProviders(
        <CommitInput value={value} kind="datetime" ariaLabel="moment" onCommit={onCommit} />
      );
      return { onCommit, input: screen.getByLabelText("moment") as HTMLInputElement };
    }

    it("shows the stored instant in the browser's zone", () => {
      expect(moment("2026-11-16T09:00:00Z").input.value).toBe("2026-11-16T10:00");
    });

    it("stores the picked time as the instant it names in the browser's zone", () => {
      const { onCommit, input } = moment("2026-11-16T09:00:00Z");
      fireEvent.change(input, { target: { value: "2026-07-01T10:00" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenCalledWith("2026-07-01T08:00:00Z");
    });

    it("stores the browser's midnight as that instant", () => {
      const { onCommit, input } = moment(undefined);
      fireEvent.change(input, { target: { value: "2026-11-16T00:00" } });
      fireEvent.blur(input);
      expect(onCommit).toHaveBeenCalledWith("2026-11-15T23:00:00Z");
    });
  });
});
