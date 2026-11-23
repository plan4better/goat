import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Mode } from "@/lib/style/editor/forms";

import { ValueModeButton } from "@/components/map/panels/styleEditor/rows/ValueModeButton";

import { renderPanel } from "./renderPanel";

const MODE_BUTTON = { name: "style_editor.value_mode_aria" };

/** The first path of each icon drawn inside an element, in order. */
const iconsIn = (el: Element) =>
  Array.from(el.querySelectorAll("svg")).map((svg) => svg.querySelector("path")?.getAttribute("d"));

/** The first path of an icon as the Icon component draws it. */
function iconPath(name: ICON_NAME) {
  const { container, unmount } = render(<Icon iconName={name} />);
  const d = container.querySelector("path")?.getAttribute("d");
  unmount();
  return d;
}

describe("ValueModeButton", () => {
  it.each<[Mode, ICON_NAME]>([
    ["fixed", ICON_NAME.CIRCLE_DOT],
    ["zoom", ICON_NAME.ZOOM_IN],
    ["attribute", ICON_NAME.TABLE_COLUMNS],
    ["raw", ICON_NAME.TABLE],
    ["classes", ICON_NAME.BULLET_LIST],
  ])("shows %s as its icon and a caret, as a menu button", (mode, icon) => {
    renderPanel(
      <ValueModeButton
        label="Fill color"
        propertyKey="fill.color"
        mode={mode}
        modes={["fixed", "zoom", "attribute", "raw", "classes"]}
        onSelect={vi.fn()}
      />
    );
    const button = screen.getByRole("button", MODE_BUTTON);
    expect(iconsIn(button)).toEqual([iconPath(icon), iconPath(ICON_NAME.CHEVRON_DOWN)]);
  });

  it("looks the same in every mode at rest, open only while its menu shows", async () => {
    const MODES: Mode[] = ["fixed", "zoom", "attribute", "raw", "classes"];
    const looks = MODES.map((mode) => {
      const { unmount } = renderPanel(
        <ValueModeButton
          label="Fill color"
          propertyKey="fill.color"
          mode={mode}
          modes={MODES}
          onSelect={vi.fn()}
        />
      );
      const button = screen.getByRole("button", MODE_BUTTON);
      const look = {
        active: button.hasAttribute("data-active"),
        field: button.closest(".MuiOutlinedInput-root")?.className,
        icon: button.querySelector("svg")?.getAttribute("class"),
      };
      unmount();
      return look;
    });
    expect(looks.every((look) => !look.active)).toBe(true);
    expect(new Set(looks.map((look) => look.field)).size).toBe(1);
    expect(new Set(looks.map((look) => look.icon)).size).toBe(1);

    renderPanel(
      <ValueModeButton
        label="Fill color"
        propertyKey="fill.color"
        mode="zoom"
        modes={MODES}
        onSelect={vi.fn()}
      />
    );
    const button = screen.getByRole("button", MODE_BUTTON);
    const content = () => getComputedStyle(button).color;
    const resting = content();
    await userEvent.click(button);
    expect(button.hasAttribute("data-active")).toBe(true);
    // Open draws the open field's outline only: the icon and the caret keep their color, as in the other fields.
    expect(content()).toBe(resting);
    await userEvent.keyboard("{Escape}");
    expect(button.hasAttribute("data-active")).toBe(false);
  });

  it("marks the button open while its menu shows, and gives the menu items the same icons", async () => {
    renderPanel(
      <ValueModeButton
        label="Fill color"
        propertyKey="fill.color"
        mode="zoom"
        modes={["fixed", "zoom", "attribute", "raw", "classes"]}
        onSelect={vi.fn()}
      />
    );
    const button = screen.getByRole("button", MODE_BUTTON);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => iconsIn(item)[0])).toEqual(
      [
        ICON_NAME.CIRCLE_DOT,
        ICON_NAME.ZOOM_IN,
        ICON_NAME.TABLE_COLUMNS,
        ICON_NAME.TABLE,
        ICON_NAME.BULLET_LIST,
      ].map(iconPath)
    );
  });

  it("lists the modes with their subs and calls back", async () => {
    const onSelect = vi.fn();
    renderPanel(
      <ValueModeButton
        label="Line width"
        propertyKey="line.width"
        mode="fixed"
        modes={["fixed", "zoom", "attribute", "classes"]}
        onSelect={onSelect}
      />
    );
    const button = screen.getByRole("button", { name: "style_editor.value_mode_aria" });
    await userEvent.click(button);
    expect(screen.getByText("style_editor.mode_zoom_sub_blend")).toBeDefined();
    expect(screen.getByText("style_editor.mode_attribute_sub_number")).toBeDefined();
    expect(screen.getByText("style_editor.mode_classes_sub")).toBeDefined();
    await userEvent.click(screen.getByText("style_editor.mode_zoom"));
    expect(onSelect.mock.calls[0][0]).toBe("zoom");
  });

  it("offers Reset when a class overrides the value", async () => {
    const onReset = vi.fn();
    renderPanel(
      <ValueModeButton
        label="Fill color"
        propertyKey="fill.color"
        mode="fixed"
        modes={["fixed", "zoom"]}
        onSelect={vi.fn()}
        onReset={onReset}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "style_editor.value_mode_aria" }));
    await userEvent.click(within(screen.getByRole("menu")).getByText("style_editor.mode_reset"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
