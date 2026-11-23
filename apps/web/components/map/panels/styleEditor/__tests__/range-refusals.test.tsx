// Ranges the panel lets the user set only the way goatlib takes them: Smallest at most Largest, a fixed range and a
// weight's range from low to high (taken when its box is left), zooms From below Until.
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { ZoomRangeRow } from "@/components/map/panels/styleEditor/rows";
import { DomainRow } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

import { renderPanel } from "./renderPanel";

const FIELDS = [{ name: "traffic", type: "number" as const, label: "traffic" }];
const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

function attribute(width: object) {
  return renderPanel(
    <PopoverProvider>
      <AttributeEditor path="symbol.line.width" />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "vector", symbol: { line: { width } } } as LayerStyle,
      data: { geometry: "line", fields: FIELDS, fieldTypes: { traffic: "number" } },
    }
  );
}

describe("ranges goatlib takes", () => {
  it("Smallest stops at Largest and Largest at Smallest", () => {
    const { store } = attribute({ field: "traffic", range: [2, 8], domain: [0, 500] });
    fireEvent.change(within(rowOf("style_editor.range_smallest")).getByRole("slider"), {
      target: { value: 12 },
    });
    expect(store.get("symbol.line.width.range")).toEqual([8, 8]);
    fireEvent.change(within(rowOf("style_editor.range_largest")).getByRole("slider"), {
      target: { value: 1 },
    });
    expect(store.get("symbol.line.width.range")).toEqual([8, 8]);
    fireEvent.change(within(rowOf("style_editor.range_smallest")).getByRole("slider"), {
      target: { value: 3 },
    });
    fireEvent.change(within(rowOf("style_editor.range_largest")).getByRole("slider"), {
      target: { value: 1 },
    });
    expect(store.get("symbol.line.width.range")).toEqual([3, 3]);
  });

  it("a fixed range is taken when its box is left, and only from low to high", () => {
    const { store } = attribute({ field: "traffic", range: [1, 8], domain: [0, 500] });
    const from = screen.getByRole("textbox", { name: "style_editor.domain_from" }) as HTMLInputElement;
    // "500" typed over 0 passes "5" and "50" on the way; nothing is written until the box is left.
    for (const value of ["5", "50", "500"]) fireEvent.change(from, { target: { value } });
    expect(store.get("symbol.line.width.domain")).toEqual([0, 500]);
    fireEvent.blur(from);
    // 500 to 500 is no range: it stays in the box, unsaved, with a note.
    expect(store.get("symbol.line.width.domain")).toEqual([0, 500]);
    expect(from.value).toBe("500");
    expect(screen.getByText("style_editor.range_low_to_high")).toBeDefined();
    const to = screen.getByRole("textbox", { name: "style_editor.domain_to" });
    fireEvent.change(to, { target: { value: "900" } });
    fireEvent.blur(to);
    expect(store.get("symbol.line.width.domain")).toEqual([500, 900]);
    expect(screen.queryByText("style_editor.range_low_to_high")).toBeNull();
  });

  it("a weight's range without numbers yet is written once both boxes have one", () => {
    const { store } = renderPanel(<DomainRow path="render.weight.domain" />, {
      document: {
        version: "1.0.0",
        kind: "vector",
        render: { type: "heatmap", weight: { field: "v" } },
      } as LayerStyle,
    });
    const lowest = screen.getByRole("textbox", { name: "style_editor.range_lowest" }) as HTMLInputElement;
    fireEvent.change(lowest, { target: { value: "5" } });
    fireEvent.blur(lowest);
    expect(store.get("render.weight.domain")).toBeUndefined();
    expect(lowest.value).toBe("5");
    const highest = screen.getByRole("textbox", { name: "style_editor.range_highest" });
    fireEvent.change(highest, { target: { value: "50" } });
    fireEvent.blur(highest);
    expect(store.get("render.weight.domain")).toEqual([5, 50]);
  });

  it("the zoom range keeps From one zoom below Until", () => {
    const onChange = vi.fn();
    renderPanel(<ZoomRangeRow from={8} until={14} mapZoom={12} onChange={onChange} />);
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.zoom_from" }), {
      target: { value: 14 },
    });
    expect(onChange).toHaveBeenLastCalledWith(13, 14);
    fireEvent.change(screen.getByRole("slider", { name: "style_editor.zoom_until" }), {
      target: { value: 8 },
    });
    expect(onChange).toHaveBeenLastCalledWith(8, 9);
  });
});
