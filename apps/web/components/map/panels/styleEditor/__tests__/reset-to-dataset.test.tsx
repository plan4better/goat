// A part's popover offers "Reset to the dataset's style" while the part differs from the dataset's default style: it
// puts the dataset's part back, its classifications included (removing a part the dataset has not), as one edit the
// panel's undo takes back. A dataset without a default style resets to the built-in default.
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultStyle } from "@/lib/style/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const dataset = vi.hoisted(() => ({
  style: undefined as { document: unknown } | undefined,
  error: undefined as { status: number } | undefined,
}));
vi.mock("@/lib/api/map", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDatasetStyle: (layerId?: string | null) => ({
    style: layerId ? dataset.style : undefined,
    error: layerId ? dataset.error : undefined,
    isLoading: false,
  }),
}));

const RESET = "style_editor.reset_to_dataset";
const DATASET_DOC = {
  version: 1,
  kind: "vector",
  symbol: { fill: { color: "#2bb381", opacity: 0.8 }, outline: false },
} as LayerStyle;

let datasets = 0;
function setup(symbol: object, extra: object = {}) {
  datasets += 1;
  const layerId = `dataset-${datasets}`;
  const view = renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", symbol, ...extra } as LayerStyle,
      data: {
        layerId,
        geometry: "polygon",
        fields: [{ name: "use", type: "string", label: "use" }],
        fieldTypes: { use: "string" },
      },
    }
  );
  return { ...view, layerId };
}

describe("reset to the dataset's style", () => {
  beforeEach(() => {
    dataset.style = { document: DATASET_DOC };
    dataset.error = undefined;
  });

  it("puts the dataset's part back as one undo step, and is gone once the part matches", async () => {
    const { store } = setup({ fill: { color: "#d7301f", opacity: 0.5 }, outline: false });
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("button", { name: RESET }));
    expect(store.get("symbol.fill")).toEqual({ color: "#2bb381", opacity: 0.8 });
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
    act(() => store.undo());
    expect(store.get("symbol.fill")).toEqual({ color: "#d7301f", opacity: 0.5 });
    expect(screen.getByRole("button", { name: RESET })).toBeDefined();
  });

  it("removes a part the dataset's style has not", async () => {
    const { store } = setup({
      fill: { color: "#2bb381", opacity: 0.8 },
      outline: false,
      label: { text: "{{use}}" },
    });
    await openGroup("style_editor.part_label");
    await userEvent.click(screen.getByRole("button", { name: RESET }));
    expect(store.get("symbol.label")).toBeUndefined();
  });

  it("restores a part switched off as the dataset has it", async () => {
    dataset.style = {
      document: { ...DATASET_DOC, symbol: { fill: { color: "#2bb381" }, outline: { color: "#000000" } } },
    };
    const { store } = setup({ fill: { color: "#2bb381" }, outline: false });
    await openGroup("style_editor.part_outline");
    await userEvent.click(screen.getByRole("button", { name: RESET }));
    expect(store.get("symbol.outline")).toEqual({ color: "#000000" });
  });

  it("has no reset while the part is the dataset's, or while the dataset's style is not there", async () => {
    const first = setup({ fill: { color: "#2bb381", opacity: 0.8 }, outline: false });
    await openGroup("style_editor.part_fill");
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
    first.unmount();
    dataset.style = undefined;
    setup({ fill: { color: "#d7301f" }, outline: false });
    await openGroup("style_editor.part_fill");
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
  });

  it("resets a part classes set: the dataset's part comes back without the classification", async () => {
    const { store } = setup(
      { fill: { color: "#d7301f" }, outline: false },
      {
        classify: [
          {
            id: "use",
            field: "use",
            method: "categories",
            classes: [{ values: ["a"], fill: { color: "#000000" } }],
          },
        ],
      }
    );
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("button", { name: RESET }));
    expect(store.get("symbol.fill")).toEqual({ color: "#2bb381", opacity: 0.8 });
    expect(store.get("classify")).toBeUndefined();
    // One step back: the part and its classification.
    act(() => store.undo());
    expect(store.get("classify.0.id")).toBe("use");
    expect(store.get("symbol.fill")).toEqual({ color: "#d7301f" });
  });

  it("goes back to the built-in default for a dataset without a default style", async () => {
    dataset.style = undefined;
    dataset.error = { status: 404 };
    const { store } = setup({ fill: { color: "#d7301f" }, outline: false });
    await openGroup("style_editor.part_fill");
    await userEvent.click(screen.getByRole("button", { name: RESET }));
    expect(store.get("symbol.fill")).toEqual(
      (defaultStyle("polygon") as { symbol: { fill: unknown } }).symbol.fill
    );
  });
});
