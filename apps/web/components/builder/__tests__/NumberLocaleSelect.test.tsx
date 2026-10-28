import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";
import { syncMapLayers } from "@/lib/style/render/mapLayers";
import { renderLayersOf } from "@/lib/style/render/viewLayers";

import NumberLocaleSelect from "@/components/builder/settings/NumberLocaleSelect";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/transformers/map-image", () => ({ loadImage: vi.fn(async () => undefined) }));

function recordingMap() {
  const layers = new Map<string, Record<string, unknown>>();
  const state: Record<string, unknown> = {};
  return {
    layers,
    state,
    getStyle: () => ({ layers: [...layers.values()] }),
    getSource: () => undefined,
    addSource: () => undefined,
    removeSource: () => undefined,
    getLayer: (id: string) => layers.get(id),
    addLayer: (l: { id: string }) => layers.set(l.id, l),
    removeLayer: (id: string) => layers.delete(id),
    moveLayer: () => undefined,
    setPaintProperty: () => undefined,
    setLayoutProperty: () => undefined,
    setFilter: () => undefined,
    setLayerZoomRange: () => undefined,
    setGlobalStateProperty: (name: string, value: unknown) => {
      state[name] = value;
    },
    setFeatureState: () => undefined,
    setMissingStyleImageResolver: () => undefined,
    hasImage: () => false,
  };
}

describe("the number locale of a map", () => {
  it("a set locale changes number labels", async () => {
    const onChange = vi.fn();
    render(<NumberLocaleSelect value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: /Deutschland/ }));
    expect(onChange).toHaveBeenCalledWith("de-DE");

    // The map document carries the project's locale; the renderer gives it to every number label.
    const style = {
      version: 1,
      kind: "vector",
      symbol: { marker: { color: "#ff0000" }, label: { text: "{population}" } },
    } as LayerStyle;
    const [layer] = renderLayersOf([
      {
        id: 4,
        layer_id: "d4",
        type: "feature",
        feature_layer_geometry_type: "point",
        visible: true,
        style: { id: "s", document: style },
      },
    ]);
    const map = recordingMap();
    syncMapLayers(map, null, [layer], { locale: "de-DE" });
    expect(map.state.locale).toBe("de-DE");
    expect(JSON.stringify(map.layers.get("4-label")?.layout)).toContain('"locale":["global-state","locale"]');
  });

  it("unset means the viewer's language", async () => {
    const onChange = vi.fn();
    render(<NumberLocaleSelect value="de-DE" onChange={onChange} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "number_locale_viewer" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
