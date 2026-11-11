// A popover's controls measure against the panel their stack belongs to, not the first panel on the page: the View
// popover's Sky panel opens popovers while the style panel may be open too.
import { describe, expect, it } from "vitest";

import { anchorTopOf, placeIn } from "@/components/map/panels/styleEditor/popovers/usePopover";

const box = (top: number, attrs: Record<string, string> = {}) => {
  const el = document.createElement("div");
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  el.getBoundingClientRect = () => ({ top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
};

describe("anchorTopOf", () => {
  it("measures a control in a placed popover against its own stack's panel", () => {
    box(500, { "data-style-panel": "" }); // the style panel, first on the page
    const view = box(100, { "data-style-panel": "" });
    const placed = box(0, { "data-popover-placed": "" });
    placeIn(placed, view);
    const row = box(300);
    placed.appendChild(row);
    expect(anchorTopOf(row)).toBe(200);
  });
});
