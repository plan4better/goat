import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";

import { renderPanel } from "./renderPanel";

// The field's histogram: 10 bins over 0 to 10,000 (a step of 100), or over `span.max`; no class counts.
const span = vi.hoisted(() => ({ max: 10000 }));
vi.mock("@/lib/api/projects", async (original) => ({
  ...(await original<typeof import("@/lib/api/projects")>()),
  useProjectLayerHistogramStats: (layerId?: string, params?: { method?: string }) => ({
    histogramStats:
      layerId && params?.method === "equal_interval"
        ? {
            bins: Array.from({ length: 10 }, (_, i) => ({
              range: [(i * span.max) / 10, ((i + 1) * span.max) / 10],
              count: i + 1,
            })),
            missing_count: 0,
          }
        : undefined,
  }),
}));
vi.mock("@/lib/api/processes", async (original) => ({
  ...(await original<typeof import("@/lib/api/processes")>()),
  useUniqueValues: () => ({ data: undefined }),
}));

const QUANTILE = {
  id: "population",
  field: "population",
  method: "quantile",
  count: 4,
  palette: "colorbrewer:OrRd",
  classes: [
    { id: "c1", to: 2800, fill: { color: "#fef0d9" } },
    { id: "c2", from: 2800, to: 3600, fill: { color: "#fdcc8a" } },
    { id: "c3", from: 3600, to: 6300, fill: { color: "#fc8d59" } },
    { id: "c4", from: 6300, fill: { color: "#b30000" } },
  ],
  computed: {
    domain: [0, 10000],
    generated: {
      target: "fill.color",
      values: { c1: "#fef0d9", c2: "#fdcc8a", c3: "#fc8d59", c4: "#b30000" },
    },
  },
};

const draw = (type: "integer" | "number" = "integer", classification: object = QUANTILE) =>
  renderPanel(
    <PopoverProvider>
      <ClassificationEditor ci={0} />
    </PopoverProvider>,
    {
      document: {
        version: "1.0.0",
        kind: "vector",
        symbol: { fill: { color: "#cccccc" } },
        classify: [classification],
      } as unknown as LayerStyle,
      data: {
        geometry: "polygon",
        layerId: "l1",
        fields: [{ name: "population", type, label: "population" }],
        fieldTypes: { population: type },
      },
    }
  );

describe("a classification's histogram", () => {
  it("its breaks are handles: one dragged makes the classes manual, as a bound typed in the class list", () => {
    const { store } = draw();
    const handles = screen.getAllByRole("slider");
    expect(handles.map((h) => [h.getAttribute("data-handle"), h.getAttribute("aria-valuenow")])).toEqual([
      ["break", "2800"],
      ["break", "3600"],
      ["break", "6300"],
    ]);
    // A step down on the second break, a hundredth of the field's range.
    fireEvent.keyDown(handles[1], { key: "ArrowLeft" });
    expect(store.get("classify.0.method")).toBe("manual");
    expect(store.get("classify.0.count")).toBeUndefined();
    expect(store.get("classify.0.classes.2.from")).toBe(3500);
    expect(store.get("classify.0.classes.1.to")).toBe(3500);
    expect(store.get("classify.0.classes.0.to")).toBe(2800);
    // A break stops a step short of its neighbour.
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "End" });
    expect(store.get("classify.0.classes.1.from")).toBe(3400);
  });

  it("the first break taken to its limit stops a step inside the bars and keeps its handle", () => {
    const { store } = draw();
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "Home" });
    expect(store.get("classify.0.classes.1.from")).toBe(100);
    expect(store.get("classify.0.classes.0.to")).toBe(100);
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    fireEvent.keyDown(screen.getAllByRole("slider")[2], { key: "End" });
    expect(store.get("classify.0.classes.3.from")).toBe(9900);
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });

  it("a field of whole numbers steps its breaks by whole numbers, a decimal field by a hundredth of its range", () => {
    // Bars over 0 to 50: a hundredth of the range is half a unit.
    span.max = 50;
    const small = {
      ...QUANTILE,
      classes: [
        { id: "c1", to: 20, fill: { color: "#fef0d9" } },
        { id: "c2", from: 20, fill: { color: "#b30000" } },
      ],
      computed: { domain: [0, 50] },
    };
    try {
      const whole = draw("integer", small);
      fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
      expect(whole.store.get("classify.0.classes.1.from")).toBe(21);
      whole.unmount();
      const decimal = draw("number", small);
      fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
      expect(decimal.store.get("classify.0.classes.1.from")).toBe(20.5);
    } finally {
      span.max = 10000;
    }
  });
});
