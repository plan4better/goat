import { ThemeProvider, createTheme } from "@mui/material";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useMemo, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";

import { EditorStore } from "@/lib/style/editor/store";
import type { LayerStyle } from "@/lib/style/generated/types";
import type { RasterInfo } from "@/lib/style/raster/metadata";
import { StyleSaver } from "@/lib/style/save";

import { EMPTY_DATA, StyleEditorProvider } from "@/components/map/panels/styleEditor/context";
import { MapStateProvider, type Position } from "@/components/map/panels/styleEditor/mapState";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { RasterGeneralSection } from "@/components/map/panels/styleEditor/sections/RasterGeneralSection";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";

import { choose, echoTransport, i18n, renderPanel } from "./renderPanel";

describe("the layer's position", () => {
  it("position writes the layer's map state; without map state (the dev route) there is no row", async () => {
    const onPosition = vi.fn();
    renderPanel(
      <MapStateProvider value={{ position: "top", onPosition }}>
        <PopoverProvider>
          <LayerSection />
        </PopoverProvider>
      </MapStateProvider>
    );
    await choose("position", "style_editor.position_top", "style_editor.position_below_labels");
    expect(onPosition).toHaveBeenCalledWith("below_labels");
  });

  it("is not shown without map state", () => {
    renderPanel(
      <PopoverProvider>
        <LayerSection />
      </PopoverProvider>
    );
    expect(screen.queryByText("position")).toBeNull();
  });

  it("raster layers have the Position row", async () => {
    for (const service of [false, true]) {
      const onPosition = vi.fn();
      // A file's style draws an image; a map service's style has no render.
      const document = (
        service
          ? { version: "1.0.0", kind: "raster" }
          : { version: "1.0.0", kind: "raster", render: { type: "image" } }
      ) as LayerStyle;
      const { unmount } = renderPanel(
        <MapStateProvider value={{ position: "top", onPosition }}>
          <PopoverProvider>
            <RasterLayerSection service={service} />
          </PopoverProvider>
        </MapStateProvider>,
        { document }
      );
      await choose("position", "style_editor.position_top", "style_editor.position_below_labels");
      expect(onPosition).toHaveBeenCalledWith("below_labels");
      unmount();
    }
  });

  describe("a raster's colors on top of the basemap's labels", () => {
    const BYTE: RasterInfo = {
      bands: 1,
      bits: [8],
      colorTable: false,
      integer: true,
      names: [""],
      stats: [],
    };
    const NOTE = "style_editor.position_hides_labels";
    const MOVE = "style_editor.position_move_below_labels";
    const panel = (position: Position, type = "image") => {
      const onPosition = vi.fn();
      const view = renderPanel(
        <MapStateProvider value={{ position, onPosition }}>
          <PopoverProvider>
            <RasterGeneralSection />
            <RasterLayerSection />
          </PopoverProvider>
        </MapStateProvider>,
        {
          document: { version: "1.0.0", kind: "raster", render: { type } } as LayerStyle,
          data: { raster: { dataset: "d1", info: BYTE } },
        }
      );
      return { ...view, onPosition };
    };
    const drawAs = (from: string, to: string) =>
      choose("style_editor.draw_as", `style_editor.raster_type_${from}`, `style_editor.raster_type_${to}`);

    it("switched from Image to a color range, a hillshade or categories, the layer stays and the row offers the move", async () => {
      for (const next of ["continuous", "hillshade", "categorical"]) {
        const { onPosition, store, unmount } = panel("top");
        expect(screen.queryByText(NOTE)).toBeNull();
        await drawAs("image", next);
        await waitFor(() => expect(store.get("render.type")).toBe(next));
        expect(await screen.findByText(NOTE)).toBeDefined();
        expect(screen.getByRole("button", { name: MOVE })).toBeDefined();
        expect(onPosition).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("the button moves the layer below the labels, and the note goes", async () => {
      const { onPosition } = panel("top");
      await drawAs("image", "continuous");
      await userEvent.click(await screen.findByRole("button", { name: MOVE }));
      expect(onPosition.mock.calls).toEqual([["below_labels"]]);
      expect(screen.queryByText(NOTE)).toBeNull();
    });

    it("a position picked by hand removes the note", async () => {
      const { onPosition } = panel("top");
      await drawAs("image", "hillshade");
      await screen.findByText(NOTE);
      await choose("position", "style_editor.position_top", "style_editor.position_below_roads");
      expect(onPosition.mock.calls).toEqual([["below_roads"]]);
      expect(screen.queryByText(NOTE)).toBeNull();
    });

    it("no note for a layer that is not on top, nor from one color scale to another", async () => {
      const roads = panel("below_roads");
      await drawAs("image", "continuous");
      await waitFor(() => expect(roads.store.get("render.type")).toBe("continuous"));
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(roads.onPosition).not.toHaveBeenCalled();
      roads.unmount();
      const shaded = panel("top", "hillshade");
      await drawAs("hillshade", "continuous");
      await waitFor(() => expect(shaded.store.get("render.type")).toBe("continuous"));
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(shaded.onPosition).not.toHaveBeenCalled();
    });

    it("drawn as Image again the note goes, also by an undo, and a redo does not bring it back", async () => {
      const { onPosition, store } = panel("top");
      await drawAs("image", "hillshade");
      await screen.findByText(NOTE);
      await drawAs("hillshade", "image");
      expect(screen.queryByText(NOTE)).toBeNull();
      await drawAs("image", "hillshade");
      await screen.findByText(NOTE);
      act(() => store.undo());
      await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull());
      act(() => store.redo());
      expect(store.get("render.type")).toBe("hillshade");
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(onPosition).not.toHaveBeenCalled();
    });

    it("the note goes once the layer is no longer on top", async () => {
      function Page({ children }: { children: ReactNode }) {
        const [position, setPosition] = useState<Position>("top");
        const value = useMemo(() => ({ position, layer: 81001, onPosition: setPosition }), [position]);
        return (
          <MapStateProvider value={value}>
            <button onClick={() => setPosition((p) => (p === "top" ? "below_labels" : "top"))}>
              elsewhere
            </button>
            {children}
          </MapStateProvider>
        );
      }
      renderPanel(
        <Page>
          <PopoverProvider>
            <RasterGeneralSection />
            <RasterLayerSection />
          </PopoverProvider>
        </Page>,
        {
          document: { version: "1.0.0", kind: "raster", render: { type: "image" } } as LayerStyle,
          data: { raster: { dataset: "d1", info: BYTE } },
        }
      );
      await drawAs("image", "continuous");
      await screen.findByText(NOTE);
      // Moved somewhere else on the page, and back on top: the offer was for the switch, not for the place.
      await userEvent.click(screen.getByText("elsewhere"));
      await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull());
      await userEvent.click(screen.getByText("elsewhere"));
      expect(screen.queryByText(NOTE)).toBeNull();
    });

    describe("another store in the open panel", () => {
      const storeOf = (render: Record<string, unknown>) =>
        new EditorStore({
          saver: new StyleSaver({
            transport: echoTransport(),
            document: { version: "1.0.0", kind: "raster", render } as unknown as LayerStyle,
            revision: 1,
          }),
        });
      const tree = (
        store: EditorStore,
        layer: number,
        position: Position,
        onPosition: (p: Position) => void
      ) => (
        <I18nextProvider i18n={i18n}>
          <ThemeProvider theme={createTheme()}>
            <StyleEditorProvider
              store={store}
              data={{ ...EMPTY_DATA, raster: { dataset: `d${layer}`, info: BYTE } }}
              mapZoom={12}
              map={null}>
              <MapStateProvider value={{ position, layer, onPosition }}>
                <PopoverProvider scope={store}>
                  <RasterGeneralSection />
                  <RasterLayerSection />
                </PopoverProvider>
              </MapStateProvider>
            </StyleEditorProvider>
          </ThemeProvider>
        </I18nextProvider>
      );

      it("another layer's color range on top is neither moved nor offered the move", async () => {
        const onA = vi.fn();
        const onB = vi.fn();
        const image = storeOf({ type: "image" });
        const range = storeOf({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
        const view = render(tree(image, 91001, "top", onA));
        // The layer picked in the layer list: its map state arrives first, its store after.
        await act(async () => view.rerender(tree(image, 91002, "top", onB)));
        await act(async () => view.rerender(tree(range, 91002, "top", onB)));
        expect(screen.getAllByText("style_editor.raster_type_continuous").length).toBeGreaterThan(0);
        expect(onA).not.toHaveBeenCalled();
        expect(onB).not.toHaveBeenCalled();
        expect(screen.queryByText(NOTE)).toBeNull();
      });

      it("a layer's named styles, an image and a hillshade, switched back and forth", async () => {
        const onPosition = vi.fn();
        const image = storeOf({ type: "image" });
        const shaded = storeOf({ type: "hillshade" });
        const view = render(tree(image, 91003, "top", onPosition));
        for (const store of [shaded, image, shaded]) {
          await act(async () => view.rerender(tree(store, 91003, "top", onPosition)));
          expect(screen.queryByText(NOTE)).toBeNull();
        }
        expect(onPosition).not.toHaveBeenCalled();
      });

      it("the move offered in one named style shows in that style only, not in another of the layer", async () => {
        const onPosition = vi.fn();
        const image = storeOf({ type: "image" });
        const range = storeOf({ type: "continuous", palette: "goat:elevation", domain: [0, 100] });
        const view = render(tree(image, 91004, "top", onPosition));
        await drawAs("image", "hillshade");
        await screen.findByText(NOTE);
        await act(async () => view.rerender(tree(range, 91004, "top", onPosition)));
        expect(screen.getAllByText("style_editor.raster_type_continuous").length).toBeGreaterThan(0);
        expect(screen.queryByText(NOTE)).toBeNull();
        // Back in the style it was offered in, the offer stands.
        await act(async () => view.rerender(tree(image, 91004, "top", onPosition)));
        expect(screen.getByText(NOTE)).toBeDefined();
        expect(onPosition).not.toHaveBeenCalled();
      });
    });
  });
});
