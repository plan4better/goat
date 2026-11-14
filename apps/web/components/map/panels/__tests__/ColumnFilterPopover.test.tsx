import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Fields, FilterModel } from "@/lib/filter/model";

import type { TableFilterController } from "@/types/map/tableFilter";

import ColumnFilterPopover, { canFilterColumn } from "@/components/map/panels/ColumnFilterPopover";

import { renderWithProviders } from "../styleEditor/__tests__/renderPanel";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { error: toastError } }));

// The column's values with their counts, one answer per request as SWR keeps it.
const { useLayerUniqueValues } = vi.hoisted(() => {
  const answer = {
    items: [
      { value: "open", count: 3675 },
      { value: "closed", count: 296 },
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
// The whole dataset's lanes, 0 to 100 in ten bins.
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<object>()),
  useProjectLayerHistogramStats: () => ({
    histogramStats: {
      bins: Array.from({ length: 10 }, (_, i) => ({ range: [i * 10, i * 10 + 10], count: i + 1 })),
      missing_count: 0,
      total_rows: 55,
    },
    isLoading: false,
  }),
}));

const FIELDS: Fields = { status: "string", lanes: "integer", built: "date", lit: "boolean", kind: "string" };

const controllerWith = (
  rows: FilterModel["rows"] = [],
  opts: Partial<TableFilterController> = {}
): TableFilterController => ({
  model: { match: "all", rows },
  fields: FIELDS,
  upsert: vi.fn(),
  remove: vi.fn(),
  canEdit: true,
  ...opts,
});

const renderPopover = (controller: TableFilterController, columnName = "status") => {
  const anchor = document.createElement("th");
  document.body.appendChild(anchor);
  const onClose = vi.fn();
  renderWithProviders(
    <ColumnFilterPopover
      anchorEl={anchor}
      columnName={columnName}
      iconKind="string"
      layerId="layer-1"
      controller={controller}
      onClose={onClose}
    />
  );
  return { onClose };
};

const valueList = () => screen.getByRole("listbox", { name: "style_editor.condition_value" });
const valueRow = (label: string) =>
  within(valueList()).getByText(label).closest("[role='option']") as HTMLElement;
const button = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
const compare = () => screen.getByRole("combobox", { name: "style_editor.condition_compare" });
/** The comparison's menu: a listbox, as the value list is. */
const menu = () =>
  screen
    .getAllByRole("listbox")
    .find((l) => l.getAttribute("aria-label") !== "style_editor.condition_value")!;
const chooseOp = async (op: string) => {
  await userEvent.click(compare());
  await userEvent.click(within(menu()).getByText(`filter_panel.op.${op}`));
};
const valueBox = () =>
  screen.getByRole("textbox", { name: "style_editor.condition_value" }) as HTMLInputElement;
const lastQuery = () => (useLayerUniqueValues.mock.calls.at(-1)?.[2] as { query?: string }).query;

describe("ColumnFilterPopover", () => {
  it("shows the column, its comparison and the distinct values with counts", () => {
    renderPopover(controllerWith());

    expect(screen.getByText("status")).toBeInTheDocument();
    expect(compare().textContent).toBe("filter_panel.op.is");
    expect(valueRow("open").textContent).toContain("3,675");
    expect(valueRow("closed").textContent).toContain("296");
  });

  it("keeps Done disabled until something is chosen", async () => {
    renderPopover(controllerWith());
    expect(button("done").disabled).toBe(true);

    await userEvent.click(valueRow("open"));
    expect(button("done").disabled).toBe(false);
  });

  it("saves a single choice as is", async () => {
    const controller = controllerWith();
    renderPopover(controller);

    await userEvent.click(valueRow("open"));
    await userEvent.click(button("done"));
    expect(controller.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ field: "status", op: "is", value: "open", enabled: true })
    );
  });

  it("saves is with two values as includes", async () => {
    const controller = controllerWith();
    renderPopover(controller);

    await userEvent.click(valueRow("open"));
    await userEvent.click(valueRow("closed"));
    await userEvent.click(button("done"));
    expect(controller.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ op: "includes", value: ["open", "closed"] })
    );
  });

  it("ignores a second Done: applying closes the popover", async () => {
    const controller = controllerWith();
    const { onClose } = renderPopover(controller);

    await userEvent.click(valueRow("open"));
    fireEvent.click(button("done"));
    fireEvent.click(button("done"));
    expect(controller.upsert).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("reopens on the column's existing filter and can remove it", async () => {
    const controller = controllerWith([
      { id: "r0", field: "status", op: "includes", value: ["open", "closed"], enabled: true },
    ]);
    renderPopover(controller);

    // Both values arrive picked, under the is they came from.
    expect(compare().textContent).toBe("filter_panel.op.is");
    expect(valueRow("open").getAttribute("aria-selected")).toBe("true");
    expect(valueRow("closed").getAttribute("aria-selected")).toBe("true");

    await userEvent.click(button("remove"));
    expect(controller.remove).toHaveBeenCalledWith("r0");
  });

  it("replaces the existing row instead of adding a second", async () => {
    const controller = controllerWith([
      { id: "r0", field: "status", op: "is", value: "open", enabled: true },
    ]);
    renderPopover(controller);

    await userEvent.click(valueRow("closed"));
    await userEvent.click(button("done"));
    expect(controller.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r0", op: "includes", value: ["open", "closed"] })
    );
  });

  it("offers no Remove when the column has no filter yet", () => {
    renderPopover(controllerWith());
    expect(screen.queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
  });

  it("offers the column's comparisons: is and is not take several values, so includes and excludes are not listed", async () => {
    renderPopover(controllerWith());
    await userEvent.click(compare());
    const offered = within(menu())
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(offered).toContain("filter_panel.op.is_not");
    expect(offered).toContain("filter_panel.op.contains_the_text");
    expect(offered).toContain("filter_panel.op.is_blank");
    expect(offered).not.toContain("filter_panel.op.includes");
    expect(offered).not.toContain("filter_panel.op.excludes");
  });

  it("moves the focus into the comparison's menu", async () => {
    renderPopover(controllerWith());
    await userEvent.click(compare());
    await waitFor(() => expect(menu().contains(document.activeElement)).toBe(true));
  });

  it("takes a typed text at once, and Enter saves it", async () => {
    const controller = controllerWith();
    renderPopover(controller);
    await chooseOp("contains_the_text");

    await userEvent.type(valueBox(), "school");
    expect(button("done").disabled).toBe(false);
    await userEvent.type(valueBox(), "{Enter}");
    expect(controller.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ op: "contains_the_text", value: "school" })
    );
  });

  it("keeps Done disabled for a text with a wildcard, and says why", async () => {
    renderPopover(controllerWith());
    await chooseOp("contains_the_text");

    await userEvent.type(valueBox(), "a%");
    expect(button("done").disabled).toBe(true);
    expect(screen.getByText("filter_panel.wildcard")).toBeInTheDocument();
  });

  it("keeps Done disabled for a number of days that is not one", async () => {
    renderPopover(controllerWith(), "built");
    await chooseOp("in_the_last");

    const days = screen.getByRole("textbox", { name: "style_editor.condition_value" });
    await userEvent.type(days, "0");
    expect(button("done").disabled).toBe(true);
    await userEvent.clear(days);
    await userEvent.type(days, "7");
    expect(button("done").disabled).toBe(false);
  });

  it("needs no value for a comparison that takes none", async () => {
    renderPopover(controllerWith());
    await chooseOp("is_blank");
    expect(screen.queryByRole("listbox", { name: "style_editor.condition_value" })).not.toBeInTheDocument();
    expect(button("done").disabled).toBe(false);
  });

  it("gives a date column the date comparisons, and reopens a day it saved", async () => {
    const controller = controllerWith([
      { id: "r0", field: "built", op: "is_on", value: "2024-03-01", enabled: true },
    ]);
    renderPopover(controller, "built");

    expect(compare().textContent).toBe("filter_panel.op.is_on");
    // The browser's own date field.
    const day = screen.getByLabelText("style_editor.condition_value") as HTMLInputElement;
    expect(day.type).toBe("date");
    expect(day.value).toBe("2024-03-01");
    await userEvent.click(compare());
    const offered = within(menu())
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(offered).toContain("filter_panel.op.is_before");
    expect(offered).not.toContain("filter_panel.op.contains_the_text");
  });

  it("shows the histogram slider for a comparison of numbers", async () => {
    renderPopover(controllerWith(), "lanes");
    await chooseOp("is_at_least");
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("counts the values under the table's other filters, never this column's own", () => {
    const controller = controllerWith([
      { id: "r0", field: "status", op: "is", value: "open", enabled: true },
      { id: "r1", field: "kind", op: "is", value: "school", enabled: true },
    ]);
    renderPopover(controller);
    expect(JSON.parse(lastQuery() ?? "")).toEqual({
      op: "and",
      args: [{ op: "=", args: [{ property: "kind" }, "school"] }],
    });
  });

  it("says so when the column carries filters it does not own: one switched off, one with a comparison the column has not", () => {
    const controller = controllerWith([
      { id: "r0", field: "status", op: "is", value: "open", enabled: false },
      { id: "r1", field: "status", op: "is_on", value: "2024-01-01", enabled: true },
      { id: "r2", cql: { op: "s_intersects", args: [] }, enabled: true },
    ]);
    renderPopover(controller);
    expect(screen.getByText("column_has_other_filters")).toBeInTheDocument();
    // Neither is edited here: there is nothing to remove.
    expect(screen.queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
  });

  it("offers no editing to someone who may not change the filter", () => {
    const controller = controllerWith(
      [{ id: "r0", field: "status", op: "is", value: "open", enabled: true }],
      { canEdit: false }
    );
    renderPopover(controller);
    expect(
      screen.queryByRole("combobox", { name: "style_editor.condition_compare" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "done" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
    expect(screen.getByText("status filter_panel.op.is open")).toBeInTheDocument();
  });

  it("shows the server's refusal of a save", async () => {
    const controller = controllerWith();
    vi.mocked(controller.upsert).mockRejectedValue(
      Object.assign(new Error("Failed"), { messages: ["Invalid CQL query: too many conditions"] })
    );
    renderPopover(controller);
    await userEvent.click(valueRow("open"));
    await userEvent.click(button("done"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Invalid CQL query: too many conditions"));
  });

  it("claims a fixed height for a value list, so loading values cannot shift it", () => {
    renderPopover(controllerWith());
    const paper = document.querySelector(".MuiPopover-paper") as HTMLElement;
    // Without this, the paper grows when the values arrive; an upward-opening
    // popover is bottom-anchored, so growing moves its top edge.
    expect(getComputedStyle(paper).height).not.toBe("");
    expect(getComputedStyle(paper).height).not.toBe("auto");
  });

  it("lets a short editor size itself", async () => {
    renderPopover(controllerWith());
    await chooseOp("contains_the_text");
    const paper = document.querySelector(".MuiPopover-paper") as HTMLElement;
    expect(["", "auto"]).toContain(getComputedStyle(paper).height);
  });
});

describe("canFilterColumn", () => {
  it("offers a column's filter to an editor, on a field the filter knows", () => {
    expect(canFilterColumn(controllerWith(), "status")).toBe(true);
    // A viewer gets no "Add filter" (the save would be refused).
    expect(canFilterColumn(controllerWith([], { canEdit: false }), "status")).toBe(false);
    // A column the filter has no type for could never be saved.
    expect(canFilterColumn(controllerWith(), "h3_8")).toBe(false);
  });
});
