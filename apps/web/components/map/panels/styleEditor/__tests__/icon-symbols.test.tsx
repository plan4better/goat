import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { ClassificationEditor } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const render = (doc: object) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: 1, kind: "vector", ...doc } as LayerStyle,
      data: { geometry: "point", featureCount: 10 },
    }
  );

const ICON_CLASSES = {
  id: "kind",
  field: "kind",
  method: "categories",
  target: "marker.icon",
  classes: [{ id: "c1", values: ["cafe"], marker: { icon: "goat:bar" } }],
};

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe("icon symbols", () => {
  it("the picker draws the symbol tiles from one file, requested once", async () => {
    const fetch = vi.fn(async (_url: string) =>
      Response.json({ icons: { park: { viewBox: "0 0 15 15", paths: ["M1 1h13v13H1z"] } } })
    );
    vi.stubGlobal("fetch", fetch);
    render({ symbol: { marker: { icon: "goat:park" } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(within(rowOf("style_editor.icon")).getByText("Park"));
    // The icon field reads "Park" too: the tile is the last.
    const tile = (await screen.findAllByRole("button", { name: "Park" })).at(-1) as HTMLElement;
    await vi.waitFor(() => expect(tile.querySelector("path")?.getAttribute("d")).toBe("M1 1h13v13H1z"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/icons\/maki\/symbols\.json$/);
  });

  it("an emoji shows without its name: in its shape in the section, its name on hover in the editor", async () => {
    render({ symbol: { marker: { icon: "emoji:1f525", shape: "square" } } });
    const section = rowOf("style_editor.part_icon");
    expect(section.querySelector('[data-marker-shape="square"]')).not.toBeNull();
    expect(within(section).queryByText("square")).toBeNull();
    await openGroup("style_editor.part_icon");
    const field = await screen.findByTitle("Fire");
    expect(field.textContent).toBe("");
  });

  it("icons by zoom show as their icons, their names on hover; a fixed icon shows its name", async () => {
    render({
      symbol: {
        marker: {
          shape: "icon",
          icon: {
            zoom: [
              [9, "goat:park"],
              [15, "goat:police-JP"],
            ],
            interpolate: "step",
          },
        },
      },
    });
    const section = rowOf("style_editor.part_icon");
    expect(within(section).getByRole("img", { name: "Park → Police JP" }).title).toBe("Park → Police JP");
    expect(within(section).queryByText(/Park/)).toBeNull();
    await openGroup("style_editor.part_icon");
    expect(within(rowOf("style_editor.icon")).getByRole("img", { name: "Park → Police JP" })).toBeDefined();
  });

  it("a fixed symbol shows its name; its shape only in its picture, as in the editor", () => {
    render({ symbol: { marker: { icon: "goat:park", shape: "pin" } } });
    const section = rowOf("style_editor.part_icon");
    expect(within(section).getByText("Park")).toBeDefined();
    expect(within(section).queryByText(/pin/)).toBeNull();
  });

  it("an icon shows in its marker's shape, in the section and the editor; the icon alone without one", async () => {
    const { unmount } = render({ symbol: { marker: { icon: "goat:park", shape: "pin" } } });
    expect(rowOf("style_editor.part_icon").querySelector('[data-marker-shape="pin"]')).not.toBeNull();
    await openGroup("style_editor.part_icon");
    expect(rowOf("style_editor.icon").querySelector('[data-marker-shape="pin"]')).not.toBeNull();
    unmount();
    render({ symbol: { marker: { icon: "goat:park", shape: "icon" } } });
    expect(rowOf("style_editor.part_icon").querySelector("[data-marker-shape]")).toBeNull();
  });

  it("icons by classes read as their field, not as the icon features outside the classes take", () => {
    render({
      symbol: { marker: { shape: "icon", icon: "emoji:1f606" } },
      classify: [ICON_CLASSES],
    });
    const section = rowOf("style_editor.part_icon");
    expect(within(section).getByText("style_editor.by_field")).toBeDefined();
    expect(section.querySelector("[aria-hidden='true'][class*='MuiBox']")).toBeNull();
  });

  it("a class's icon in the class list opens the icon picker, without the layer's shape", async () => {
    const { store } = renderPanel(
      <PopoverProvider>
        <ClassificationEditor ci={0} />
      </PopoverProvider>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { marker: { icon: "goat:park" } },
          classify: [ICON_CLASSES],
        } as LayerStyle,
        data: { geometry: "point", fields: [{ name: "kind", type: "string", label: "kind" }] },
      }
    );
    await userEvent.click(screen.getAllByRole("button", { name: "style_editor.class_icon" })[0]);
    expect(screen.queryByRole("button", { name: "square" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Park" }));
    expect(store.get("classify.0.classes.0.marker.icon")).toBe("goat:park");
  });
});
