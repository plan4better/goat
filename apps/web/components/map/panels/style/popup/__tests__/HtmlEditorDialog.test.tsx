import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PopupProperties } from "@/lib/validations/layer";

import { HtmlEditorDialog } from "@/components/map/panels/style/popup/HtmlEditorDialog";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/hooks/map/CommonHooks", () => ({ default: () => ({ layerFields: [] }) }));
vi.mock("@/components/map/popover/sampleFeature", () => ({
  useSampleFeature: () => ({ feature: undefined }),
}));
vi.mock("@/components/map/panels/style/popup/HtmlModeEditor", () => ({
  HtmlModeEditor: ({ fields }: { fields: Array<{ name: string }> }) => (
    <div>html editor: {fields.map((f) => f.name).join(", ")}</div>
  ),
}));
vi.mock("@/components/map/panels/style/popup/PopupAppearanceSettings", () => ({
  PopupAppearanceSettings: () => <div>appearance settings</div>,
}));
vi.mock("@/components/map/popover/MapFeaturePopover", () => ({
  PopupContent: () => <div>popup content</div>,
  PopupHeader: () => <div>popup header</div>,
}));

const popup = { html: "<b>{{name}}</b>", header: "standard" } as unknown as PopupProperties;

describe("HtmlEditorDialog", () => {
  it("renders the title, the settings pane and the save action", () => {
    render(
      <HtmlEditorDialog
        open
        layerId="l1"
        layerName="Roads"
        popup={popup}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("popup_html_editor_title")).toBeInTheDocument();
    expect(screen.getByText("appearance settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
  });

  it("commits the draft html on save and discards it on cancel", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <HtmlEditorDialog
        open
        layerId="l1"
        layerName="Roads"
        popup={popup}
        onChange={onChange}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(onChange).toHaveBeenCalledWith({ html: "<b>{{name}}</b>" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    onChange.mockClear();
    render(
      <HtmlEditorDialog
        open
        layerId="l1"
        layerName="Roads"
        popup={popup}
        onChange={onChange}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers the fields it is given in place of the layer's: a raster file's cell", () => {
    render(
      <HtmlEditorDialog
        open
        layerId=""
        layerName="DEM"
        popup={popup}
        onChange={vi.fn()}
        onClose={vi.fn()}
        fields={[
          { name: "value", type: "number" },
          { name: "class", type: "string" },
          { name: "band_1", type: "number" },
        ]}
      />
    );
    expect(screen.getByText("html editor: value, class, band_1")).toBeInTheDocument();
  });
});
