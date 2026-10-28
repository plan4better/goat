import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import SimpleLayerStyle from "@/components/map/panels/style/SimpleLayerStyle";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const DOC = {
  version: 1,
  kind: "vector",
  opacity: 0.8,
  symbol: { fill: { color: "#cccccc" } },
} as LayerStyle;
const layer = (extra: Partial<MapLayer> = {}) =>
  ({
    id: 5,
    name: "Districts",
    style: { id: "day", name: "Day", position: 0, revision: 1, document: DOC, issues: [], stale: false },
    otherStyles: [{ id: "night", name: "Night" }],
    ...extra,
  }) as unknown as MapLayer;

describe("the simple style panel", () => {
  it("opacity starts at the viewer's, else the style's, and hands on the released value", () => {
    const onOpacityChange = vi.fn();
    const { unmount } = render(<SimpleLayerStyle layer={layer()} onOpacityChange={onOpacityChange} />);
    const slider = screen.getByRole("slider", { name: "style_editor.opacity" });
    expect(slider.getAttribute("aria-valuenow")).toBe("0.8");
    fireEvent.change(slider, { target: { value: 0.3 } });
    expect(onOpacityChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 5 }), 0.3);
    unmount();
    render(<SimpleLayerStyle layer={layer({ opacity: 0.5 })} onOpacityChange={onOpacityChange} />);
    expect(screen.getByRole("slider", { name: "style_editor.opacity" }).getAttribute("aria-valuenow")).toBe(
      "0.5"
    );
  });

  it("the style choice lists the layer's named styles, only where a viewer may switch", async () => {
    const onStyleChange = vi.fn();
    const { unmount } = render(<SimpleLayerStyle layer={layer()} onOpacityChange={vi.fn()} />);
    expect(screen.queryByText("style_editor.named_style")).toBeNull();
    unmount();
    render(<SimpleLayerStyle layer={layer()} onOpacityChange={vi.fn()} onStyleChange={onStyleChange} />);
    const select = screen.getByRole("combobox", { name: "style_editor.named_style" });
    expect(select.textContent).toBe("Day");
    await userEvent.click(select);
    await userEvent.click(screen.getByRole("option", { name: "Night" }));
    expect(onStyleChange).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), "night");
  });
});
