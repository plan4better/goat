import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as classify from "@/lib/style/editor/classify";
import * as conditions from "@/lib/style/editor/conditions";
import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

// A rule row without a name reads its condition as a sentence: counting the calls counts the rule rows a tick renders.
vi.mock("@/lib/style/editor/conditions", async (importOriginal) => {
  const original = await importOriginal<typeof conditions>();
  return { ...original, conditionSentence: vi.fn(original.conditionSentence) };
});

// Every category row has one color field: counting its renders counts the category rows a tick renders.
const colorFields = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/map/panels/styleEditor/rows", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/map/panels/styleEditor/rows")>();
  const Original = original.ColorField;
  return {
    ...original,
    ColorField: (props: Parameters<typeof Original>[0]) => {
      colorFields.count += 1;
      return <Original {...props} />;
    },
  };
});

// Every scoped row builds the scoped view when it renders: counting the calls counts the rows a tick renders.
vi.mock("@/lib/style/editor/classify", async (importOriginal) => {
  const original = await importOriginal<typeof classify>();
  return { ...original, scopedView: vi.fn(original.scopedView) };
});

const classes = Array.from({ length: 4 }, (_, i) => ({
  id: `c${i + 1}`,
  ...(i > 0 ? { from: i * 10 } : {}),
  ...(i < 3 ? { to: (i + 1) * 10 } : {}),
  fill: { color: `#0000${String(i).padStart(2, "0")}` },
}));

describe("renders in class scope", () => {
  it("a scoped opacity tick renders only the rows that show it", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <SymbolSection />
        <LegendSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { fill: { color: "#cccccc", opacity: 0.8 }, outline: { color: "#ffffff", width: 1 } },
          classify: [{ id: "density", field: "density", method: "quantile", count: 4, classes }],
        } as unknown as LayerStyle,
        data: { geometry: "polygon", fields: [{ name: "density", type: "number", label: "density" }] },
      }
    );
    act(() => store.setScope({ classify: 0, key: 1 }));
    await openGroup("style_editor.part_fill");
    act(() => store.set("classify.0.classes.1.fill.opacity", 0.5));
    const calls = vi.mocked(classify.scopedView);
    calls.mockClear();
    act(() => store.set("classify.0.classes.1.fill.opacity", 0.55));
    // The opacity row and the fill group row; not every row of the section, the chip and the note.
    expect(calls.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe("renders in rule scope", () => {
  it("a color tick on one rule renders that rule's row, not every rule row", async () => {
    const { RulesSection } = await import("@/components/map/panels/styleEditor/sections/RulesSection");
    const rules = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i + 1}`,
      when: { op: "<", args: [{ property: "traffic" }, (i + 1) * 100] },
      line: { color: "#000000" },
    }));
    const { store } = renderPanel(
      <PopoverProvider>
        <RulesSection />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { line: { color: "#cccccc", width: 2 } },
          rules,
        } as unknown as LayerStyle,
        data: { geometry: "line", fields: [{ name: "traffic", type: "number", label: "traffic" }] },
      }
    );
    act(() => store.setScope({ rule: "r1", index: 0 }));
    act(() => store.set("rules.0.line.color", "#111111"));
    const rows = vi.mocked(conditions.conditionSentence);
    rows.mockClear();
    act(() => store.set("rules.0.line.color", "#222222"));
    expect(rows.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("renders of raster categories", () => {
  it("a color tick on one category renders that category's row only", async () => {
    const { RasterColorSection } = await import(
      "@/components/map/panels/styleEditor/sections/RasterColorSection"
    );
    const classes = Array.from({ length: 6 }, (_, i) => ({ value: i + 1, color: "#4a90c2" }));
    const { store } = renderPanel(
      <PopoverProvider>
        <RasterColorSection />
      </PopoverProvider>,
      {
        document: { version: 1, kind: "raster", render: { type: "categorical", classes } } as LayerStyle,
        data: {
          raster: {
            dataset: "d1",
            info: { bands: 1, bits: [8], colorTable: false, integer: true, stats: [] },
          },
        },
      }
    );
    act(() => store.set("render.classes.0.color", "#111111"));
    colorFields.count = 0;
    act(() => store.set("render.classes.0.color", "#222222"));
    expect(colorFields.count).toBeLessThanOrEqual(1);
  });
});
