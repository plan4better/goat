import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { LayerStyle } from "@/lib/style/generated/types";

import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

import { openGroup, renderPanel } from "./renderPanel";

const FIELDS = [{ name: "kind", type: "string" as const, label: "kind" }];

const render = (doc: object) =>
  renderPanel(
    <PopoverProvider>
      <SymbolSection />
    </PopoverProvider>,
    {
      document: { version: "1.0.0", kind: "vector", ...doc } as LayerStyle,
      data: { geometry: "point", fields: FIELDS },
    }
  );

/** A group's row in the section (its editor, once open, is titled the same, after it in the page). */
const groupRow = (label: string) => screen.getAllByText(label)[0].parentElement as HTMLElement;
/** Whether a row renders as a part that is off. */
const dimmed = (label: string) => getComputedStyle(groupRow(label)).opacity === "0.55";
const iconText = () => within(groupRow("style_editor.part_icon")).getByRole("button").textContent;

const byKind = (records: object[], extra: object = {}) => [
  { id: "k", field: "kind", method: "categories", classes: records, ...extra },
];

describe("the Icon row of the points", () => {
  it("a plain marker's Icon row reads None and is off, like the Outline row beside it", () => {
    render({ symbol: { marker: { size: 8 } } });
    expect(iconText()).toBe("style_editor.none");
    expect(dimmed("style_editor.part_icon")).toBe(true);
    expect(within(groupRow("style_editor.part_outline")).getByText("style_editor.none")).toBeDefined();
    expect(dimmed("style_editor.part_outline")).toBe(true);
    // The Fill row of the same marker is on.
    expect(dimmed("style_editor.part_fill")).toBe(false);
  });

  it("a marker with an icon or a shape other than Circle has an Icon row that is on", () => {
    for (const marker of [{ icon: "goat:park" }, { shape: "square" }, { shape: "icon", icon: "goat:park" }]) {
      const { unmount } = render({ symbol: { marker } });
      expect(dimmed("style_editor.part_icon")).toBe(false);
      unmount();
    }
  });

  it("icons by a field, or icons and shapes for some classes, keep the Icon row on", () => {
    const byField = render({
      symbol: { marker: {} },
      classify: byKind([{ id: "a", values: ["x"], marker: { icon: "goat:bar" } }], { target: "marker.icon" }),
    });
    expect(dimmed("style_editor.part_icon")).toBe(false);
    byField.unmount();

    // A shape for one class of a color classification: the row names what gives it.
    render({
      symbol: { marker: { color: "#888888" } },
      classify: byKind([{ id: "a", values: ["x"], marker: { shape: "square" } }]),
    });
    expect(iconText()).not.toBe("style_editor.none");
    expect(dimmed("style_editor.part_icon")).toBe(false);
  });

  it("switching the icon on and off in its editor flips the row", async () => {
    render({ symbol: { marker: { size: 8 } } });
    await openGroup("style_editor.part_icon");
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_on" }));
    expect(dimmed("style_editor.part_icon")).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: "style_editor.turn_part_off" }));
    expect(dimmed("style_editor.part_icon")).toBe(true);
  });

  it("markers switched off leave the Icon row off", () => {
    render({ symbol: { marker: false, label: { text: "{kind}" } } });
    expect(dimmed("style_editor.part_icon")).toBe(true);
  });

  it("in a class's or a rule's scope the Icon row keeps reading the record and is not off", () => {
    const { store } = render({
      symbol: { marker: { color: "#888888" } },
      classify: byKind([
        { id: "a", values: ["x"], marker: { color: "#ff0000" } },
        { id: "b", values: ["y"], marker: { icon: "goat:park" } },
      ]),
      rules: [{ id: "r1", when: { field: "kind", op: "eq", value: "z" }, marker: { color: "#00ff00" } }],
    });
    act(() => store.setScope({ classify: 0, key: 0 }));
    expect(iconText()).toBe("style_editor.none");
    expect(dimmed("style_editor.part_icon")).toBe(false);
    act(() => store.setScope({ classify: 0, key: 1 }));
    expect(dimmed("style_editor.part_icon")).toBe(false);
    // A rule's features may be of either class: the row reads the icons by class, as before.
    act(() => store.setScope({ rule: "r1", index: 0 }));
    expect(dimmed("style_editor.part_icon")).toBe(false);
  });
});
