import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PopupBlock } from "@/lib/validations/layer";

import { renderPanel } from "@/components/map/panels/styleEditor/__tests__/renderPanel";
import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

import { PopupBlockList } from "../PopupBlockList";

/** Adds a block of the kind named `label` from "Add block" and returns the blocks written. */
async function add(fields: FieldInfo[], label: string): Promise<PopupBlock[]> {
  const onChange = vi.fn();
  renderPanel(<PopupBlockList blocks={[]} onChange={onChange} onEdit={vi.fn()} />, { data: { fields } });
  await userEvent.click(screen.getByRole("button", { name: "add_block" }));
  await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: label }));
  return onChange.mock.lastCall?.[0] ?? [];
}

const area: FieldInfo = { name: "area", type: "number", label: "area" };
const name: FieldInfo = { name: "name", type: "string", label: "name" };

describe("PopupBlockList", () => {
  it("a new badge shows the layer's first text field", async () => {
    const [badge] = await add([area, name], "badge_block");
    expect(badge).toEqual(expect.objectContaining({ type: "badge", field: "name" }));
  });

  it("a new badge on a layer without text fields shows its first field", async () => {
    const [badge] = await add([area], "badge_block");
    expect(badge).toEqual(expect.objectContaining({ type: "badge", field: "area" }));
  });

  it("Badge cannot be added to a layer without fields", async () => {
    const onChange = vi.fn();
    renderPanel(<PopupBlockList blocks={[]} onChange={onChange} onEdit={vi.fn()} />, {
      data: { fields: [] },
    });
    await userEvent.click(screen.getByRole("button", { name: "add_block" }));
    const badge = within(screen.getByRole("menu")).getByRole("menuitem", { name: "badge_block" });
    expect(badge.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(badge).catch(() => undefined);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a new image block names no field until one is picked (goatlib checks only a named field)", async () => {
    const [image] = await add([area, name], "image");
    expect(image).toEqual(expect.objectContaining({ type: "image", source: "field" }));
    expect(image).not.toHaveProperty("field");
  });
});
