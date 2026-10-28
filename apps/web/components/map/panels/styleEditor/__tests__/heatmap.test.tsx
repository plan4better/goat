import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import type { FieldProfile, ProfileSource } from "@/components/map/panels/styleEditor/context";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

import { choose, renderPanel } from "./renderPanel";

const FIELDS = [{ name: "visitors", type: "integer" as const, label: "visitors" }];

function profiles(known: Record<string, FieldProfile>): ProfileSource {
  return { get: (f) => known[f], load: () => undefined, subscribe: () => () => undefined };
}

function setup(
  render: object = { type: "heatmap" },
  known: Record<string, FieldProfile> = {},
  source: ProfileSource = profiles(known)
) {
  return renderPanel(
    <PopoverProvider>
      <HeatmapSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", render } as LayerStyle,
      data: {
        geometry: "point",
        fields: FIELDS,
        fieldTypes: { visitors: "integer" },
        profiles: source,
      },
    }
  );
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("heatmap", () => {
  it("opacity writes render.opacity", () => {
    const { store } = setup();
    fireEvent.change(within(rowOf("style_editor.opacity")).getByRole("slider"), { target: { value: 0.6 } });
    expect(store.get("render.opacity")).toBe(0.6);
  });

  it("a weight field writes its range from the field's profile; the range can be typed", async () => {
    const { store } = setup({ type: "heatmap" }, { visitors: { min: 0, max: 50000 } });
    await choose("style_editor.weight", "style_editor.weight_once", "style_editor.by_field");
    await waitFor(() =>
      expect(store.get("render.weight")).toEqual({ field: "visitors", domain: [0, 50000] })
    );
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.range_highest" }), {
      target: { value: "20000" },
    });
    expect(store.get("render.weight.domain")).toEqual([0, 20000]);
  });

  it("a range that arrives after the pick never comes back after undo", async () => {
    const listeners = new Set<() => void>();
    let known: Record<string, FieldProfile> = {};
    const source: ProfileSource = {
      get: (f) => known[f],
      load: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const { store } = setup({ type: "heatmap" }, {}, source);
    await choose("style_editor.weight", "style_editor.weight_once", "style_editor.by_field");
    expect(store.get("render.weight")).toEqual({ field: "visitors" });
    act(() => {
      known = { visitors: { min: 0, max: 50000 } };
      listeners.forEach((listener) => listener());
    });
    await waitFor(() =>
      expect(store.get("render.weight")).toEqual({ field: "visitors", domain: [0, 50000] })
    );
    for (let i = 0; i < 5 && store.canUndo; i++) act(() => store.undo());
    expect(store.get("render.weight")).toBeUndefined();
    expect(store.canRedo).toBe(true);
  });
});
