import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ValuePicker } from "@/components/map/panels/filter/ValuePicker";

import { renderWithProviders } from "../../styleEditor/__tests__/renderPanel";

// One answer per request, as SWR keeps it: a new object on every render would be a new answer each time.
const { useLayerUniqueValues } = vi.hoisted(() => {
  const answers = new Map<string, unknown>();
  const answer = (page: number) => ({
    // Three values and the features without one (the service sends null as "").
    items: [
      ...Array.from({ length: 3 }, (_, i) => ({ value: `v${page}-${i}`, count: 10 - i })),
      { value: "", count: 1 },
    ],
    total: 4,
    page,
  });
  return {
    useLayerUniqueValues: vi.fn(
      (layerId: string, _field: string, params: { page: number; query?: string }) => {
        const key = `${layerId}|${params.page}|${params.query ?? ""}`;
        if (layerId && !answers.has(key)) answers.set(key, answer(params.page));
        return { data: layerId ? answers.get(key) : undefined, isLoading: false };
      }
    ),
  };
});
vi.mock("@/lib/api/layers", () => ({ useLayerUniqueValues }));

const lastParams = () =>
  useLayerUniqueValues.mock.calls.at(-1)?.[2] as { page: number; size: number; query?: string };

function show(props: Partial<Parameters<typeof ValuePicker>[0]> = {}) {
  const onChange = vi.fn();
  const view = renderWithProviders(
    <ValuePicker
      layerId="dataset-1"
      field="name"
      type="string"
      multiple
      value={undefined}
      ariaLabel="style_editor.condition_value"
      onChange={onChange}
      {...props}
    />
  );
  return { ...view, onChange };
}

const list = () => screen.getByRole("listbox", { name: "style_editor.condition_value" });
const option = (label: string) => within(list()).getByText(label).closest("[role='option']") as HTMLElement;
const search = () => screen.getByRole("textbox", { name: "filter_panel.search_values" });

describe("the value list", () => {
  beforeEach(() => {
    useLayerUniqueValues.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("lists a page of 50 of the whole layer with counts, without the features that have no value", () => {
    show();
    expect(lastParams()).toEqual({ size: 50, page: 1, order: "descendent" });
    const options = within(list()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["v1-010", "v1-19", "v1-28"]);
  });

  it("says it takes several values and which are picked", () => {
    show({ value: ["v1-1"] });
    expect(list().getAttribute("aria-multiselectable")).toBe("true");
    expect(option("v1-1").getAttribute("aria-selected")).toBe("true");
    expect(option("v1-0").getAttribute("aria-selected")).toBe("false");
  });

  it("puts the picked values first, apart from the rest", () => {
    show({ value: ["v1-2"] });
    const options = within(list()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["v1-28", "v1-010", "v1-19"]);
    expect(within(list()).getAllByRole("separator")).toHaveLength(1);
  });

  it("a pick applies at once and keeps the row where it is", () => {
    const onChange = vi.fn();
    function Held() {
      const [value, setValue] = useState<unknown>(["v1-0"]);
      return (
        <ValuePicker
          layerId="dataset-1"
          field="name"
          type="string"
          multiple
          value={value}
          ariaLabel="style_editor.condition_value"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    renderWithProviders(<Held />);
    fireEvent.click(option("v1-2"));
    expect(onChange).toHaveBeenCalledWith(["v1-0", "v1-2"]);
    expect(option("v1-2").getAttribute("aria-selected")).toBe("true");
    const options = within(list()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["v1-010", "v1-19", "v1-28"]);
    fireEvent.click(option("v1-0"));
    expect(onChange).toHaveBeenLastCalledWith(["v1-2"]);
    // Taken out, it keeps its place at the top.
    expect(within(list()).getAllByRole("option")[0].textContent).toBe("v1-010");
  });

  it("counts the picked values against the limit", () => {
    show({ value: ["v1-0", "v1-1"] });
    expect(screen.getByText("filter_panel.picked")).toBeDefined();
  });

  it("asks for the next page only after a full one", () => {
    show();
    // The answer is shorter than a page (one of it not listed): the end of the list is the end of the values.
    fireEvent.scroll(list());
    expect(useLayerUniqueValues.mock.calls.every((call) => call[2].page === 1)).toBe(true);
  });

  it("sends the search as a like filter only after the pause", () => {
    show();
    vi.useFakeTimers();
    fireEvent.change(search(), { target: { value: "ber" } });
    expect(lastParams().query).toBeUndefined();
    act(() => vi.advanceTimersByTime(249));
    expect(lastParams().query).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(lastParams().query as string)).toEqual({
      op: "like",
      args: [{ property: "name" }, "%ber%"],
    });
  });

  it("scopes the list by a filter it is given, with and without a search", () => {
    vi.useFakeTimers();
    const filter = { op: "=", args: [{ property: "kind" }, "school"] };
    show({ filter });
    expect(lastParams().query).toBe(JSON.stringify(filter));
    fireEvent.change(search(), { target: { value: "v1" } });
    act(() => vi.advanceTimersByTime(250));
    expect(JSON.parse(lastParams().query ?? "")).toEqual({
      op: "and",
      args: [filter, { op: "like", args: [{ property: "name" }, "%v1%"] }],
    });
  });

  it("gives up height to a holder too short for it: the list shrinks, the search and the count do not", () => {
    show();
    const root = list().parentElement as HTMLElement;
    expect(getComputedStyle(root).display).toBe("flex");
    expect(getComputedStyle(root).minHeight).toBe("0px");
    expect(getComputedStyle(list()).minHeight).toBe("0px");
    const searchBox = search().closest("div.MuiInputBase-root")?.parentElement as HTMLElement;
    expect(getComputedStyle(searchBox).flexShrink).toBe("0");
  });

  it("does not send a search with % or _, and says why", () => {
    show();
    vi.useFakeTimers();
    fireEvent.change(search(), { target: { value: "50%" } });
    act(() => vi.advanceTimersByTime(300));
    expect(useLayerUniqueValues.mock.calls.at(-1)?.[0]).toBe("");
    expect(screen.getByText("filter_panel.wildcard")).toBeDefined();
  });

  it("stops adding at the cap and names the limit", () => {
    const full = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const { onChange } = show({ value: full });
    fireEvent.click(option("v1-0"));
    expect(onChange).not.toHaveBeenCalled();
    expect(option("v1-0").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("filter_panel.issue_too_many_values")).toBeDefined();
    // A picked value can still be taken out.
    fireEvent.click(option("p3"));
    expect(onChange).toHaveBeenCalledWith(full.filter((v) => v !== "p3"));
  });

  it("picks one value for is, with no count of picks", () => {
    const { onChange } = show({ multiple: false, value: "v1-1" });
    expect(list().hasAttribute("aria-multiselectable")).toBe(false);
    expect(option("v1-1").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("filter_panel.picked")).toBeNull();
    fireEvent.click(option("v1-2"));
    expect(onChange).toHaveBeenCalledWith("v1-2");
  });

  it("takes a typed value that is not listed, as a number for a number field", () => {
    const { onChange } = show({ multiple: false, type: "number" });
    fireEvent.change(search(), { target: { value: "42" } });
    fireEvent.click(screen.getByText("filter_panel.use_value"));
    expect(onChange).toHaveBeenCalledWith(42);
  });

  it("keeps a picked value that is not listed at the top, to take it out", () => {
    const { onChange } = show({ value: ["typed"] });
    expect(within(list()).getAllByRole("option")[0].textContent).toBe("typed");
    fireEvent.click(option("typed"));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("without a dataset a value can only be typed", () => {
    const { onChange } = show({ layerId: undefined });
    expect(useLayerUniqueValues.mock.calls.every((call) => call[0] === "")).toBe(true);
    expect(within(list()).queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(search(), { target: { value: "abc" } });
    fireEvent.click(screen.getByText("filter_panel.use_value"));
    expect(onChange).toHaveBeenCalledWith(["abc"]);
  });

  it("works with the keyboard: down into the rows, Space and Enter pick, typing goes on in the search", async () => {
    const { onChange } = show();
    search().focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(option("v1-0"));
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(["v1-0"]);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["v1-1"]);
    await userEvent.keyboard("x");
    expect(document.activeElement).toBe(search());
    expect((search() as HTMLInputElement).value).toBe("x");
  });

  it("Enter in the search takes the first match", async () => {
    const { onChange } = show({ multiple: false });
    search().focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("v1-0");
  });

  it("Tab from the search reaches the rows", async () => {
    show();
    search().focus();
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("role")).toBe("option");
  });
});
